#!/bin/bash
# Builds "Claude Sessions.app": a small launcher that starts the dashboard
# server (node launch.js) from an app folder and opens it as an app window.
#
#   scripts/build-mac.sh [app folder]
#
# The app folder defaults to this checkout. The .app holds no app code, so the
# self-updater (git tags) keeps working on that folder. Output: dist/ and ~/Applications.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$(cd "${1:-$HERE}" && pwd)"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node was not found on PATH (Node 18+ is needed)"; exit 1; }
[ -f "$APP_DIR/launch.js" ] || { echo "no launch.js in $APP_DIR"; exit 1; }
VERSION="$("$NODE" -p "require('$APP_DIR/package.json').version")"

OUT="$HERE/dist/Claude Sessions.app"
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"

# Icon: render the SVG with Quick Look, then cut every size iconutil wants.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if qlmanage -t -s 1024 -o "$WORK" "$HERE/public/icon.svg" >/dev/null 2>&1 && [ -f "$WORK/icon.svg.png" ]; then
  SET="$WORK/AppIcon.iconset"
  mkdir "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$WORK/icon.svg.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$WORK/icon.svg.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$OUT/Contents/Resources/AppIcon.icns"
else
  echo "warning: could not render the icon, the app gets the default one"
fi

# Finder starts apps with a bare PATH, so node and the app folder are written in full.
cat > "$OUT/Contents/MacOS/claude-sessions" <<SH
#!/bin/bash
NODE="$NODE"
[ -x "\$NODE" ] || NODE="\$(/bin/bash -lc 'command -v node')"
exec "\$NODE" "$APP_DIR/launch.js" "\$@"
SH
chmod +x "$OUT/Contents/MacOS/claude-sessions"

cat > "$OUT/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Claude Sessions</string>
  <key>CFBundleDisplayName</key><string>Claude Sessions</string>
  <key>CFBundleIdentifier</key><string>com.c3dprints.claude-sessions</string>
  <key>CFBundleExecutable</key><string>claude-sessions</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>Claude Sessions jumps to a session's tab and opens sessions in Terminal.</string>
</dict>
</plist>
PL

codesign --force --sign - "$OUT" >/dev/null 2>&1 || true

mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/Claude Sessions.app"
cp -R "$OUT" "$HOME/Applications/"
echo "built Claude Sessions $VERSION -> $HOME/Applications/Claude Sessions.app (runs $APP_DIR)"
