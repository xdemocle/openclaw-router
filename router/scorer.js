// ─── router/scorer.js ───
// Pure scoring + utility module. No Node-only deps — works in browser-style
// tests under vitest. The server.js runtime requires this and stays as the
// thin HTTP wrapper.

"use strict";

// ─── Low-level dimension scorers ───

function scoreTokenCount(tokens, thresholds) {
  if (tokens < thresholds.simple) return { score: -0.8, signal: `short(${tokens}t)` };
  if (tokens > thresholds.complex) return { score: 0.8, signal: `long(${tokens}t)` };
  return { score: 0, signal: null };
}

function scoreKeywords(text, keywords, threshLow, threshHigh, scoreLow, scoreHigh) {
  const matches = keywords.filter(kw => text.includes(kw.toLowerCase()));
  if (matches.length >= threshHigh) return { score: scoreHigh, signal: matches.slice(0, 3).join(",") };
  if (matches.length >= threshLow) return { score: scoreLow, signal: matches.slice(0, 2).join(",") };
  return { score: 0, signal: null };
}

function scorePatterns(text, patterns) {
  // Patterns may be RegExp or strings (when called from server.js after
  // loadConfig compiled them; or when called from tests with raw config.json).
  const hits = patterns.filter(p => {
    if (p instanceof RegExp) return p.test(text);
    if (typeof p === "string") return new RegExp(p, "i").test(text);
    return false;
  });
  if (hits.length > 0) return { score: 0.5, signal: "multi-step" };
  return { score: 0, signal: null };
}

function scoreQuestions(text) {
  const count = (text.match(/\?/g) || []).length;
  if (count > 3) return { score: 0.5, signal: `${count}q` };
  return { score: 0, signal: null };
}

// ─── Main Classifier ───
//
// `scoreConfig` is the `scoring` block of config.json.
// `tiersOrModels` is either the resolved {LIGHT, MEDIUM, HEAVY} map (with
// `provider` + `model` fields) OR the raw `models` block from config.json
// (we resolve it here for testability — server.js's loadConfig does the
// same resolution upstream and passes the resolved map).
//
// The 15th dimension is agenticScore, derived from agenticKeywords. It does
// NOT contribute to the score directly — instead, when it exceeds a threshold,
// we report `agenticProfile: true` so the caller can opt into an agentic tiers
// override (mirrors ClawRouter's pattern with their "agentic" profile).
//
// If `tiers.agentic` is supplied (an optional alternative tier map), the
// classifier uses it when agenticScore >= AGENTIC_THRESHOLD. Otherwise the
// regular tiers are used.

const AGENTIC_THRESHOLD = 0.5;

// Resolve the `models` block (LIGHT/MEDIUM/HEAVY as either strings or
// {provider, model, stripThinking?}) into a normalized tier map. The default
// provider for bare model ids is configurable.
function resolveTiers(models, defaultProvider) {
  const out = {};
  for (const tier of ["LIGHT", "MEDIUM", "HEAVY"]) {
    const v = models[tier];
    if (v == null) {
      out[tier] = null;
      continue;
    }
    const spec = typeof v === "string"
      ? { provider: defaultProvider, model: v, stripThinking: tier === "LIGHT" }
      : { provider: v.provider || defaultProvider, model: v.model, stripThinking: v.stripThinking ?? tier === "LIGHT" };
    out[tier] = spec;
  }
  return out;
}

