'use strict';
// One-click launcher: starts the server hidden if it is not running, then opens
// the dashboard as an app window. `--background` starts the server only.
// Safe to run any number of times.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { giveWindowIcon } = require('./lib/windowicon');

const PORT = Number(process.env.CS_PORT || 8930);
const URL = `http://127.0.0.1:${PORT}/`;
const background = process.argv.includes('--background');
const WIN = process.platform === 'win32';

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/ping', timeout: 1500 }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(s).app === 'claude-sessions'); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}

// A Chromium browser opens the dashboard as its own app window.
const MAC_BROWSERS = [
  'Google Chrome.app/Contents/MacOS/Google Chrome',
  'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'Brave Browser.app/Contents/MacOS/Brave Browser',
  'Chromium.app/Contents/MacOS/Chromium',
];

function findBrowser() {
  if (!WIN) {
    const roots = ['/Applications', path.join(require('os').homedir(), 'Applications')];
    for (const b of MAC_BROWSERS) for (const r of roots) if (fs.existsSync(path.join(r, b))) return path.join(r, b);
    return null;
  }
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].find((p) => fs.existsSync(p));
}

function openWindow() {
  const browser = findBrowser();
  const child = browser
    ? spawn(browser, [`--app=${URL}`, '--window-size=1180,860'], { detached: true, stdio: 'ignore' })
    : WIN
      ? spawn('cmd.exe', ['/c', 'start', '', URL], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn('open', [URL], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  if (browser) giveWindowIcon(__dirname);
}

(async () => {
  if (!(await ping())) {
    startServer();
    for (let i = 0; i < 40 && !(await ping()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  if (!background) openWindow();
})();
