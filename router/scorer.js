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
    const spec = activeTiers[tier];
    return {
      model: spec.model,
      provider: spec.provider,
      stripThinking: spec.stripThinking,
      tier,
      score,
      signals,
      agenticScore: agenticScore > 0 ? agenticScore : undefined,
      agenticProfile: useAgenticTiers || undefined,
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

// ─── Misc utilities ───

function stripUnsafe(s) {
  if (s == null) return "";
  return String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function resolveExplicitModel(modelId, defaultProvider, providers, tiersOrModels) {
  if (typeof modelId !== "string" || !modelId) return null;
  if (modelId.includes("/")) {
    const [provider, ...rest] = modelId.split("/");
    if (providers[provider] && rest.length) {
      return { provider, model: rest.join("/"), stripThinking: false };
    }
    return null;
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
  const t = tiers || resolveTiers(config.models || {}, config.defaultProvider || "openai");
  const { costs } = config;
  const costKey = `${decision.provider}/${decision.model}`;
  const cost = costs[costKey] || { input: 0, output: 0 };
  const heavySpec = t.HEAVY;
  const heavyCostKey = `${heavySpec.provider}/${heavySpec.model}`;
  const heavyInput = (costs[heavyCostKey] || cost).input;

  const promptCost = (estimatedTokens / 1_000_000) * cost.input;
  const baseCost = (estimatedTokens / 1_000_000) * heavyInput;
  const savings = baseCost > 0 ? Math.max(0, (baseCost - promptCost) / baseCost) : 0;
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
  // constants
  AGENTIC_THRESHOLD,
};
