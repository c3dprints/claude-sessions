'use strict';
// Windows Terminal actions: jump to a session's tab, reopen a closed session.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { UUID_RE } = require('./sessions');

const FOCUS_SCRIPT = path.join(__dirname, '..', 'scripts', 'focus-tab.ps1');

function focus(pid, title) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FOCUS_SCRIPT], {
      windowsHide: true,
      timeout: 20000,
      env: { ...process.env, CS_PID: String(pid), CS_TITLE: title || '' },
    }, (err, stdout) => {
      const line = String(stdout || '').trim().split(/\r?\n/).pop();
      try { return resolve(JSON.parse(line)); } catch { /* fall through */ }
      resolve({ ok: false, error: err ? err.message : 'focus script gave no answer' });
    });
  });
}

// wt.exe splits its own command line on ';', so a literal one must be escaped.
function wtEscape(s) {
  return String(s).replace(/;/g, '\\;');
}

function checkDir(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('unknown folder for this session');
  let st;
  try { st = fs.statSync(cwd); } catch { throw new Error(`folder no longer exists: ${cwd}`); }
  if (!st.isDirectory()) throw new Error(`not a folder: ${cwd}`);
  // A trailing backslash before the closing quote would escape it.
  return cwd.length > 3 ? cwd.replace(/[\\/]+$/, '') : cwd;
}

function claudeTabArgs(cwd, sessionId) {
  const dir = checkDir(cwd);
  let cmd = 'claude';
  if (sessionId !== undefined) {
    if (!UUID_RE.test(sessionId)) throw new Error('bad session id');
    cmd = `claude --resume ${sessionId}`;
  }
  return ['-w', '0', 'new-tab', '-d', wtEscape(dir), 'powershell.exe', '-NoExit', '-Command', cmd];
}

function openTab(args) {
  const child = spawn('wt.exe', args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

module.exports = {
  focus,
  wtEscape,
  checkDir,
  claudeTabArgs,
  resume: (cwd, sessionId) => openTab(claudeTabArgs(cwd, sessionId)),
  newSession: (cwd) => openTab(claudeTabArgs(cwd)),
};
