'use strict';
// "Start with Windows": a shortcut in the user's Startup folder that starts the
// server in the background (no window), so closures are caught even when the
// dashboard is not open. On macOS the same job is a LaunchAgent ("Start at login").

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const WIN = process.platform === 'win32';
const AGENT_LABEL = 'com.c3dprints.claude-sessions';

function agentPath() {
  return path.join(require('os').homedir(), 'Library', 'LaunchAgents', AGENT_LABEL + '.plist');
}

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// launchd starts it once at login; launch.js exits after starting the server, so no KeepAlive.
function agentPlist() {
  const args = [process.execPath, path.join(APP_DIR, 'launch.js'), '--background'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(APP_DIR)}</string>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
}

function shortcutPath() {
  if (!WIN) return agentPath();
  return path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Claude Sessions.lnk');
}

function isEnabled() {
  return fs.existsSync(shortcutPath());
}

// Shortcut fields are passed through env vars so no path is ever spliced into script text.
function makeShortcut(lnk, args) {
  const ps = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:CS_LNK)',
    '$s.TargetPath = "$env:WINDIR\\System32\\wscript.exe"',
    '$s.Arguments = $env:CS_ARGS',
    '$s.WorkingDirectory = $env:CS_DIR',
    'if (Test-Path $env:CS_ICON) { $s.IconLocation = $env:CS_ICON }',
    '$s.Description = "Claude Sessions dashboard"',
    '$s.Save()',
  ].join('; ');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      timeout: 20000,
      env: {
        ...process.env,
        CS_LNK: lnk,
        CS_ARGS: args,
        CS_DIR: APP_DIR,
        CS_ICON: path.join(APP_DIR, 'public', 'icon.ico'),
      },
    }, (err, _out, stderr) => (err ? reject(new Error(String(stderr).trim() || err.message)) : resolve()));
  });
}

function launcherArgs(extra) {
  return `"${path.join(APP_DIR, 'scripts', 'launch.vbs')}"${extra ? ' ' + extra : ''}`;
}

async function setEnabled(on) {
  const lnk = shortcutPath();
  if (!WIN) {
    if (on) {
      fs.mkdirSync(path.dirname(lnk), { recursive: true });
      fs.writeFileSync(lnk, agentPlist());
    } else if (fs.existsSync(lnk)) fs.unlinkSync(lnk);
    return isEnabled();
  }
  if (on) await makeShortcut(lnk, launcherArgs('--background'));
  else if (fs.existsSync(lnk)) fs.unlinkSync(lnk);
  return isEnabled();
}

module.exports = { isEnabled, setEnabled, makeShortcut, launcherArgs, shortcutPath, agentPlist };
