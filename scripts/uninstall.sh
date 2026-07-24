#!/usr/bin/env bash
# openclaw-router uninstaller — supports both OpenClaw layouts (modern
# $include-router and legacy flat openclaw.json).
#
# Detects layout the same way install.sh does, then surgically removes:
#   - openclaw-router provider from configs/models.json5 (or openclaw.json)
#   - openclaw-router/auto entry from configs/agents.json5 (or openclaw.json)
#   - systemd service + unit + env file
#   - $HOME/.openclaw/workspace/skills/router/
#
# Preserves .bak files (operator can roll back manually).
set -euo pipefail

SERVICE_NAME="openclaw-router"
ROUTER_DIR="$HOME/.openclaw/workspace/skills/router"
ENV_FILE="/etc/openclaw-router.env"

echo "Removing openclaw-router..."

# ─── 1. Stop + disable + remove systemd unit ───────────────────────────────
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  sudo systemctl stop "$SERVICE_NAME" || true
  echo "  ✓ Service stopped"
fi
if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
  sudo systemctl disable "$SERVICE_NAME" || true
fi
if [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; then
  sudo rm "/etc/systemd/system/$SERVICE_NAME.service"
  sudo systemctl daemon-reload || true
  echo "  ✓ Systemd unit removed"
fi

# ─── 2. Remove env file (chmod 0600 root-only) ────────────────────────────
if [ -f "$ENV_FILE" ]; then
  sudo rm "$ENV_FILE"
  echo "  ✓ Env file removed"
fi

# ─── 3. Remove router files ───────────────────────────────────────────────
if [ -d "$ROUTER_DIR" ]; then
  rm -rf "$ROUTER_DIR"
  echo "  ✓ Router files removed from $ROUTER_DIR"
fi

# ─── 4. Detect OpenClaw config layout ──────────────────────────────────────
OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"
OPENCLAW_MODE="flat"
if [ -f "$OPENCLAW_JSON" ]; then
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
    MODELS_FILE="$HOME/.openclaw/configs/models.json5"
    AGENTS_FILE="$HOME/.openclaw/configs/agents.json5"
    ;;
  flat)
    MODELS_FILE="$OPENCLAW_JSON"
    AGENTS_FILE="$OPENCLAW_JSON"
    ;;
esac
echo "  ✓ Detected OpenClaw mode: $OPENCLAW_MODE"

# ─── 5. Remove from OpenClaw config ───────────────────────────────────────
#
# Surgical text edits — same approach as install.sh.
#
if [ "$OPENCLAW_MODE" = "include-router" ]; then
  if [ -f "$MODELS_FILE" ]; then
    python3 - "$MODELS_FILE" <<'PYEOF'
import json, re, sys
from pathlib import Path
p = sys.argv[1]
text = Path(p).read_text()
# Surgical: remove `"openclaw-router": {...},` from the providers map.
m = re.search(r'^\s*"providers"\s*:\s*\{', text, re.M)
if not m:
    print(f"  (no providers block in {Path(p).name})")
    sys.exit(0)
start = m.end()
depth = 1
i = start
while i < len(text) and depth > 0:
    c = text[i]
    if c == "{": depth += 1
    elif c == "}": depth -= 1
    i += 1
end = i  # past closing `}`
block = text[start:end - 1]
# Find the `"openclaw-router": { ... }` entry via brace-balanced scan inside the
# providers block.
entry_match = re.search(r'"openclaw-router"\s*:\s*\{', block)
if not entry_match:
    print(f"  ✓ No 'openclaw-router' entry in {Path(p).name}")
    sys.exit(0)
entry_start_in_block = entry_match.start()
# Walk braces from there to find the entry's closing `}`.
entry_open = entry_match.end() - 1  # position of `{`
depth = 1
j = entry_open + 1
while j < len(block) and depth > 0:
    c = block[j]
    if c == "{": depth += 1
    elif c == "}": depth -= 1
    j += 1
# j is now past the entry's closing `}`.
entry_end_in_block = j
# Also eat the trailing comma if present.
if entry_end_in_block < len(block) and block[entry_end_in_block] == ",":
    entry_end_in_block += 1
