// test/install.test.js
// Tests for scripts/install.sh invariants that aren't easily tested via
// node-only unit tests.
//
// We invoke bash to extract the JSON template from the script and assert
// structural properties of the registered provider entry.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const REPO_ROOT = path.resolve(__dirname, "..");
const INSTALL_SH = path.join(REPO_ROOT, "scripts", "install.sh");

// Extract the JSON heredoc body from install.sh — the block delimited by
// <<'JSON' and a standalone `JSON` line. Uses regex in JS to avoid spawning
// a shell (no user input flows in either way, but JS is faster and clearer).
function extractProviderTemplate() {
  const src = fs.readFileSync(INSTALL_SH, "utf8");
  // The heredoc body sits between `<<'JSON'` and a `JSON` line at column 0.
  // Capture lazily so we don't depend on exact whitespace.
  const m = src.match(/<<'JSON'\n([\s\S]*?)\nJSON\n/);
  if (!m) {
    throw new Error(
      "Could not locate JSON heredoc in install.sh. Expected a block " +
        "delimited by `<<'JSON'` and a standalone `JSON` line."
    );
  }
  // Substitute the __PORT__ placeholder with the actual port used by the
  // router default so the assertion matches runtime reality.
  return m[1].replace(/__PORT__/g, "8402").trim();
}

test("install.sh: bash syntax is valid", () => {
  // bash -n parses the script but doesn't run it. Catches unmatched braces,
  // unclosed quotes, dangling heredocs, etc. execFileSync avoids shell
  // interpolation since the script path is a hard-coded constant.
  execFileSync("bash", ["-n", INSTALL_SH], { stdio: "ignore" });
});

test("install.sh: provider template is valid JSON", () => {
  const tpl = extractProviderTemplate();
  // Should parse without throwing.
  const parsed = JSON.parse(tpl);
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
});

test("install.sh: provider template declares api=openai-completions", () => {
  const tpl = extractProviderTemplate();
  const parsed = JSON.parse(tpl);
  assert.equal(parsed.api, "openai-completions");
});

test("install.sh: baseUrl ends with /v1 (OpenClaw SDK appends /chat/completions)", () => {
  // REGRESSION TEST for the live bug from 2026-07-25:
  //   - install.sh registered baseUrl: "http://127.0.0.1:8402" (no /v1)
  //   - OpenClaw gateway uses the official OpenAI SDK which appends
  //     "/chat/completions" to baseUrl literally — does NOT prepend /v1
  //   - Gateway POSTed to http://127.0.0.1:8402/chat/completions
  //   - Our router only accepts /v1/chat/completions → returned 404
  //   - Gateway raised "model not found by the provider" failovers
  // Fix: register baseUrl with /v1 suffix so the SDK's appended path lands
  // on /v1/chat/completions.
  const tpl = extractProviderTemplate();
  const parsed = JSON.parse(tpl);
  const baseUrl = parsed.baseUrl;
  assert.equal(typeof baseUrl, "string", "baseUrl must be a string");
  assert.match(
    baseUrl,
    /\/v1$/,
    `baseUrl must end with /v1 (got: ${baseUrl}). The OpenClaw gateway's ` +
      `official OpenAI SDK appends "/chat/completions" verbatim and does NOT ` +
      `auto-prepend /v1. Without /v1 here, every gateway request 404s.`
  );
});

test("install.sh: provider template includes the auto model with reasonable defaults", () => {
  const tpl = extractProviderTemplate();
  const parsed = JSON.parse(tpl);
  assert.ok(Array.isArray(parsed.models), "models must be an array");
  assert.ok(parsed.models.length >= 1, "at least one model must be defined");
  const auto = parsed.models.find((m) => m.id === "auto");
  assert.ok(auto, `models must include one with id="auto" (got: ${JSON.stringify(parsed.models.map(m => m.id))})`);
  assert.ok(auto.contextWindow >= 1024, "contextWindow must be sane");
  assert.ok(auto.maxTokens >= 256, "maxTokens must be sane");
  assert.deepEqual(auto.cost, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }, "router is local — all costs must be 0");
});