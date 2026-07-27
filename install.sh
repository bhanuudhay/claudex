#!/usr/bin/env bash
# claudex installer (macOS / Linux).
#
#   ./install.sh              install the `claudex` command
#   ./install.sh --as-claude  additionally install a `claude` shim, in its own
#                             directory, so existing commands gain failover
#                             without being retyped
#   ./install.sh --uninstall  remove both
#
# The `claude` shim is written to a dedicated directory
# ($HOME/.local/share/claudex/shim by default) that you put ahead of the real
# CLI on PATH. It is never written next to the real binary: on a typical install
# `claude` in ~/.local/bin is a symlink into ~/.local/share/claude/versions/,
# and writing through that symlink would overwrite the real binary.
set -euo pipefail

BIN_DIR="${CLAUDEX_BIN_DIR:-$HOME/.local/bin}"
SHIM_DIR="${CLAUDEX_SHIM_DIR:-$HOME/.local/share/claudex/shim}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AS_CLAUDE=0
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --as-claude) AS_CLAUDE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Remove a file only if it is one of ours. Refuses to touch anything else, and
# never follows a symlink to a target outside the shim directory.
remove_if_ours() {
  local path="$1"
  [ -e "$path" ] || [ -L "$path" ] || return 0
  if [ -L "$path" ]; then
    echo "refusing to remove $path: it is a symlink, not a claudex shim" >&2
    return 0
  fi
  if grep -q CLAUDEX_SHIM "$path" 2>/dev/null; then
    rm -f "$path"
    return 0
  fi
  echo "refusing to remove $path: not a claudex shim" >&2
}

if [ "$UNINSTALL" = "1" ]; then
  remove_if_ours "$BIN_DIR/claudex"
  remove_if_ours "$SHIM_DIR/claude"
  rmdir "$SHIM_DIR" 2>/dev/null || true
  echo "uninstalled"
  echo "remove $SHIM_DIR from your PATH if you added it"
  exit 0
fi

command -v node >/dev/null 2>&1 || { echo "node is required (>= 20)" >&2; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "node >= 20 is required (found $(node -v))" >&2
  exit 1
fi

if [ "${CLAUDEX_SKIP_BUILD:-0}" = "1" ]; then
  echo "skipping build (CLAUDEX_SKIP_BUILD=1)"
else
  echo "building..."
  (cd "$ROOT" && npm install --silent --no-audit --no-fund && npm run build --silent)
fi

mkdir -p "$BIN_DIR"

# rm first: the target may be a symlink, and `>` would write through it.
rm -f "$BIN_DIR/claudex"
cat > "$BIN_DIR/claudex" <<EOF
#!/usr/bin/env node
// CLAUDEX_SHIM
import('$ROOT/dist/cli.bundle.js').then((m) => m.main(process.argv.slice(2)));
EOF
chmod 755 "$BIN_DIR/claudex"
echo "installed $BIN_DIR/claudex"

if [ "$AS_CLAUDE" = "1" ]; then
  # Resolve the real CLI *before* creating anything, ignoring our own shim dir,
  # and follow symlinks so the recorded path cannot be re-shimmed later.
  REAL_CLAUDE="$(
    PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -vx "$SHIM_DIR" | paste -sd: -)" \
      command -v claude || true
  )"
  if [ -n "$REAL_CLAUDE" ]; then
    REAL_CLAUDE="$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$REAL_CLAUDE")"
  fi

  if [ -z "$REAL_CLAUDE" ]; then
    echo "could not find the real claude binary" >&2
    echo "install the Claude CLI first, or set claude_path in your claudex config" >&2
    exit 1
  fi
  if grep -q CLAUDEX_SHIM "$REAL_CLAUDE" 2>/dev/null; then
    echo "the claude on your PATH is already a claudex shim: $REAL_CLAUDE" >&2
    echo "run ./install.sh --uninstall first" >&2
    exit 1
  fi
  if ! "$REAL_CLAUDE" --version >/dev/null 2>&1; then
    echo "found $REAL_CLAUDE but it did not run; refusing to shim a broken install" >&2
    exit 1
  fi
  echo "real claude: $REAL_CLAUDE ($("$REAL_CLAUDE" --version))"

  mkdir -p "$SHIM_DIR"
  rm -f "$SHIM_DIR/claude"
  cat > "$SHIM_DIR/claude" <<EOF
#!/usr/bin/env node
// CLAUDEX_SHIM
// Shadows the real Claude CLI. The real binary is recorded below, resolved at
// install time, so resolution never has to search a PATH that contains this
// shim.
process.env.CLAUDEX_CLAUDE_BIN = process.env.CLAUDEX_CLAUDE_BIN || '$REAL_CLAUDE';
import('$ROOT/dist/cli.bundle.js').then((m) => m.main(process.argv.slice(2)));
EOF
  chmod 755 "$SHIM_DIR/claude"
  echo "installed $SHIM_DIR/claude (shim)"
  echo
  echo "Add the shim directory to the FRONT of your PATH:"
  echo "  export PATH=\"$SHIM_DIR:\$PATH\""
  echo "Undo at any time with: ./install.sh --uninstall"
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo; echo "note: $BIN_DIR is not on your PATH; add it to your shell profile" ;;
esac

echo
echo "next: claudex init && claudex health"
