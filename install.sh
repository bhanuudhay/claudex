#!/usr/bin/env bash
# claudex installer (macOS / Linux).
#
#   ./install.sh              install the `claudex` command
#   ./install.sh --as-claude  additionally install a `claude` shim that shadows
#                             the real CLI, so existing commands gain failover
#                             without being retyped
#   ./install.sh --uninstall  remove both
#
# The shim is opt-in on purpose: it puts claudex in front of every `claude`
# invocation on this machine, including the ones your editor and hooks make.
set -euo pipefail

BIN_DIR="${CLAUDEX_BIN_DIR:-$HOME/.local/bin}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AS_CLAUDE=0
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --as-claude) AS_CLAUDE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$UNINSTALL" = "1" ]; then
  rm -f "$BIN_DIR/claudex"
  if [ -f "$BIN_DIR/claude" ] && grep -q CLAUDEX_SHIM "$BIN_DIR/claude" 2>/dev/null; then
    rm -f "$BIN_DIR/claude"
    echo "removed the claude shim"
  fi
  echo "removed $BIN_DIR/claudex"
  exit 0
fi

command -v node >/dev/null 2>&1 || { echo "node is required (>= 20)" >&2; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "node >= 20 is required (found $(node -v))" >&2
  exit 1
fi

echo "building..."
(cd "$ROOT" && npm install --silent --no-audit --no-fund && npm run build --silent)

mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/claudex" <<EOF
#!/usr/bin/env node
// CLAUDEX_SHIM
import('$ROOT/dist/cli.bundle.js').then((m) => m.main(process.argv.slice(2)));
EOF
chmod 755 "$BIN_DIR/claudex"
echo "installed $BIN_DIR/claudex"

if [ "$AS_CLAUDE" = "1" ]; then
  REAL_CLAUDE="$(PATH="$(echo "$PATH" | tr ':' '\n' | grep -v "^$BIN_DIR\$" | paste -sd: -)" command -v claude || true)"
  if [ -z "$REAL_CLAUDE" ]; then
    echo "could not find the real claude binary outside $BIN_DIR" >&2
    echo "set claude_path in your claudex config before using the shim" >&2
  else
    echo "real claude: $REAL_CLAUDE"
  fi

  cat > "$BIN_DIR/claude" <<EOF
#!/usr/bin/env node
// CLAUDEX_SHIM
// Shadows the real Claude CLI. claudex resolves the real binary by skipping
// every executable carrying this marker, so this cannot recurse.
process.env.CLAUDEX_CLAUDE_BIN = process.env.CLAUDEX_CLAUDE_BIN || '${REAL_CLAUDE:-}';
import('$ROOT/dist/cli.bundle.js').then((m) => m.main(process.argv.slice(2)));
EOF
  chmod 755 "$BIN_DIR/claude"
  echo "installed $BIN_DIR/claude (shim)"
  echo
  echo "Make sure $BIN_DIR comes before the real claude on your PATH."
  echo "Undo at any time with: ./install.sh --uninstall"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo; echo "note: $BIN_DIR is not on your PATH; add it to your shell profile" ;;
esac

echo
echo "next: claudex init && claudex health"
