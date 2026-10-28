'use strict';
// "Start with Windows": a shortcut in the user's Startup folder that starts the
// server in the background (no window), so closures are caught even when the
// dashboard is not open.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const APP_DIR = path.join(__dirname, '..');

function shortcutPath() {
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
  if (on) await makeShortcut(lnk, launcherArgs('--background'));
  else if (fs.existsSync(lnk)) fs.unlinkSync(lnk);
  return isEnabled();
}

module.exports = { isEnabled, setEnabled, makeShortcut, launcherArgs, shortcutPath };
