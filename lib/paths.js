// File and folder paths in terminal text: which ones exist, and opening one in
// Explorer (Finder on a Mac) with the file picked out.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const MAX_LINE = 4000;
// A path may end right before one of these (or at the end of the text).
const STOP = /[\s)\]}>,;:'"`]/;
// Text that holds a path: everything up to a space or a character no path has.
const TOKEN = /[^\s"'`<>|*?]+/g;

// A path written in the text, made absolute: ~ is the home folder, others start at cwd.
function resolve(p, cwd) {
  let s = String(p || '');
  if (/^~[\\/]/.test(s)) s = path.join(os.homedir(), s.slice(2));
  if (!path.isAbsolute(s)) {
    if (!cwd || !path.isAbsolute(cwd)) return null;
    s = path.join(cwd, s);
  }
  return path.normalize(s);
}

function stat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// How much of the start of `text` names a file or folder that exists (0 for none).
// The longest one, so "D:\Etsy\Bambu X1C\Ramps" wins over "D:\Etsy\Bambu"; it stops
// once even the folder part is missing, since nothing longer can exist then.
function existingLength(text, cwd, spaces) {
  let best = 0;
  for (let i = 1; i <= text.length; i++) {
    const endsSentence = /[.!]/.test(text[i]) && (i + 1 === text.length || /\s/.test(text[i + 1]));
    if (i < text.length && !STOP.test(text[i]) && !endsSentence) continue;
    const head = text.slice(0, i);
    if (!spaces && /\s/.test(head)) break;
    // "see server.js." ends a sentence; Windows would find "server.js." too.
    if (/\.$/.test(head) && !/(^|[\\/])\.{1,2}$/.test(head)) continue;
    const full = resolve(head, cwd);
    if (!full) continue;
    if (stat(full)) best = i;
    else if (!stat(path.dirname(full))) break;
  }
  return best;
}

// Paths in one line of terminal text that exist on this computer: [{ start, len }].
// Full paths (C:\..., ~/...) may hold spaces; relative ones must have a folder
// separator or a file extension, and are looked up from cwd.
function findPaths(line, cwd) {
  const text = String(line || '').slice(0, MAX_LINE);
  const out = [];
  let covered = 0;
  for (const m of text.matchAll(TOKEN)) {
    let start = m.index;
    let tok = m[0];
    // Update(lib/x.js), [notes.md], {x}, key=value
    const open = Math.max(tok.lastIndexOf('('), tok.lastIndexOf('['), tok.lastIndexOf('{'), tok.lastIndexOf('='));
    if (open >= 0) { start += open + 1; tok = tok.slice(open + 1); }
    if (start < covered || !tok || /:\/\//.test(tok)) continue;
    const full = /^[A-Za-z]:[\\/]/.test(tok) || /^~[\\/]/.test(tok) || (tok.startsWith('/') && process.platform !== 'win32');
    if (!full && !/[\\/]/.test(tok) && !/\.[A-Za-z0-9]{1,8}\b/.test(tok)) continue;
    const len = full ? existingLength(text.slice(start), cwd, true) : existingLength(tok, cwd, false);
    if (len) { out.push({ start, len }); covered = start + len; }
  }
  return out;
}

// Opens the folder, or the folder holding the file with the file selected.
function reveal(full) {
  const st = stat(full);
  if (!st) return false;
  const dir = st.isDirectory();
  if (process.platform === 'win32') {
    // Explorer reads its own command line; Windows paths cannot hold a quote.
    spawn('explorer.exe', [dir ? `"${full}"` : `/select,"${full}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', dir ? [full] : ['-R', full], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [dir ? full : path.dirname(full)], { detached: true, stdio: 'ignore' }).unref();
  }
  return true;
}

module.exports = { findPaths, resolve, reveal };