# Eat any leading newline+whitespace before the entry's key.
leading_start = entry_start_in_block
while leading_start > 0 and block[leading_start - 1] in " \t":
    leading_start -= 1
if leading_start > 0 and block[leading_start - 1] == "\n":
    leading_start -= 1
# Eat any trailing newline+whitespace after the entry's `}`.
trailing_end = entry_end_in_block
while trailing_end < len(block) and block[trailing_end] in " \t":
    trailing_end += 1
if trailing_end < len(block) and block[trailing_end] == "\n":
    trailing_end += 1
new_block = block[:leading_start] + block[trailing_end:]
new_text = text[:start] + new_block + text[end - 1:]
Path(p).write_text(new_text)
print(f"  ✓ Removed 'openclaw-router' provider from {Path(p).name}")
PYEOF
  fi

  if [ -f "$AGENTS_FILE" ]; then
    # Surgical: remove `"openclaw-router/auto": {...},` from agents.defaults.models.
    # Pure text — agents.json5 may have unquoted JSON5 keys.
    python3 - "$AGENTS_FILE" <<'PYEOF'
import re, sys
from pathlib import Path
p = sys.argv[1]
text = Path(p).read_text()
m = re.search(r'"models"\s*:\s*\{', text)
if not m:
    print(f"  (no models block in {Path(p).name})")
    sys.exit(0)
start = m.end()
depth = 1
i = start
while i < len(text) and depth > 0:
    c = text[i]
    if c == "{": depth += 1
    elif c == "}": depth -= 1
    i += 1
end = i
block = text[start:end - 1]
# Find `"openclaw-router/auto":` entry — value is `{}` (1 pair).
entry_match = re.search(r'"openclaw-router/auto"\s*:\s*\{[^}]*\}', block)
if not entry_match:
    print(f"  ✓ No 'openclaw-router/auto' entry in {Path(p).name}")
    sys.exit(0)
es, ee = entry_match.span()
# Eat trailing comma.
if ee < len(block) and block[ee] == ",":
    ee += 1
# Eat leading whitespace back to the previous newline.
ls = es
while ls > 0 and block[ls - 1] in " \t":
    ls -= 1
if ls > 0 and block[ls - 1] == "\n":
    ls -= 1
# Eat trailing whitespace forward to next newline.
te = ee
while te < len(block) and block[te] in " \t":
    te += 1
if te < len(block) and block[te] == "\n":
    te += 1
new_block = block[:ls] + block[te:]
new_text = text[:start] + new_block + text[end - 1:]
Path(p).write_text(new_text)
print(f"  ✓ Removed 'openclaw-router/auto' from {Path(p).name}")
PYEOF
  fi
else
  # Legacy flat — single-file edit.
  if [ -f "$MODELS_FILE" ]; then
    python3 - "$MODELS_FILE" <<'PYEOF'
import json, sys
from pathlib import Path
p = sys.argv[1]
cfg = json.loads(Path(p).read_text())
changed = False
providers = cfg.get("models", {}).get("providers", {})
if "openclaw-router" in providers:
    del providers["openclaw-router"]
    if not providers: cfg["models"].pop("providers", None)
    if not cfg.get("models"): cfg.pop("models", None)
    changed = True
    print(f"  ✓ Removed 'openclaw-router' provider from {Path(p).name}")
allowlist = cfg.get("agents", {}).get("defaults", {}).get("models", {})
if "openclaw-router/auto" in allowlist:
    del allowlist["openclaw-router/auto"]
    changed = True
    print(f"  ✓ Removed 'openclaw-router/auto' from {Path(p).name}")
if changed:
    Path(p).write_text(json.dumps(cfg, indent=2) + "\n")
else:
    print(f"  ✓ {Path(p).name} already clean")
PYEOF
  fi
fi

echo ""
echo "  ⚠ Restart OpenClaw to apply changes:"
case "$OPENCLAW_MODE" in
  include-router) echo "    systemctl --user restart openclaw-gateway.service" ;;
  flat)           echo "    openclaw gateway restart" ;;
esac
echo ""
echo "  If any cron jobs or subagents used openclaw-router/auto, switch them"
echo "  to a direct model (e.g. openai/gpt-5.1)."
echo ""
echo "  .bak files from install.sh are kept for manual rollback if needed."
echo ""
echo "Done."