function classify(text, estimatedTokens, scoreConfig, tiersOrModels, defaultProvider) {
  // If the caller passed a raw `models` block (e.g. directly from config.json),
  // resolve it. If they passed an already-resolved tier map, accept it.
  const tiers = (tiersOrModels && tiersOrModels.LIGHT && tiersOrModels.LIGHT.provider)
    ? tiersOrModels
    : resolveTiers(tiersOrModels, defaultProvider || "openai");

  const s = scoreConfig;
  const lower = text.toLowerCase();

  const dims = {
    tokenCount:       scoreTokenCount(estimatedTokens, s.tokenThresholds),
    codePresence:     scoreKeywords(lower, s.codeKeywords, 1, 3, 0.5, 1.0),
    reasoningMarkers: scoreKeywords(lower, s.reasoningKeywords, 1, 2, 0.6, 1.0),
    technicalTerms:   scoreKeywords(lower, s.technicalKeywords, 2, 4, 0.5, 1.0),
    creativeMarkers:  scoreKeywords(lower, s.creativeKeywords, 1, 2, 0.4, 0.7),
    simpleIndicators: scoreKeywords(lower, s.simpleKeywords, 1, 2, -0.8, -1.0),
    multiStep:        scorePatterns(lower, s.multiStepPatterns),
    questionCount:    scoreQuestions(text),
    imperativeVerbs:  scoreKeywords(lower, s.imperativeVerbs, 1, 2, 0.3, 0.5),
    constraints:      scoreKeywords(lower, s.constraintKeywords, 1, 3, 0.3, 0.7),
    outputFormat:     scoreKeywords(lower, s.formatKeywords, 1, 2, 0.4, 0.7),
    domainSpecific:   scoreKeywords(lower, s.domainKeywords, 1, 2, 0.5, 0.8),
    agenticTask:      scoreKeywords(lower, s.agenticKeywords, 2, 4, 0.4, 0.8),
    relayIndicators:  scoreKeywords(lower, s.relayKeywords, 1, 2, -0.9, -1.0),
  };

  // Compute agenticScore (0-1) from agenticKeywords alone. Used to gate
  // optional agentic tiers (B3). Does NOT modify the score directly.
  const agenticHits = s.agenticKeywords.filter(kw => lower.includes(kw.toLowerCase())).length;
  // Normalize: 4+ matches = 1.0, 3 = 0.6, 1-2 = 0.2, 0 = 0.
  const agenticScore = agenticHits >= 4 ? 1.0
                    : agenticHits === 3 ? 0.6
                    : agenticHits >= 1 ? 0.2
                    : 0;

  let score = 0;
  const signals = [];
  for (const [name, dim] of Object.entries(dims)) {
    const w = s.weights[name] || 0;
    score += dim.score * w;
    if (dim.signal) signals.push(`${name}:${dim.signal}`);
  }

  const overrides = s.overrides || {};

  // Pick which tier set to use. Default to regular tiers; switch to agentic
  // tiers if the operator declared them and the agenticScore gates them.
  const useAgenticTiers = agenticScore >= AGENTIC_THRESHOLD && tiers.agentic != null;
  const activeTiers = useAgenticTiers ? tiers.agentic : tiers;

  const decide = (tier, extra) => {
    let spec = activeTiers[tier];
    // HEAVY inheritance: when a tier is configured with the "__primary__"
    // sentinel, resolve it to config.primaryModel at request time. If no
    // primaryModel is configured, fall back to the tier's own
    // fallbackProvider/Model. If neither exists, mark as "__unresolved__"
    // and let the caller surface an error.
    let resolvedFallback = null;
    if (spec.provider === "__primary__" || spec.model === "__primary__") {
      if (tiers.primaryModel && tiers.primaryModel.provider && tiers.primaryModel.model) {
        spec = { ...spec, provider: tiers.primaryModel.provider, model: tiers.primaryModel.model };
      } else if (spec.fallbackProvider && spec.fallbackModel) {
        resolvedFallback = { provider: spec.fallbackProvider, model: spec.fallbackModel };
        spec = { ...spec, provider: spec.fallbackProvider, model: spec.fallbackModel };
      } else {
        spec = { ...spec, provider: "__unresolved__", model: "__unresolved__" };
      }
    }
    return {
      model: spec.model,
      provider: spec.provider,
      stripThinking: spec.stripThinking,
      tier,
      score,
      signals,
      agenticScore: agenticScore > 0 ? agenticScore : undefined,
      agenticProfile: useAgenticTiers || undefined,
      fallbackSpec: resolvedFallback,
      ...extra,
    };
  };

  const reasoningMin = overrides.reasoningKeywordMin || 2;
  const reasoningHits = s.reasoningKeywords.filter(kw => lower.includes(kw.toLowerCase()));
  if (reasoningHits.length >= reasoningMin) {
    return decide("HEAVY", { confidence: 0.95, reasoning: "reasoning-override" });
  }

  const largeCtx = overrides.largeContextTokens || 50000;
  if (estimatedTokens > largeCtx) {
    return decide("HEAVY", { confidence: 0.95, reasoning: "large-context" });
  }

  const { lightMedium, mediumHeavy } = s.boundaries;
  let tier, distFromBoundary;

  if (score < lightMedium) {
    tier = "LIGHT";
    distFromBoundary = lightMedium - score;
  } else if (score < mediumHeavy) {
    tier = "MEDIUM";
    distFromBoundary = Math.min(score - lightMedium, mediumHeavy - score);
  } else {
    tier = "HEAVY";
    distFromBoundary = score - mediumHeavy;
  }

  const confidence = 1 / (1 + Math.exp(-s.confidenceSteepness * distFromBoundary));

  if (confidence < s.confidenceThreshold) {
    return decide("MEDIUM", { confidence, reasoning: "ambiguous→medium" });
  }

  return decide(tier, { confidence, reasoning: "scored" });
}

