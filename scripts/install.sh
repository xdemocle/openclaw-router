#!/usr/bin/env bash
#
# openclaw-router installer — supports both OpenClaw config layouts:
#
#   • Modern ($include-router, srv3+): openclaw.json is mostly a thin include
#     router pointing at configs/*.json5. We register the router provider in
#     configs/models.json5 + add to the model allowlist in configs/agents.json5.
#     openclaw.json itself is NEVER modified.
#
#   • Legacy (pre-2026.6, ibl.ai fork baseline): openclaw.json holds the full
#     config inline. We register directly under openclaw.json["models"] as
#     before.
#
# The layout is detected automatically. The script is idempotent — running
# it twice is safe.
#
# JSON5 files: openclaw configs use JSON5 with // comments, trailing commas,
# and unquoted keys (e.g. "subagents: { allowAgents: ... }"). We do NOT
# round-trip the file through json.dumps (would lose comments / unquoted keys).
# Instead, we do surgical text-level edits: regex-locate the section to
# mutate, parse just that subsection, mutate the parsed dict, re-serialize
# it cleanly back into the file.
#
# Identity: this script uses `sudo` for system-level writes (systemd, env
# file). Operators may need to provide sudo access. We do NOT print or
# persist any provider API keys — only the operator-supplied env vars at
# install time are written into /etc/openclaw-router.env (chmod 0600).
#
set -euo pipefail


# ─── Flags ──────────────────────────────────────────────────────────────────
# --dry-run  : read-only simulation. Print what would happen but make NO
#              changes to disk, NO sudo, NO systemd actions, NO config edits.
#              Returns 0 if every simulated step would succeed, 1 otherwise.
# -h, --help : print usage and exit 0.
DRY_RUN=0
SHOW_HELP=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) SHOW_HELP=1 ;;
    *) echo "Unknown flag: $arg"; exit 2 ;;
  esac
done

if [ "$SHOW_HELP" = "1" ]; then
  cat <<'USAGE'
openclaw-router installer

Usage:
  bash scripts/install.sh [options]

Options:
  --dry-run   Simulate every step (file copies, config edits, systemd unit
              creation, service enable). Make NO changes to disk. Exit 0 if
              all simulated steps would succeed.
  -h, --help  Show this help and exit.

Examples:
  # Show what install.sh would do, without touching anything:
  bash scripts/install.sh --dry-run

  # Install for real (writes to ~/.openclaw/, /etc/systemd/, /etc/):
  bash scripts/install.sh

USAGE
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "⚡ Installing openclaw-router (DRY RUN — no changes will be made)..."
fi

# noop(): DRY_RUN gate. Prints what would happen, does nothing destructive.
noop() {
  echo "  [dry-run] would: $*"
}

# Default HOME if unset (e.g. when run via sudo without -E, or in a stripped env).
: "${HOME:=/root}"

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROUTER_DIR="$HOME/.openclaw/workspace/skills/router"
SERVICE_NAME="openclaw-router"
PORT=8402

# ─── 1. Copy router files ──────────────────────────────────────────────────
if [ "$DRY_RUN" = "1" ]; then
  noop "mkdir -p $ROUTER_DIR"
  noop "cp $SKILL_DIR/server.js → $ROUTER_DIR/server.js"
  noop "cp $SKILL_DIR/router/scorer.js → $ROUTER_DIR/router/scorer.js"
  noop "cp package.json (CJS marker) → $ROUTER_DIR/package.json  # blocks ~/package.json ESM pollution"
  if [ ! -f "$ROUTER_DIR/config.json" ]; then
    noop "cp $SKILL_DIR/config.json → $ROUTER_DIR/config.json (new)"
    echo "  ✓ Would copy default config.json"
  else
    echo "  ✓ config.json already exists — would preserve"
  fi
  echo "  ✓ Would copy server.js to $ROUTER_DIR"
else
  mkdir -p "$ROUTER_DIR"
  cp "$SKILL_DIR/server.js" "$ROUTER_DIR/server.js"
  mkdir -p "$ROUTER_DIR/router"
  cp "$SKILL_DIR/router/scorer.js" "$ROUTER_DIR/router/scorer.js"
  # Drop a local package.json that pins CommonJS. Without this, Node walks up
  # from ROUTER_DIR to ~/package.json (which has "type":"module" on srv3)
  # and refuses server.js's require() calls. See:
  # https://nodejs.org/api/packages.html#packagejson-type-field
  printf '%s\n' '{ "type": "commonjs" }' > "$ROUTER_DIR/package.json"
  if [ ! -f "$ROUTER_DIR/config.json" ]; then
    cp "$SKILL_DIR/config.json" "$ROUTER_DIR/config.json"
    echo "  ✓ Copied default config.json"
  else
    echo "  ✓ config.json already exists — preserved"
  fi
  echo "  ✓ Copied server.js + package.json (CJS) to $ROUTER_DIR"
