'use strict';
// Outside terminal actions: jump to a session's tab, reopen a closed session.
// Windows Terminal on Windows; Terminal.app (and iTerm2 for jumping) on macOS.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { UUID_RE } = require('./sessions');

const FOCUS_SCRIPT = path.join(__dirname, '..', 'scripts', 'focus-tab.ps1');
const WIN = process.platform === 'win32';

// AppleScript gets every value through argv, so no path or title is spliced into script text.
const TERMINAL_FOCUS = `on run argv
  set t to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with tb in tabs of w
        if tty of tb is t then
          set selected of tb to true
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "none"
end run`;

const ITERM_FOCUS = `on run argv
  set t to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with s in sessions of tb
          if tty of s is t then
            tell w to select
            tell tb to select
            tell s to select
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "none"
end run`;

const TERMINAL_RUN = `on run argv
  tell application "Terminal"
    do script (item 1 of argv)
    activate
  end tell
end run`;

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => resolve({ err, out: String(stdout || '').trim(), errText: String(stderr || '').trim() }));
  });
}

async function focusMac(pid) {
  const tty = (await run('ps', ['-o', 'tty=', '-p', String(pid)])).out;
  if (!tty || tty === '??') return { ok: false, error: 'that session has no terminal window' };
  const dev = '/dev/' + tty.replace(/^\/dev\//, '');
  const apps = [['Terminal', TERMINAL_FOCUS], ['iTerm2', ITERM_FOCUS]];
  let lastErr = null;
  for (const [app, script] of apps) {
    if ((await run('pgrep', ['-x', app])).err) continue; // not running, do not launch it
    const r = await run('osascript', ['-e', script, dev]);
    if (r.out === 'ok') return { ok: true, app };
    if (r.err) lastErr = r.errText || r.err.message;
  }
  if (lastErr && /not allowed|-1743/.test(lastErr)) return { ok: false, error: 'allow Claude Sessions to control Terminal in System Settings, Privacy & Security, Automation' };
  return { ok: false, error: lastErr || 'its tab was not found in Terminal or iTerm2' };
}

// POSIX shell single quotes: nothing inside is special except the quote itself.
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function focus(pid, title) {
  if (!WIN) return focusMac(pid);
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
  if (!WIN) return cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd;
  return cwd.length > 3 ? cwd.replace(/[\\/]+$/, '') : cwd;
}

function claudeTabArgs(cwd, sessionId) {
  const dir = checkDir(cwd);
  let cmd = 'claude';
  if (sessionId !== undefined) {
    if (!UUID_RE.test(sessionId)) throw new Error('bad session id');
    cmd = `claude --resume ${sessionId}`;
  }
  if (!WIN) return ['-e', TERMINAL_RUN, `cd ${shQuote(dir)} && ${cmd}`];
  return ['-w', '0', 'new-tab', '-d', wtEscape(dir), 'powershell.exe', '-NoExit', '-Command', cmd];
}

function openTab(args) {
  const child = spawn(WIN ? 'wt.exe' : 'osascript', args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

module.exports = {
  focus,
  wtEscape,
  shQuote,
  checkDir,
  claudeTabArgs,
  resume: (cwd, sessionId) => openTab(claudeTabArgs(cwd, sessionId)),
  newSession: (cwd) => openTab(claudeTabArgs(cwd)),
};
