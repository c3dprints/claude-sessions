'use strict';
// Plan usage and context windows.
//
// Plan usage (the 5-hour and weekly limits) only reaches Claude Code's status
// line, so the app can install scripts/statusline.js as the status line. That
// script saves data/status/usage.json and data/status/<sessionId>.json. This is
// the only place the app writes to ~/.claude: the statusLine entry in
// settings.json, and only when the user turns it on.
//
// Context use is read from the transcripts: every assistant message records
// the tokens it was sent, so the last one is how full the window is now and
// the first one is roughly what a fresh session costs before any work.

const fs = require('fs');
const path = require('path');
const { readJson, tokens, slugOf, home } = require('./library');

const MARK = 'claude-sessions-statusline';
const HEAD_BYTES = 256 * 1024;
const HEAD_MAX = 8 * 1024 * 1024;
const TAIL_BYTES = 512 * 1024;
const MEMORY_LINES = 200; // Claude Code loads the first 200 lines of MEMORY.md

// ---- status line ---------------------------------------------------------------

function settingsFile(claudeDir) {
  return path.join(claudeDir, 'settings.json');
}

function scriptTarget(dataDir) {
  return path.join(dataDir, 'statusline.js');
}

// Forward slashes and no quotes: the command then works in Git Bash, cmd and
// PowerShell alike. The trailing flag marks the entry as ours.
function commandFor(dataDir) {
  return `node ${scriptTarget(dataDir).replace(/\\/g, '/')} --${MARK}`;
}

function statusLineState(claudeDir) {
  const s = readJson(settingsFile(claudeDir)) || {};
  const sl = s.statusLine;
  if (!sl) return { enabled: false, other: null };
  const cmd = String(sl.command || '');
  if (cmd.includes(MARK)) return { enabled: true, other: null };
  return { enabled: false, other: cmd || 'a status line' };
}

function writeSettings(file, s) {
  const tmp = file + '.claude-sessions.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function installScript(dataDir, appDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const src = fs.readFileSync(path.join(appDir, 'scripts', 'statusline.js'));
  const dst = scriptTarget(dataDir);
  let old = null;
  try { old = fs.readFileSync(dst); } catch { /* first install */ }
  if (!old || !old.equals(src)) fs.writeFileSync(dst, src);
}

// Copy the script beside the app's data (so its path never changes) and point Claude Code at it.
function enableStatusLine(claudeDir, dataDir, appDir) {
  const file = settingsFile(claudeDir);
  let s = {};
  if (fs.existsSync(file)) {
    s = readJson(file);
    if (!s) throw Object.assign(new Error('~/.claude/settings.json could not be read, so it was left alone'), { code: 409 });
  }
  if (s.statusLine && !String(s.statusLine.command || '').includes(MARK)) {
    throw Object.assign(new Error('Claude Code already has its own status line; remove it first to use this'), { code: 409 });
  }
  installScript(dataDir, appDir);
  s.statusLine = { type: 'command', command: commandFor(dataDir), padding: 0 };
  writeSettings(file, s);
}

function disableStatusLine(claudeDir) {
  const file = settingsFile(claudeDir);
  const s = readJson(file);
  if (!s || !s.statusLine || !String(s.statusLine.command || '').includes(MARK)) return;
  delete s.statusLine;
  writeSettings(file, s);
}

// ---- plan usage ------------------------------------------------------------------

function limitWindow(w, now) {
  if (!w || typeof w.used_percentage !== 'number') return null;
  const resetsAt = w.resets_at ? w.resets_at * 1000 : null;
  // Past its reset time the window has started over; the old number means nothing.
  if (resetsAt && resetsAt < now) return null;
  return { pct: w.used_percentage, resetsAt };
}

function planUsage(claudeDir, dataDir, now = Date.now()) {
  const sl = statusLineState(claudeDir);
  const saved = readJson(path.join(dataDir, 'status', 'usage.json'));
  const rl = (saved && saved.rate_limits) || {};
  return {
    statusLine: sl.enabled,
    otherStatusLine: sl.other,
    at: saved ? saved.at : null,
    fiveHour: limitWindow(rl.five_hour, now),
    sevenDay: limitWindow(rl.seven_day, now),
  };
}

// ---- context ---------------------------------------------------------------------

function readSlice(fd, start, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, start);
  return buf.toString('utf8', 0, n);
}

function usageOf(line) {
  if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (o.type !== 'assistant' || o.isSidechain || !o.message || !o.message.usage) return null;
  const u = o.message.usage;
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  // Synthetic messages (errors, interruptions) record zero usage.
  if (!input) return null;
  return { input, output: u.output_tokens || 0, model: o.message.model || null, at: Date.parse(o.timestamp) || null };
}

const usageCache = new Map(); // file -> { mtimeMs, size, value }