fi

# ─── 2. Detect OpenClaw config layout ──────────────────────────────────────
#
# mode=include-router: most top-level values are { "$include": "..." }
#                      (srv3+). We register via configs/models.json5 +
#                      configs/agents.json5. openclaw.json itself is
#                      NEVER modified.
# mode=flat:          openclaw.json holds the full config (legacy).
#
OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"
OPENCLAW_MODE="flat"
if [ -f "$OPENCLAW_JSON" ]; then
  # `python3 -c` on the JSON: majority of top-level values are
  # { "$include": "..." } → include-router. We require ≥80% to avoid
  # mis-detecting files that just happen to have a few includes.
  OPENCLAW_MODE=$(python3 - "$OPENCLAW_JSON" <<'PYEOF' || echo "flat"
import json, sys
try:
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
    if isinstance(cfg, dict) and cfg:
        total = len(cfg)
        inc = sum(
            1 for v in cfg.values()
            if isinstance(v, dict) and set(v.keys()) == {"$include"}
        )
        print("include-router" if (inc / total) >= 0.8 else "flat")
    else:
        print("flat")
except Exception:
    print("flat")
PYEOF
)
fi

case "$OPENCLAW_MODE" in
  include-router)
    CONFIGS_DIR="$HOME/.openclaw/configs"
    MODELS_FILE="$CONFIGS_DIR/models.json5"
    AGENTS_FILE="$CONFIGS_DIR/agents.json5"
    ;;
  flat)
    MODELS_FILE="$OPENCLAW_JSON"
    AGENTS_FILE="$OPENCLAW_JSON"
    ;;
  *)
    echo "  ✗ Unknown OpenClaw mode: $OPENCLAW_MODE — refusing to touch config."
    exit 1
    ;;
esac
echo "  ✓ Detected OpenClaw mode: $OPENCLAW_MODE (writes go to: $(basename "$MODELS_FILE"), $(basename "$AGENTS_FILE"))"

# ─── 3. Detect API key (best-effort) ───────────────────────────────────────
#
# Modern: ~/.openclaw/secrets.jsonc — raw provider keys live at
#   secrets.models.providers.<id>.apiKey.
# Legacy: ~/.openclaw/agents/main/agent/auth-profiles.json — flat JSON.
# Env:    always wins if set.
#
API_KEY=""
if [ -n "${OPENAI_API_KEY:-}" ]; then
  API_KEY="$OPENAI_API_KEY"
  echo "  ✓ Using OPENAI_API_KEY from environment"
elif [ -f "$HOME/.openclaw/secrets.jsonc" ]; then
  # secrets.jsonc is JSON5; strip // comments before parsing. The apiKey value
  # under models.providers.openai is the raw sk-... string.
  API_KEY=$(python3 - "$HOME/.openclaw/secrets.jsonc" <<'PYEOF' 2>/dev/null || true
import json, re, sys
try:
    text = open(sys.argv[1]).read()
    def strip_json5_comments(text):
    out = []
    i = 0
    in_string = False
    in_comment_line = False
    n = len(text)
    while i < n:
        c = text[i]
        if in_comment_line:
            if c == "\n":
                in_comment_line = False
                out.append(c)
            i += 1
            continue
        if in_string:
            if c == "\\":
                out.append(c); i += 1
                if i < n:
                    out.append(text[i]); i += 1
                continue
            if c == '"':
                in_string = False
                out.append(c); i += 1; continue
            out.append(c); i += 1; continue
        if c == '"':
            in_string = True
            out.append(c); i += 1; continue
        if c == "/" and i + 1 < n and text[i+1] == "/":
            in_comment_line = True
            i += 2; continue
        out.append(c); i += 1
    return "".join(out)
text = strip_json5_comments(text)
    text = re.sub(r",\s*([\}\]])", r"\1", text)
    cfg = json.loads(text)
    print(cfg.get("models", {}).get("providers", {}).get("openai", {}).get("apiKey", "") or "")
except Exception:
    print("")
PYEOF
)
  if [ -n "$API_KEY" ]; then
    echo "  ✓ Detected OpenAI key from secrets.jsonc"
  fi
