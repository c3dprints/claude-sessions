#!/bin/bash
# Install Claude Sessions.command: a double-click installer for macOS, the Mac
# twin of ClaudeSessionsSetup.exe. Checks for the Xcode command line tools and
# Node.js (offers to install them), warns when Claude Code is missing, then runs
# the install-mac.sh that scripts/build-setup.js puts in below, which clones the
# app, checks out the newest release and builds Claude Sessions.app.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

finish() { echo; read -r -p "Press Enter to close." _; exit "$1"; }
ask() {
  local a
  read -r -p "$1 [Y/n] " a
  case "$(printf '%s' "$a" | tr 'A-Z' 'a-z')" in ""|y|yes) return 0 ;; *) return 1 ;; esac
}

echo "Claude Sessions setup"
echo

if ! xcode-select -p >/dev/null 2>&1; then
  echo "The Xcode command line tools are needed (they give git and the C compiler)."
  xcode-select --install >/dev/null 2>&1 || true
  echo "A window to install them should have opened. When it has finished, press Enter."
  read -r _
  xcode-select -p >/dev/null 2>&1 || { echo "Still not installed. Run this setup again once they are."; finish 1; }
fi

node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; }
if ! node_ok; then
  echo "Node.js 18 or newer is needed and not installed."
  if command -v brew >/dev/null 2>&1; then
    ask "Install Node.js now with Homebrew?" || finish 1
    brew install node || finish 1
  else
    ask "Download the Node.js installer from nodejs.org now?" || finish 1
    BASE="https://nodejs.org/dist/latest-v24.x"
    PKG="$(curl -fsSL "$BASE/" | grep -o 'node-v24[0-9.]*\.pkg' | head -1)"
    [ -n "$PKG" ] || { echo "Could not find it. Install Node.js from https://nodejs.org, then run this setup again."; finish 1; }
    curl -fL --progress-bar -o "/tmp/$PKG" "$BASE/$PKG" || finish 1
    echo "The Node.js installer is open. Click through it; setup carries on when it closes."
    open -W "/tmp/$PKG"
    rm -f "/tmp/$PKG"
  fi
  hash -r
  node_ok || { echo "Node.js still not found. Install it from https://nodejs.org, then run this setup again."; finish 1; }
fi

if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
  echo "Claude Code was not found. The app shows and runs Claude Code sessions, so install it too:"
  echo "  https://docs.claude.com/en/docs/claude-code/setup"
  ask "Install Claude Sessions anyway?" || finish 1
fi

echo "Installing..."
SCRIPT="$(mktemp -t claude-sessions-install)"
cat > "$SCRIPT" <<'INSTALL_SH'
#@INSTALL_MAC_SH@
INSTALL_SH
bash "$SCRIPT"
CODE=$?
rm -f "$SCRIPT"
[ "$CODE" -eq 0 ] || { echo "The installer reported an error (exit code $CODE)."; finish "$CODE"; }

open "$HOME/Applications/Claude Sessions.app"
echo
echo "Done. Claude Sessions is open; start it from Applications in your home folder (or Spotlight) from now on."
echo "It updates itself, so you only need this setup again to repair the install."
finish 0
