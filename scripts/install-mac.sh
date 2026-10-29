#!/bin/bash
# Installs (or repairs) Claude Sessions for this Mac user, like install.ps1 on Windows:
#   - clones the repo to ~/Library/Application Support/ClaudeSessions/app and checks out the newest release tag
#   - stops a running server so the launcher starts the new code
#   - builds "Claude Sessions.app" into ~/Applications, pointed at that folder
set -euo pipefail
REPO="${1:-https://github.com/c3dprints/claude-sessions.git}"
APP="$HOME/Library/Application Support/ClaudeSessions/app"
mkdir -p "$(dirname "$APP")"

[ -d "$APP/.git" ] || git clone --quiet "$REPO" "$APP"
git -C "$APP" fetch --tags --force --quiet origin
TAG="$(git -C "$APP" tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -1)"
[ -n "$TAG" ] || { echo "the repo has no release tags yet"; exit 1; }
git -C "$APP" checkout --quiet "refs/tags/$TAG"
echo "Installed $TAG in $APP"

pkill -f "$APP/server.js" 2>/dev/null || true
bash "$APP/scripts/build-mac.sh" "$APP"