// First and last real API call of a transcript, and how often it was compacted (in the tail).
function transcriptUsage(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = usageCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  let first = null;
  let last = null;
  let compactions = 0;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    // Snapshots and pasted files can push the first reply a few MB in.
    let carry = '';
    for (let pos = 0; !first && pos < Math.min(st.size, HEAD_MAX); pos += HEAD_BYTES) {
      const lines = (carry + readSlice(fd, pos, Math.min(HEAD_BYTES, st.size - pos))).split('\n');
      carry = lines.pop();
      for (const line of lines) { first = usageOf(line); if (first) break; }
    }
    const start = Math.max(0, st.size - TAIL_BYTES);
    const tail = readSlice(fd, start, st.size - start).split('\n');
    if (start > 0) tail.shift(); // cut in half
    for (const line of tail) {
      const u = usageOf(line);
      if (u) last = u;
      if (line.includes('"subtype":"compact_boundary"')) compactions++;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const value = first || last ? { first: first || last, last: last || first, compactions } : null;
  usageCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

function fileTokens(file, maxLines) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (maxLines) text = text.split('\n').slice(0, maxLines).join('\n');
  return { path: file, label: home(file), tokens: tokens(text.length) };
}

// The CLAUDE.md files and auto memory Claude Code loads for a folder.
function memoryFiles(claudeDir, cwd) {
  const out = [];
  const add = (f, maxLines) => { const t = fileTokens(f, maxLines); if (t) out.push(t); };
  add(path.join(claudeDir, 'CLAUDE.md'));
  if (cwd) {
    const chain = [];
    for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
      chain.unshift(d);
      if (path.dirname(d) === d) break;
    }
    for (const d of chain) {
      add(path.join(d, 'CLAUDE.md'));
      add(path.join(d, '.claude', 'CLAUDE.md'));
      add(path.join(d, 'CLAUDE.local.md'));
    }
    add(path.join(claudeDir, 'projects', slugOf(cwd), 'memory', 'MEMORY.md'), MEMORY_LINES);
  }
  const seen = new Set();
  return out.filter((f) => (seen.has(f.path.toLowerCase()) ? false : seen.add(f.path.toLowerCase())));
}

function compactLimit(claudeDir, model) {
  const s = readJson(settingsFile(claudeDir)) || {};
  const per = (s.modelSettings && model && s.modelSettings[model]) || {};
  return per.autoCompactWindow || s.autoCompactWindow || null;
}

// How full one session's context window is, split the way /context splits it.
// The total is exact. The startup cost is the first reply's input; only the
// memory files inside it can be measured from here.
function contextFor({ claudeDir, dataDir, sessionId, transcript, cwd }) {
  const u = transcript ? transcriptUsage(transcript) : null;
  const st = readJson(path.join(dataDir, 'status', `${sessionId}.json`));
  const cw = (st && st.context_window) || {};
  const cu = cw.current_usage;
  if (!u && !cu) return { sessionId, available: false };

  const used = u ? u.last.input : (cu.input_tokens || 0) + (cu.cache_creation_input_tokens || 0) + (cu.cache_read_input_tokens || 0);
  const model = (u && u.last.model) || (st && st.model && st.model.id) || null;
  const compactAt = compactLimit(claudeDir, model);
  // The status line knows the real window. Without it: a session past 200k, or
  // set to compact past 200k, must be on a 1M model.
  const size = cw.context_window_size || (/\[1m\]/i.test(model || '') || used > 200000 || compactAt > 200000 ? 1000000 : 200000);
  const startup = u ? Math.min(u.first.input, used) : used;
  const memory = memoryFiles(claudeDir, cwd);
  const mem = Math.min(memory.reduce((n, f) => n + f.tokens, 0), startup);
  const shrank = u && u.last.input < u.first.input;
  const parts = [
    { key: 'system', label: 'System prompt, tools and skills', tokens: startup - mem, note: 'What a session starts with: Claude Code itself, built-in and MCP tools, agents and the skills list' },
    { key: 'memory', label: 'Memory files', tokens: mem, note: 'CLAUDE.md files and auto memory (estimated at 4 characters per token)', estimate: true },
    { key: 'messages', label: 'Conversation', tokens: used - startup, note: shrank ? 'Just after /compact or /clear' : 'Prompts, replies, tool calls and their output' + (u && u.compactions ? ', including the compact summary' : '') },
  ];
  return {
    sessionId,
    available: true,
    sizeKnown: !!cw.context_window_size,
    model: (st && st.model && st.model.display_name) || model,
    used,
    size,
    pct: (used / size) * 100,
    compactAt,
    compactions: u ? u.compactions : 0,
    at: Math.max((u && u.last.at) || 0, (st && st.at) || 0) || null,
    cost: st && st.cost && typeof st.cost.total_cost_usd === 'number' ? st.cost.total_cost_usd : null,
    parts,
    memory,
  };
}

// Status files of sessions long gone are of no use to anyone.
function pruneStatus(dataDir, maxAgeMs = 14 * 86400000, now = Date.now()) {
  const dir = path.join(dataDir, 'status');
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (n === 'usage.json') continue;
    const f = path.join(dir, n);
    try { if (now - fs.statSync(f).mtimeMs > maxAgeMs) fs.unlinkSync(f); } catch { /* in use */ }
  }
}

module.exports = {
  MARK, commandFor, statusLineState, enableStatusLine, disableStatusLine, installScript,
  planUsage, transcriptUsage, memoryFiles, contextFor, pruneStatus,
};