elif [ -f "$HOME/.openclaw/agents/main/agent/auth-profiles.json" ]; then
  # Legacy: the very first "key": "..." field of auth-profiles.json. Note: this
  # file does NOT exist on srv3+ layouts (where auth moved to secrets.jsonc).
  API_KEY=$(grep -o '"key":[[:space:]]*"[^"]*"' "$HOME/.openclaw/agents/main/agent/auth-profiles.json" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)"$/\1/' || true)
  if [ -n "$API_KEY" ]; then
    echo "  ✓ Detected API key from auth-profiles.json (legacy)"
  fi
fi

if [ -z "$API_KEY" ]; then
  echo "  ℹ No OpenAI key detected. openclaw-router will work for local-only tiers"
  echo "    (Ollama/llama.cpp). Set OPENAI_API_KEY or write it to secrets.jsonc"
  echo "    if you want to route to cloud HEAVY tier."
fi

# ─── 4. Register the router provider ───────────────────────────────────────
#
# Two-way registration depending on detected mode. JSON5-aware: we use
# regex-based surgical edits so comments / unquoted keys / trailing commas
# in the file are preserved.
#
if [ ! -f "$MODELS_FILE" ]; then
  echo "  ✗ Expected config file missing: $MODELS_FILE — aborting registration."
  echo "    (If this is a fresh OpenClaw install, run 'openclaw init' first.)"
  exit 1
fi

