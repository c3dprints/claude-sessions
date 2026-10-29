'use strict';
// Reads what Claude Code leaves on disk:
//   ~/.claude/sessions/<pid>.json        one file per running claude process (live registry)
//   ~/.claude/projects/<slug>/<id>.jsonl  the transcript of every session (titles, prompts, cwd)
// Nothing here writes to ~/.claude.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;
const PROMPT_MAX = 300;

function readRegistry(claudeDir) {
  const dir = path.join(claudeDir, 'sessions');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (Number.isInteger(r.pid) && typeof r.sessionId === 'string') out.push(r);
    } catch { /* half-written file, next poll gets it */ }
  }
  return out;
}

// PIDs of every running claude process. A registry file can outlive its process
// (crash, killed tab), and PIDs get reused, so liveness is checked against the
// image name, not just the number.
function listClaudePids() {
  const win = process.platform === 'win32';
  const [cmd, args] = win
    ? ['tasklist', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq claude.exe']]
    : ['ps', ['-axo', 'pid=,comm=']];
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(win ? parseTasklist(stdout) : parsePs(stdout));
    });
  });
}

function parseTasklist(csv) {
  const pids = new Set();
  for (const line of String(csv).split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (m && m[1].toLowerCase() === 'claude.exe') pids.add(Number(m[2]));
  }
  return pids;
}

// `ps -o comm=` gives the executable path; the native install names it claude or claude.exe.
function parsePs(text) {
  const pids = new Set();
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (m && /^claude(\.exe)?$/i.test(m[2].split('/').pop())) pids.add(Number(m[1]));
  }
  return pids;
}

function promptText(o) {
  if (!o || o.type !== 'user' || o.isSidechain || o.isMeta) return null;
  if (o.origin && o.origin.kind && o.origin.kind !== 'human') return null;
  // Headless `claude -p` runs (hooks, summarizers) are not sessions anyone sat in.
  if (o.promptSource === 'sdk' || String(o.entrypoint || '').startsWith('sdk')) return null;
  const c = o.message && o.message.content;
  let s = null;
  if (typeof c === 'string') s = c;
  else if (Array.isArray(c)) {
    const texts = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
    if (texts.length) s = texts.join(' ');
  }
  if (!s) return null;
  s = s.trim();
  if (!s || s.startsWith('<')) return null; // slash-command wrappers, reminders
  s = s.replace(/\s+/g, ' ');
  return s.length > PROMPT_MAX ? s.slice(0, PROMPT_MAX - 1) + '…' : s;
}

function parseChunk(text, atStart, acc) {
  const lines = text.split('\n');
  if (!atStart) lines.shift(); // first line is cut in half
  for (const line of lines) {
    if (!line || line[0] !== '{') continue;
    if (line.includes('"type":"ai-title"') || line.includes('"type":"custom-title"')) {
      try {
        const o = JSON.parse(line);
        if (o.type === 'ai-title' && o.aiTitle) acc.aiTitle = o.aiTitle;
        if (o.type === 'custom-title' && o.customTitle) acc.customTitle = o.customTitle;
      } catch { /* partial line */ }
    } else if (line.includes('"type":"user"')) {
      try {
        const o = JSON.parse(line);
        if (!acc.cwd && typeof o.cwd === 'string') acc.cwd = o.cwd;
        const t = promptText(o);
        if (t) {
          if (!acc.firstPrompt) acc.firstPrompt = t;
          acc.lastPrompt = t;
          acc.prompts++;
        }
      } catch { /* partial line */ }
    }
  }
}

function readSlice(fd, start, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, start);
  return buf.toString('utf8', 0, n);
}

const infoCache = new Map(); // path -> { mtimeMs, size, info }

