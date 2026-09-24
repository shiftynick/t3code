#!/usr/bin/env bash
# Install shiftynick's T3 Code launcher + desktop entry on an omarchy machine.
#
# Usage:
#   ./shiftynick/install.sh [path-to-repo]
#
# The repo path defaults to ~/Work/t3code. Pass the actual checkout path if it
# lives somewhere else, and the generated files will point at it.
set -euo pipefail

REPO="${1:-$HOME/Work/t3code}"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
LAUNCHER="$BIN_DIR/t3code-shiftynick"
DESKTOP="$APPS_DIR/t3code-shiftynick.desktop"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing required tool: $1"; }

echo "==> prerequisites"
need git
need mise
need notify-send
need systemd-run
[[ -x "$HOME/.vite-plus/bin/vp" ]] || fail "~/.vite-plus/bin/vp not found (have you run vp i in the repo?)"
mise exec node@24.20.0 -- node --version >/dev/null 2>&1 || \
  fail "mise has no node@24.20.0 installed (mise use -g node@24.20.0)"

git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not a git checkout: $REPO"
[[ "$(git -C "$REPO" branch --show-current)" == "shiftynick" ]] || \
  fail "repo is not on the shiftynick branch: $REPO"
[[ -f "$REPO/assets/prod/black-universal-1024.png" ]] || \
  fail "missing assets/prod/black-universal-1024.png in $REPO"

echo "==> launcher script"
mkdir -p "$BIN_DIR"
cp "$HERE/t3code-shiftynick" "$LAUNCHER"
chmod +x "$LAUNCHER"
if [[ "$REPO" != "$HOME/Work/t3code" ]]; then
  # Patch the hardcoded default repo path so a non-default checkout works.
  sed -i "s#REPO = Path.home() / 'Work/t3code'#REPO = Path('$REPO')#" "$LAUNCHER"
fi

echo "==> desktop entry"
mkdir -p "$APPS_DIR"
cat > "$DESKTOP" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=T3 Code (shiftynick)
Comment=Desktop build of shiftynick's T3 Code fork
Exec=omarchy launch terminal "$LAUNCHER"
Path=$REPO
Icon=$REPO/assets/prod/black-universal-1024.png
Terminal=false
Categories=Development;
Keywords=t3code;agents;coding;shiftynick;
StartupWMClass=t3code
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" || true

echo "==> done"
echo "Launcher: $LAUNCHER"
echo "Desktop entry: $DESKTOP"
echo "Launch from the app menu: 'T3 Code (shiftynick)'. On first run it builds"
echo "the desktop app from $REPO, then opens it as a background user service."