// ─── test/scorer.test.js ───
// Pure-JS tests for router/scorer.js. Uses node's built-in test runner
// (node --test). Run with: `node --test test/scorer.test.js`
//
// We don't use vitest/jest/etc. to keep the project zero-dep. Node's native
// test runner ships with Node 18+ and is sufficient for module-level tests.

"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const scorer = require("../router/scorer.js");
const cfg = require("../config.json");

// ─── Low-level scorers ───

describe("scoreTokenCount", () => {
  test("short prompt (< simple threshold) returns -0.8", () => {
    const r = scorer.scoreTokenCount(50, { simple: 80, complex: 800 });
    assert.equal(r.score, -0.8);
    assert.match(r.signal, /short/);
  });
  test("medium prompt returns 0", () => {
    const r = scorer.scoreTokenCount(400, { simple: 80, complex: 800 });
    assert.equal(r.score, 0);
    assert.equal(r.signal, null);
  });
  test("long prompt (> complex threshold) returns +0.8", () => {
    const r = scorer.scoreTokenCount(1500, { simple: 80, complex: 800 });
    assert.equal(r.score, 0.8);
    assert.match(r.signal, /long/);
  });
});

describe("scoreKeywords", () => {
  test("low threshold (1+ matches) but not high (3) returns scoreLow", () => {
    const r = scorer.scoreKeywords("function and class", ["function", "class", "import"], 1, 3, 0.5, 1.0);
    assert.equal(r.score, 0.5);
  });
  test("high threshold (3+ matches) returns scoreHigh", () => {
    const r = scorer.scoreKeywords("function class import", ["function", "class", "import"], 1, 3, 0.5, 1.0);
    assert.equal(r.score, 1.0);
  });
  test("no matches returns 0", () => {
    const r = scorer.scoreKeywords("hello thanks", ["function", "class"], 1, 3, 0.5, 1.0);
    assert.equal(r.score, 0);
    assert.equal(r.signal, null);
  });
});

describe("scorePatterns", () => {
  test("accepts RegExp array", () => {
    const r = scorer.scorePatterns("step 1: do this", [/step \d/i]);
    assert.equal(r.score, 0.5);
  });
  test("accepts string array (raw config.json format)", () => {
    const r = scorer.scorePatterns("step 1: do this", ["step 1", "step 2"]);
    assert.equal(r.score, 0.5);
  });
  test("no pattern hits returns 0", () => {
    const r = scorer.scorePatterns("just a normal prompt", ["step 1", "first then"]);
    assert.equal(r.score, 0);
  });
});

describe("scoreQuestions", () => {
  test("0-3 question marks returns 0", () => {
    assert.equal(scorer.scoreQuestions("one? two? three?").score, 0);
  });
  test("4+ question marks returns 0.5", () => {
    assert.equal(scorer.scoreQuestions("a? b? c? d?").score, 0.5);
  });
});

// ─── extractText ───

describe("extractText", () => {
  test("skips system messages (only scores user content)", () => {
    const body = {
      messages: [
        { role: "system", content: "you are a coding assistant with import function class" },
        { role: "user", content: "hello thanks" },
      ],
    };
    assert.equal(scorer.extractText(body), "hello thanks ");
  });
  test("handles string content", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    assert.equal(scorer.extractText(body), "hi ");
  });
  test("handles content-parts array (OpenAI multimodal format)", () => {
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "world" }] }],
    };
    assert.equal(scorer.extractText(body), "world ");
  });
  test("only takes last 3 messages", () => {
    const body = {
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
        { role: "user", content: "third" },
        { role: "user", content: "fourth" },
        { role: "user", content: "fifth" },
      ],
    };
    const text = scorer.extractText(body);
    assert.ok(!text.includes("first"), "oldest message should be excluded");
    assert.ok(!text.includes("second"), "second-oldest should be excluded");
    assert.ok(text.includes("third"), "third-oldest should be included");
    assert.ok(text.includes("fourth"));
    assert.ok(text.includes("fifth"));
  });
  test("returns empty string for missing messages", () => {
    assert.equal(scorer.extractText({}), "");
    assert.equal(scorer.extractText({ messages: "not an array" }), "");
  });
});

// ─── classify (the main scorer) ───

describe("classify", () => {
  test("simple 'hello thanks' routes to LIGHT", () => {
    const d = scorer.classify("hello thanks", 1, cfg.scoring, cfg.models, cfg.defaultProvider);
    assert.equal(d.tier, "LIGHT");
    assert.equal(d.provider, "ollama");
  });
  test("reasoning-heavy prompt overrides to HEAVY", () => {
    const d = scorer.classify("prove the theorem using mathematical step by step reasoning", 50, cfg.scoring, cfg.models, cfg.defaultProvider);
    assert.equal(d.tier, "HEAVY");
    assert.equal(d.provider, "openai");
    assert.equal(d.reasoning, "reasoning-override");
  });
  test("medium-complexity prompt routes to MEDIUM", () => {
    const d = scorer.classify("write a function to compute fibonacci", 50, cfg.scoring, cfg.models, cfg.defaultProvider);
    assert.equal(d.tier, "MEDIUM");
    assert.equal(d.provider, "ollama");
  });
  test("decision includes score, signals, and confidence", () => {
    const d = scorer.classify("hello", 1, cfg.scoring, cfg.models, cfg.defaultProvider);
    assert.equal(typeof d.score, "number");
    assert.ok(Array.isArray(d.signals));
    assert.equal(typeof d.confidence, "number");
    assert.ok(d.confidence > 0 && d.confidence < 1);
  });
  test("accepts resolved tier map (skips resolution)", () => {
    const resolved = {
      LIGHT: { provider: "ollama", model: "llama3.1:8b", stripThinking: true },
      MEDIUM: { provider: "ollama", model: "qwen2.5-coder:32b", stripThinking: false },
      HEAVY: { provider: "openai", model: "gpt-5.1", stripThinking: false },
    };
    const d = scorer.classify("hello thanks", 1, cfg.scoring, resolved);
    assert.equal(d.tier, "LIGHT");
  });
  test("agenticScore not reported when agenticKeywords don't match", () => {
    const d = scorer.classify("hello thanks", 1, cfg.scoring, cfg.models, cfg.defaultProvider);
    assert.equal(d.agenticScore, undefined);
    assert.equal(d.agenticProfile, undefined);
  });
  test("agenticScore reported when agenticKeywords match", () => {
    const d = scorer.classify("audit the codebase, modify the file, and deploy the fix", 50, cfg.scoring, cfg.models, cfg.defaultProvider);
    assert.ok(d.agenticScore >= 0.5, `agenticScore=${d.agenticScore} should be >= 0.5`);
  });
});