function readTranscriptInfo(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = infoCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info;

  const acc = { aiTitle: null, customTitle: null, cwd: null, firstPrompt: null, lastPrompt: null, prompts: 0 };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    if (st.size <= HEAD_BYTES + TAIL_BYTES) {
      parseChunk(readSlice(fd, 0, st.size), true, acc);
    } else {
      const head = { ...acc };
      parseChunk(readSlice(fd, 0, HEAD_BYTES), true, head);
      parseChunk(readSlice(fd, st.size - TAIL_BYTES, TAIL_BYTES), false, acc);
      acc.cwd = acc.cwd || head.cwd;
      acc.firstPrompt = head.firstPrompt || acc.firstPrompt;
      acc.aiTitle = acc.aiTitle || head.aiTitle;
      acc.customTitle = acc.customTitle || head.customTitle;
      acc.lastPrompt = acc.lastPrompt || head.lastPrompt;
      acc.prompts += head.prompts; // a lower bound once the middle is skipped
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const info = {
    title: acc.customTitle || acc.aiTitle || null,
    cwd: acc.cwd,
    firstPrompt: acc.firstPrompt,
    lastPrompt: acc.lastPrompt,
    hasPrompts: acc.prompts > 0,
    lastActivity: st.mtimeMs,
    size: st.size,
  };
  infoCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info });
  return info;
}

function projectDirs(claudeDir) {
  const root = path.join(claudeDir, 'projects');
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
  } catch { return []; }
}

const transcriptPathCache = new Map();

function findTranscript(claudeDir, sessionId) {
  if (!UUID_RE.test(sessionId)) return null;
  const cached = transcriptPathCache.get(sessionId);
  if (cached && fs.existsSync(cached)) return cached;
  for (const d of projectDirs(claudeDir)) {
    const p = path.join(d, sessionId + '.jsonl');
    if (fs.existsSync(p)) { transcriptPathCache.set(sessionId, p); return p; }
  }
  return null;
}

// Live sessions: registry entries whose PID is a running claude process.
// pids === null means tasklist failed; then trust the registry rather than show nothing.
function liveSessions(claudeDir, pids) {
  const out = [];
  for (const r of readRegistry(claudeDir)) {
    if (pids && !pids.has(r.pid)) continue;
    const file = findTranscript(claudeDir, r.sessionId);
    const info = file ? readTranscriptInfo(file) : null;
    out.push({
      pid: r.pid,
      sessionId: r.sessionId,
      cwd: r.cwd || (info && info.cwd) || null,
      name: r.name || null,
      kind: r.kind || 'interactive',
      status: r.status || 'unknown',
      statusSince: r.statusUpdatedAt || r.updatedAt || r.startedAt || null,
      startedAt: r.startedAt || null,
      version: r.version || null,
      title: info ? info.title : null,
      firstPrompt: info ? info.firstPrompt : null,
      lastPrompt: info ? info.lastPrompt : null,
      lastActivity: info ? info.lastActivity : (r.updatedAt || null),
    });
  }
  out.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  return out;
}

// Past sessions from transcripts, newest first. Skips sessions with no typed
// prompt (headless runs, hook-spawned sessions) since there is nothing to go back to.
// Sessions in `keep` (put in a project) are listed whatever their age and do not count toward the limit.
function history(claudeDir, { excludeIds = new Set(), days = 14, limit = 60, keep = new Set() } = {}) {
  const cutoff = Date.now() - days * 86400000;
  const files = [];
  for (const d of projectDirs(claudeDir)) {
    let names;
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const id = n.slice(0, -6);
      if (!UUID_RE.test(id) || excludeIds.has(id)) continue;
      const p = path.join(d, n);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs >= cutoff || keep.has(id)) files.push({ id, p, mtimeMs: st.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  let counted = 0;
  for (const f of files) {
    const kept = keep.has(f.id);
    if (counted >= limit && !kept) continue;
    const info = readTranscriptInfo(f.p);
    if (!info || !info.hasPrompts) continue;
    if (!kept) counted++;
    out.push({
      sessionId: f.id,
      cwd: info.cwd,
      title: info.title,
      firstPrompt: info.firstPrompt,
      lastPrompt: info.lastPrompt,
      lastActivity: info.lastActivity,
    });
  }
  return out;
}

function lookup(claudeDir, sessionId) {
  const file = findTranscript(claudeDir, sessionId);
  if (!file) return null;
  const info = readTranscriptInfo(file);
  return info ? { sessionId, ...info } : null;
}

module.exports = {
  UUID_RE, readRegistry, listClaudePids, parseTasklist, parsePs, promptText,
  readTranscriptInfo, findTranscript, liveSessions, history, lookup,
};
