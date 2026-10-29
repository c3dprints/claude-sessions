'use strict';
// The browser groups its app windows under its own taskbar icon, and Edge puts its
// own app ID back when the page reloads. scripts/window-icon.ps1 gives the dashboard
// window its own button with the app icon; the launcher runs it when it opens the
// window and the page asks for it again on every load.

const path = require('path');
const { spawn } = require('child_process');

function giveWindowIcon(appDir) {
  if (process.platform !== 'win32') return;
  const vbs = path.join(appDir, 'scripts', 'launch.vbs');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(appDir, 'scripts', 'window-icon.ps1')], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: {
      ...process.env,
      CS_ICON: path.join(appDir, 'public', 'icon.ico'),
      CS_RELAUNCH: `"${path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe')}" "${vbs}"`,
    },
  });
  child.on('error', () => {});
  child.unref();
}

module.exports = { giveWindowIcon };