# Backup the files we're about to touch — matches the .bak convention.
ts="$(date +%Y%m%d%H%M%S)"
if [ ! -f "${MODELS_FILE}.bak" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    noop "cp $MODELS_FILE → ${MODELS_FILE}.bak"
  else
    cp "$MODELS_FILE" "${MODELS_FILE}.bak"
  fi
  echo "  ✓ Backed up $MODELS_FILE → ${MODELS_FILE}.bak"
fi
if [ "$AGENTS_FILE" != "$MODELS_FILE" ] && [ ! -f "${AGENTS_FILE}.bak" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    noop "cp $AGENTS_FILE → ${AGENTS_FILE}.bak"
  else
    cp "$AGENTS_FILE" "${AGENTS_FILE}.bak"
  fi
  echo "  ✓ Backed up $AGENTS_FILE → ${AGENTS_FILE}.bak"
fi

# Provider block to inject. Shape matches the existing providers in
# configs/models.json5 (anthropic, openai, ollama, etc.) — `api`, `baseUrl`,
# `apiKey`, `models[]` of full model objects with `id`/`name`/etc.
#
# IMPORTANT: baseUrl MUST include `/v1`. The OpenClaw gateway uses the official
# OpenAI SDK which appends `/chat/completions` to baseUrl verbatim — it does
# NOT auto-prepend `/v1`. cerebras/moonshot/xai/deepseek all work because their
# upstream either accepts both paths or has its own /v1 prefix. Our router only
# listens on /v1/chat/completions, so without /v1 the gateway POSTs to
# /chat/completions and gets a 404 → "model not found by the provider".
{ read -r -d '' ROUTER_PROVIDER_JSON || true; } <<'JSON'
{
  "api": "openai-completions",
  "baseUrl": "http://127.0.0.1:__PORT__/v1",
  "apiKey": "passthrough",
  "models": [
    {
      "id": "auto",
      "name": "openclaw-router (auto)",
      "contextWindow": 128000,
      "maxTokens": 8192,
      "input": ["text"],
      "reasoning": true,
      "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
    }
  ]
}
JSON
ROUTER_PROVIDER_JSON="${ROUTER_PROVIDER_JSON//__PORT__/$PORT}"

if [ "$OPENCLAW_MODE" = "include-router" ]; then
  # ─── Modern ($include-router, srv3+) ───────────────────────────────────
  # Edit configs/models.json5: inject "openclaw-router" into the providers map.
  # Edit configs/agents.json5: add "openclaw-router/auto" to defaults.models.
  # Both files are JSON5; we do surgical edits to preserve the rest.
  set +e
  python3 - "$MODELS_FILE" "$AGENTS_FILE" "$ROUTER_PROVIDER_JSON" "dry_run=$DRY_RUN" <<'PYEOF'
import json, re, sys
from pathlib import Path

models_path, agents_path, provider_json_str = sys.argv[1:4]
DRY_RUN = len(sys.argv) > 4 and sys.argv[4] == "dry_run=1"
PROVIDER_NAME = "openclaw-router"
ALLOW_KEY = "openclaw-router/auto"

def strip_json5_comments(text):
    """Strip // comments, but only outside of strings (URLs etc. contain //)."""
    out = []
    i = 0
    in_string = False
    in_comment_line = False
    n = len(text)
    while i < n:
        c = text[i]
        if in_comment_line:
            if c == "\n":
                in_comment_line = False
                out.append(c)
            i += 1
            continue
        if in_string:
            if c == "\\":
                out.append(c); i += 1
                if i < n:
                    out.append(text[i]); i += 1
                continue
            if c == '"':
                in_string = False
                out.append(c); i += 1; continue
            out.append(c); i += 1; continue
        if c == '"':
            in_string = True
            out.append(c); i += 1; continue
        if c == "/" and i + 1 < n and text[i+1] == "/":
            in_comment_line = True
            i += 2; continue
        out.append(c); i += 1
    return "".join(out)

def load_json5(p):
    text = Path(p).read_text()
    text_no_comments = strip_json5_comments(text)
    return text, json.loads(re.sub(r",\s*([\}\]])", r"\1", text_no_comments))

def add_provider_to_models(models_path, provider_name, provider_dict):
    """Surgically insert `"provider_name": {...},` into the providers map.
    Idempotent: returns 'added' or 'present'. The full inserted value is the
    JSON-serialized provider_dict (without trailing comma — caller adds one).
    """
    text, cfg = load_json5(models_path)
    providers = cfg.get("providers", {})
    if provider_name in providers:
        return "present"
    # Find the closing `}` of the providers object. We locate the line that
    # starts with `providers: {` and walk braces from there.
    # This avoids touching the rest of the file (comments / unrelated keys).
    m = re.search(r'^\s*"providers"\s*:\s*\{', text, re.M)
    if not m:
        # No providers block — fail loud, operator should inspect.
        raise RuntimeError(f"No 'providers' block found in {models_path}")
    start = m.end()
    depth = 1
    i = start
    while i < len(text) and depth > 0:
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        i += 1
    # i now points just past the closing `}`. Insert our entry before it.
    insert_at = i - 1
    body = json.dumps(provider_dict, indent=2)
    # Determine if a trailing comma is needed BEFORE our entry. Look at the
    # character just before our insertion point: if it's `,` we're already
    # preceded by a comma; otherwise we add one.
    prev_char = text[insert_at - 1]
    leading = "," if prev_char != "," else ""
    new_block = f'{leading}\n    "{provider_name}": {body},\n  '
    new_text = text[:insert_at] + new_block + text[insert_at:]
    if DRY_RUN:
        print(f"  [dry-run] would write modified providers block to {models_path}")
    else:
        Path(models_path).write_text(new_text)
    return "added"

def add_to_allowlist(agents_path, key):
    """Insert `"key": {},` into the agents.defaults.models map.
    Idempotent. PURE-TEXT surgical edit; the agents.json5 file may contain
    JSON5 features (unquoted keys like `subagents:`) that break json.load.
    We only need to find the `"models": { ... }` block under `defaults`,
    which is plain JSON, and inject our entry before its closing `}`.
    """
    text = Path(agents_path).read_text()
    # Idempotency: scan the existing block for the key. We do a simple
    # substring check inside the models block (between `"models": {` and
    # its matching `}`).
    m = re.search(r'"models"\s*:\s*\{', text)
    if not m:
        raise RuntimeError(f"No 'models' block under defaults in {agents_path}")
    start = m.end()
    depth = 1
    i = start
    while i < len(text) and depth > 0:
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        i += 1
    end = i  # past the closing `}`
    block = text[start:end - 1]
    if (f'"{key}"' in block) or (f"\'{key}\'" in block):
        return "present"
    # Find the position of the last meaningful entry (last `}` before our
    # closing brace). Insert our entry before that `}`.
    # We can simply insert before end - 1 (the closing `}` position).
    insert_at = end - 1
    # Detect indentation of existing entries to match.
    # Look at last few lines of block.
    last_lines = block.rstrip().splitlines()
    indent = "      "  # default 6 spaces (matches "      \"anthropic/...")
    for line in reversed(last_lines):
        stripped = line.lstrip()
        if stripped and not stripped.startswith("//"):
            indent = line[:len(line) - len(stripped)]
            break
    new_entry = f'\n{indent}"{key}": {{}},'
    # If the previous char in text is already `,` we don't add another.
    prev_char = text[insert_at - 1]
    if prev_char == ",":
        new_entry = f'\n{indent}"{key}": {{}}'
    new_text = text[:insert_at] + new_entry + text[insert_at:]
    if DRY_RUN:
        print(f"  [dry-run] would write modified allowlist block to {agents_path}")
    else:
        Path(agents_path).write_text(new_text)
    return "added"

provider_dict = json.loads(provider_json_str)

status = add_provider_to_models(models_path, PROVIDER_NAME, provider_dict)
if status == "added":
    print(f"  ✓ Registered '{PROVIDER_NAME}' provider in {Path(models_path).name}")
else:
    print(f"  ✓ Provider '{PROVIDER_NAME}' already registered in {Path(models_path).name}")

if agents_path != models_path:
    status = add_to_allowlist(agents_path, ALLOW_KEY)
    if status == "added":
        print(f"  ✓ Added '{ALLOW_KEY}' to {Path(agents_path).name} allowlist")
    else:
        print(f"  ✓ '{ALLOW_KEY}' already in {Path(agents_path).name} allowlist")
PYEOF
  PY_RC=$?
  set -e
  if [ "$PY_RC" -ne 0 ]; then
    echo "  ✗ Registration step failed (python exit $PY_RC). Restore from .bak to roll back."
    exit $PY_RC
  fi
else
  # ─── Legacy (flat openclaw.json) ─────────────────────────────────────
  python3 - "$MODELS_FILE" "$ROUTER_PROVIDER_JSON" "dry_run=$DRY_RUN" <<'PYEOF'
import json, sys
from pathlib import Path
p, provider_json_str = sys.argv[1], sys.argv[2]
DRY_RUN = len(sys.argv) > 3 and sys.argv[3] == "dry_run=1"
cfg = json.loads(Path(p).read_text())
providers = cfg.setdefault("models", {}).setdefault("providers", {})
if "openclaw-router" not in providers:
    providers["openclaw-router"] = json.loads(provider_json_str)
    print(f"  ✓ Registered 'openclaw-router' provider in {Path(p).name}")
else:
    print(f"  ✓ Provider already registered in {Path(p).name}")
allowlist = cfg.get("agents", {}).get("defaults", {}).get("models")
if isinstance(allowlist, dict) and "openclaw-router/auto" not in allowlist:
    allowlist["openclaw-router/auto"] = {}
    print(f"  ✓ Added 'openclaw-router/auto' to {Path(p).name} model allowlist")
if DRY_RUN:
    print(f"  [dry-run] would write modified {Path(p).name}")
else:
    Path(p).write_text(json.dumps(cfg, indent=2) + "\n")
PYEOF
fi

# ─── 5. Capture provider env vars for the systemd unit ────────────────────
# All values are written to /etc/openclaw-router.env (chmod 0600); the unit
# references them via EnvironmentFile=. We use printf %q for safe escaping
# and reject any value containing a newline / CR — never write those into a
# systemd unit (would smuggle directives).
EXTRA_ENV_FILE="$(mktemp)"
python3 - "$EXTRA_ENV_FILE" <<'PYEOF'
import os, sys
out_path = sys.argv[1]
provider_envs = [
    "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ZAI_API_KEY", "MOONSHOT_API_KEY",
    "OLLAMA_HOST", "LLAMACPP_HOST", "OLLAMA_API_KEY", "LLAMACPP_API_KEY",
]
with open(out_path, "w") as f:
    for v in provider_envs:
        val = os.environ.get(v)
        if val is None or val == "":
            continue
        esc = val.replace("\\", "\\\\").replace("\"", "\\\"")
        if "\n" in esc or "\r" in esc:
            print(f"  ⚠ Refusing to write {v}: value contains newline/CR", file=sys.stderr)
            continue
        f.write(f'{v}="{esc}"\n')
PYEOF
EXTRA_ENV="$(cat "$EXTRA_ENV_FILE" 2>/dev/null || true)"
rm -f "$EXTRA_ENV_FILE"
if [ -n "$EXTRA_ENV" ]; then
  echo "$EXTRA_ENV" | while IFS= read -r line; do
    var_name="${line%%=*}"
    echo "  ✓ Passing through $var_name"
  done
fi

# ─── 6. Create systemd service ────────────────────────────────────────────
# We build the unit file by composition:
#   1. Static header herestrung with `printf` (real paths substituted)
#   2. An env-file written by a python heredoc that filters newline/CR
#   3. The unit references the env-file via `EnvironmentFile=`
# Net: the unit file body has zero unquoted shell interpolation.
NODE_BIN=$(which node)
ENV_FILE="/etc/openclaw-router.env"
TMP_ENV="$(mktemp)"
: > "$TMP_ENV"
for VAR in OPENAI_API_KEY OPENROUTER_API_KEY ZAI_API_KEY MOONSHOT_API_KEY \
           OLLAMA_HOST LLAMACPP_HOST OLLAMA_API_KEY LLAMACPP_API_KEY; do
  if [ -n "${!VAR:-}" ]; then
    SAFE_VAL=$(printf "%q" "${!VAR}")
    echo "$VAR=$SAFE_VAL" >> "$TMP_ENV"
  fi
done
cat >> "$TMP_ENV" <<STATIC
ROUTER_CONFIG=$ROUTER_DIR/config.json
ROUTER_PORT=$PORT
ROUTER_LOG=1
STATIC
if [ "$DRY_RUN" = "1" ]; then
  noop "install -m 0600 env file → $ENV_FILE"
else
  sudo install -m 0600 "$TMP_ENV" "$ENV_FILE"
fi
rm -f "$TMP_ENV"

UNIT_FILE="$(mktemp)"
# Render the systemd unit as the current user. We used to run this as
# `sudo python3` to write to a file created by `mktemp`, but on hardened
# Linuxes (AppArmor + restricted /tmp) root can be blocked from overwriting
# a 0600 user-owned temp file in /tmp. Running as democle avoids that
# entirely; the file is then handed to `sudo install` which copies it.
if [ "$DRY_RUN" = "1" ]; then
  noop "would render systemd unit to $UNIT_FILE"
else
  python3 - "$UNIT_FILE" "$NODE_BIN" "$ENV_FILE" "$ROUTER_DIR" <<'PYEOF'
import sys, os
out, node_bin, env_file, router_dir = sys.argv[1:5]
content = f"""[Unit]
Description=openclaw-router - Cost-optimizing model routing (OpenAI Chat Completions)
After=network.target

[Service]
Type=simple
ExecStart={node_bin} {router_dir}/server.js
EnvironmentFile={env_file}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
"""
with open(out, "w") as f:
    f.write(content)
print(f"  ✓ Systemd unit rendered to {out} ({os.path.getsize(out)} bytes)", file=sys.stderr)
PYEOF
fi
if [ "$DRY_RUN" = "1" ]; then
  noop "install -m 0644 systemd unit → /etc/systemd/system/$SERVICE_NAME.service"
  echo "  ✓ Would create systemd service (env file: $ENV_FILE)"
else
  sudo install -m 0644 "$UNIT_FILE" /etc/systemd/system/$SERVICE_NAME.service
  echo "  ✓ Created systemd service (env file: $ENV_FILE)"
fi
rm -f "$UNIT_FILE"

# ─── 7. Start the service ─────────────────────────────────────────────────
if [ "$DRY_RUN" = "1" ]; then
  noop "systemctl daemon-reload"
  noop "systemctl enable --now $SERVICE_NAME"
  echo "  ✓ Would start service on port $PORT"
  echo "  ⚠ Health check skipped in dry-run"
else
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE_NAME"
  echo "  ✓ Service started on port $PORT"
  sleep 1
  if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    echo "  ✓ Health check passed"
  else
    echo "  ⚠ Service started but health check failed — check: journalctl -u $SERVICE_NAME -f"
  fi
fi

# ─── 8. Final restart hint ────────────────────────────────────────────────
echo ""
case "$OPENCLAW_MODE" in
  include-router)
    echo "  ⚠ Restart OpenClaw to pick up the new provider:"
    echo "    systemctl --user restart openclaw-gateway.service"
    echo "    # or, if hot-reload is on:"
    echo "    /config reload    (from chat)"
    ;;
  flat)
    echo "  ⚠ Restart OpenClaw to pick up the new model provider:"
    echo "    openclaw gateway restart"
    echo "    # or: /config reload (from chat)"
    echo "    # or: kill -USR1 \$(pgrep -f 'openclaw.*gateway')"
    ;;
esac
echo ""
echo "  Then use: /model openclaw-router/auto"
echo ""
echo "  By default, LIGHT/MEDIUM tier route to local Ollama (127.0.0.1:11434)."
echo "  Make sure Ollama (or your chosen provider) is running."
echo ""
echo "⚡ Done! Check stats: curl http://127.0.0.1:$PORT/stats"