// ─── Extract scoring text from OpenAI Chat Completions messages format ───

function extractText(body) {
  let text = "";
  if (Array.isArray(body.messages)) {
    const recent = body.messages.slice(-3);
    for (const msg of recent) {
      if (msg.role && msg.role !== "user") continue;
      const c = msg.content;
      if (typeof c === "string") {
        text += c + " ";
      } else if (Array.isArray(c)) {
        for (const part of c) {
          if (part.type === "text" && typeof part.text === "string") {
            text += part.text + " ";
          }
        }
      }
    }
  }
  return text;
}

// ─── LIGHT context-window guard ───

// Estimate the total tokens in an OpenAI Chat Completions body (system +
// user + assistant + tool messages). Returns object { total, system,
// perMessage }. 1 token ~= 4 chars for English (under-estimate is fine for
// safety; we round up).
function estimateContextTokens(body) {
  if (!body || !Array.isArray(body.messages)) return { total: 0, system: 0, perMessage: [] };
  let total = 0, system = 0;
  const perMessage = [];
  for (const m of body.messages) {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
    const toolCalls = Array.isArray(m.tool_calls)
      ? JSON.stringify(m.tool_calls).length : 0;
    const tok = Math.ceil((content.length + toolCalls) / 4);
    total += tok;
    if (m.role === "system") system += tok;
    perMessage.push({ role: m.role, tokens: tok });
  }
  return { total, system, perMessage };
}

// Returns { allowed: boolean, reason, tokens, limit, model }.
// `allowed=false` means LIGHT must REFUSE — we do NOT auto-escalate to
// MEDIUM/HEAVY because the whole point of LIGHT is small isolated tasks.
// If callers want a larger model, they should pick MEDIUM/HEAVY via the
// explicit-model path.
function checkLightContextWindow(body, tierSpec) {
  const limit = tierSpec.effectiveContext || tierSpec.advertisedContext || 0;
  const advertised = tierSpec.advertisedContext;
  const { total, system } = estimateContextTokens(body);
  if (limit > 0 && total > limit) {
    let reason;
    if (advertised && total > advertised) {
      reason = `prompt exceeds model's hard context window (${total} > ${advertised} tokens)`;
    } else if (system > limit * 0.8) {
      reason = `system prompt alone (${system} tokens) is most of the LIGHT tier's effective budget (${limit} tokens). Pick MEDIUM or HEAVY via explicit model id, or shorten the system prompt.`;
    } else {
      reason = `prompt (${total} tokens) exceeds LIGHT tier's effective context budget (${limit} tokens). LIGHT is for small isolated tasks only — pick MEDIUM or HEAVY.`;
    }
    return { allowed: false, reason, tokens: total, system, limit, advertised, model: tierSpec.model };
  }
  return { allowed: true, tokens: total, system, limit, advertised, model: tierSpec.model };
}

// ─── Misc utilities ───