// ─── resolveExplicitModel ───

describe("resolveExplicitModel", () => {
  test("provider-prefixed id resolves to that provider", () => {
    const r = scorer.resolveExplicitModel("openai/gpt-5.1", cfg.defaultProvider, cfg.providers, cfg.models);
    assert.deepEqual(r, { provider: "openai", model: "gpt-5.1", stripThinking: false });
  });
  test("bare id matches a tier entry under default provider", () => {
    const r = scorer.resolveExplicitModel("llama3.1:8b", cfg.defaultProvider, cfg.providers, cfg.models);
    assert.deepEqual(r, { provider: "ollama", model: "llama3.1:8b", stripThinking: true });
  });
  test("bare id that doesn't match anything returns null", () => {
    const r = scorer.resolveExplicitModel("not-a-known-model", cfg.defaultProvider, cfg.providers, cfg.models);
    assert.equal(r, null);
  });
  test("null/empty input returns null", () => {
    assert.equal(scorer.resolveExplicitModel(null, cfg.defaultProvider, cfg.providers, cfg.models), null);
    assert.equal(scorer.resolveExplicitModel("", cfg.defaultProvider, cfg.providers, cfg.models), null);
  });
  test("unknown provider prefix returns null", () => {
    const r = scorer.resolveExplicitModel("nosuchprovider/whatever", cfg.defaultProvider, cfg.providers, cfg.models);
    assert.equal(r, null);
  });
});

// ─── costMath ───

describe("costMath", () => {
  test("non-zero cost calculation for OpenAI HEAVY", () => {
    const m = scorer.costMath({ provider: "openai", model: "gpt-5.1" }, 1_000_000, cfg);
    assert.equal(Math.round(m.promptCost * 100) / 100, 1.25);
    assert.equal(Math.round(m.baseCost * 100) / 100, 1.25);
    assert.equal(m.savings, 0); // same as baseline
  });
  test("local Ollama = free, savings = 100%", () => {
    const m = scorer.costMath({ provider: "ollama", model: "llama3.1:8b" }, 1_000_000, cfg);
    assert.equal(m.promptCost, 0);
    assert.equal(m.savings, 1);
  });
  test("partial savings: cheaper upstream vs HEAVY baseline", () => {
    const m = scorer.costMath({ provider: "openai", model: "gpt-5.1-mini" }, 1_000_000, cfg);
    assert.equal(Math.round(m.promptCost * 100) / 100, 0.25);
    assert.equal(Math.round(m.baseCost * 100) / 100, 1.25);
    assert.equal(Math.round(m.savings * 100) / 100, 0.8);
  });
  test("unknown model: cost = 0, savings = 1 (by-design free)", () => {
    const m = scorer.costMath({ provider: "openai", model: "gpt-9.9-future" }, 1_000_000, cfg);
    assert.equal(m.promptCost, 0);
    assert.equal(m.savings, 1);
  });
});

// ─── stripUnsafe ───

describe("stripUnsafe", () => {
  test("removes ANSI escape (0x1b)", () => {
    assert.equal(scorer.stripUnsafe("hello \x1b[31mRED\x1b[0m world"), "hello [31mRED[0m world");
  });
  test("removes null byte", () => {
    assert.equal(scorer.stripUnsafe("hello\x00world"), "helloworld");
  });
  test("preserves printable text", () => {
    assert.equal(scorer.stripUnsafe("hello world 123 !@#"), "hello world 123 !@#");
  });
  test("non-string input coerces safely", () => {
    assert.equal(scorer.stripUnsafe(null), "");
    assert.equal(scorer.stripUnsafe(123), "123");
  });
});

// ─── resolveTiers ───

describe("resolveTiers", () => {
  test("resolves raw models block", () => {
    const t = scorer.resolveTiers(cfg.models, cfg.defaultProvider);
    assert.equal(t.LIGHT.provider, "ollama");
    assert.equal(t.LIGHT.model, "llama3.1:8b");
    assert.equal(t.LIGHT.stripThinking, true);
    assert.equal(t.HEAVY.provider, "openai");
    assert.equal(t.HEAVY.stripThinking, false);
  });
  test("handles bare string model ids (uses default provider)", () => {
    const t = scorer.resolveTiers({ LIGHT: "tiny", MEDIUM: "small", HEAVY: "big" }, "openai");
    assert.equal(t.LIGHT.provider, "openai");
    assert.equal(t.LIGHT.model, "tiny");
  });
});