function stripUnsafe(s) {
  if (s == null) return "";
  return String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function resolveExplicitModel(modelId, defaultProvider, providers, tiersOrModels) {
  if (typeof modelId !== "string" || !modelId) return null;

  // provider/model form: ONLY treat as provider-prefixed if the part BEFORE
  // the first slash is a known provider in the providers map. This avoids
  // misinterpreting namespace-prefixed ollama models like
  // 'qcwind/qwen3-8b-instruct-Q4-K-M:latest' (where 'qcwind' is a
  // namespace, not a provider) as a provider id.
  if (modelId.includes("/")) {
    const slashIdx = modelId.indexOf("/");
    const provider = modelId.slice(0, slashIdx);
    const rest = modelId.slice(slashIdx + 1);
    if (providers[provider] && rest) {
      return { provider, model: rest, stripThinking: false };
    }
    // Otherwise fall through to the bare-id lookup (probably matches a tier
    // entry under defaultProvider).
  }

  // Always normalize via resolveTiers so spec.stripThinking is populated
  // (defaults to true for LIGHT, false for MEDIUM/HEAVY).
  const tiers = resolveTiers(tiersOrModels || {}, defaultProvider);
  for (const t of ["LIGHT", "MEDIUM", "HEAVY"]) {
    const spec = tiers[t];
    if (spec && spec.provider === defaultProvider && spec.model === modelId) {
      return { provider: spec.provider, model: spec.model, stripThinking: spec.stripThinking };
    }
  }
  return null;
}

function providerKey(provider, env) {
  env = env || process.env;
  if (provider.apiKeyEnv && env[provider.apiKeyEnv]) {
    return env[provider.apiKeyEnv];
  }
  return provider.apiKey || null;
}

// Cost math: provider-prefixed key lookup. Returns { cost, baselineCost, savings }
// where cost is the actual spent amount in USD, baselineCost is what HEAVY
// would have cost, and savings is the fractional reduction (0..1).
// `decision` is the routing decision (has provider + model). `config` is the
// full config object (loads `tiers` and `costs` from it). `tiers` is optional
// — if not provided, we resolve it from `config.models`.
function costMath(decision, estimatedTokens, config, tiers) {
  // If the caller didn't pre-attach primaryModel, walk back through config.
  let t = tiers;
  if (!t || !t.primaryModel) {
    t = t ? { ...t, primaryModel: config.primaryModel || null }
         : { ...resolveTiers(config.models || {}, config.defaultProvider || "openai"),
             primaryModel: config.primaryModel || null };
  }
  const { costs } = config;
  const costKey = `${decision.provider}/${decision.model}`;
  const cost = costs[costKey] || { input: 0, output: 0 };

  // Resolve the HEAVY tier for baseline cost. If HEAVY is the "__primary__"
  // sentinel, walk through primaryModel, then fallbackProvider/Model.
  let heavySpec = t.HEAVY;
  if (heavySpec.provider === "__primary__" || heavySpec.model === "__primary__") {
    if (t.primaryModel && t.primaryModel.provider && t.primaryModel.model) {
      heavySpec = { ...heavySpec, provider: t.primaryModel.provider, model: t.primaryModel.model };
    } else if (heavySpec.fallbackProvider && heavySpec.fallbackModel) {
      heavySpec = { ...heavySpec, provider: heavySpec.fallbackProvider, model: heavySpec.fallbackModel };
    } else {
      // No primary and no fallback — baseline is effectively "free" (which is
      // wrong, but it means we can't compute a savings number). Surface as 0
      // savings rather than crashing; caller decides how to log.
      heavySpec = { provider: "__unresolved__", model: "__unresolved__" };
    }
  }
  const heavyCostKey = `${heavySpec.provider}/${heavySpec.model}`;
  const heavyInput = (costs[heavyCostKey] || cost).input;

  const promptCost = (estimatedTokens / 1_000_000) * cost.input;
  const baseCost = (estimatedTokens / 1_000_000) * heavyInput;
  // savings: 0 = no savings (same cost as baseline), 1 = 100% savings (free),
  // 0.5 = half the cost. Negative is clamped to 0 (can't be cheaper than free).
  const savings = baseCost > 0
    ? Math.max(0, (baseCost - promptCost) / baseCost)
    : (promptCost === 0 ? 0 : 1);
  return { promptCost, baseCost, savings };
}

module.exports = {
  // scorers
  scoreTokenCount, scoreKeywords, scorePatterns, scoreQuestions,
  classify, resolveTiers,
  // extraction
  extractText,
  // utilities
  stripUnsafe, resolveExplicitModel, providerKey, costMath,
  // LIGHT context-window guard
  estimateContextTokens, checkLightContextWindow,
  // constants
  AGENTIC_THRESHOLD,
};
