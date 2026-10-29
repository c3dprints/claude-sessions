'use strict';
// Claude Sessions: a local dashboard of every Claude Code terminal session,
// with built-in terminals for sessions started from the app.
// Zero dependencies. Listens on 127.0.0.1; it runs terminals, so it is never exposed
// to the network. Phone access (off by default) adds a second listener on this PC's
// Tailscale address only, and every request there needs a paired device's cookie.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const pkg = require('./package.json');
const sessions = require('./lib/sessions');
const terminal = require('./lib/terminal');
const updater = require('./lib/updater');
const startup = require('./lib/startup');
const library = require('./lib/library');
const usage = require('./lib/usage');
const { Store, projectOf } = require('./lib/store');
const { HostClient } = require('./lib/hostclient');
const platform = require('./lib/platform');
const remoteLib = require('./lib/remote');
const { giveWindowIcon } = require('./lib/windowicon');

const PORT = Number(process.env.CS_PORT || 8930);
const HOST = '127.0.0.1';
const APP_DIR = __dirname;
const CLAUDE_DIR = process.env.CS_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const DATA_DIR = platform.dataDir();
const POLL_MS = 3000;
const UPDATE_EVERY_MS = 6 * 3600000;
const HISTORY_TTL_MS = 15000;
const MAX_BODY = 256 * 1024; // pastes into a terminal can be large
// Tests pass a fixed pid list instead of asking tasklist, switch off Windows
// Terminal actions, and may replace the claude command with a harmless one.
const FAKE_PIDS = process.env.CS_FAKE_PIDS !== undefined
  ? new Set(process.env.CS_FAKE_PIDS.split(',').filter(Boolean).map(Number)) : null;
const TEST_MODE = process.env.CS_TEST === '1';

const store = new Store(DATA_DIR);
const remote = new remoteLib.Remote(DATA_DIR);
// Tests point phone access at a spare loopback address instead of asking Tailscale.
const REMOTE_IP_OVERRIDE = process.env.CS_REMOTE_IP || null;
const host = new HostClient({ dataDir: DATA_DIR, pipe: process.env.CS_HOST_PIPE });
const LOG = path.join(DATA_DIR, 'server.log');

function log(msg) {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1024 * 1024) fs.renameSync(LOG, LOG + '.1');
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* logging must never take the server down */ }
}

// ---- live state ------------------------------------------------------------

let live = [];
let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const pids = FAKE_PIDS || await sessions.listClaudePids();
    live = sessions.liveSessions(CLAUDE_DIR, pids);
    // Without a trustworthy pid list every session would look closed, so skip tracking.
    if (pids) store.observe(live);
  } catch (e) {
    log(`poll failed: ${e.stack || e}`);
  } finally {
    polling = false;
  }
}

let historyCache = { at: 0, key: '', items: [] };

// Sessions put in a project by hand stay listed past the 14 days, so a project keeps them together.
function keptIds() {
  return new Set(Object.entries(store.state.assign).filter(([, p]) => p !== 'none').map(([id]) => id));
}

function getHistory(excludeIds) {
  const keep = keptIds();
  const key = [...excludeIds].sort().join(',') + '|' + [...keep].sort().join(',');
  if (Date.now() - historyCache.at < HISTORY_TTL_MS && historyCache.key === key) return historyCache.items;
  historyCache = { at: Date.now(), key, items: sessions.history(CLAUDE_DIR, { excludeIds, keep }) };
  return historyCache.items;
}

// In-app terminals, joined to the Claude session running inside each (by process id).
function appTerminals() {
  return host.list().map((t) => {
    const s = t.pid ? live.find((x) => x.pid === t.pid) : null;
    return { ...t, sessionId: s ? s.sessionId : null };
  });
}

function snapshot() {
  const nick = store.state.nicknames;
  const terms = appTerminals();
  const appByPid = new Map(terms.filter((t) => t.pid && !t.exited).map((t) => [t.pid, t.id]));
  const liveIds = new Set(live.map((s) => s.sessionId));
  const closed = store.state.closed.filter((c) => !liveIds.has(c.sessionId));
  const closedIds = new Set(closed.map((c) => c.sessionId));
  const history = getHistory(new Set([...liveIds, ...closedIds]));
  const withNick = (s) => ({ ...s, nickname: nick[s.sessionId] || null, project: projectOf(store.state, s) });
  return {
    app: { name: 'Claude Sessions', version: pkg.version, platform: process.platform },
    now: Date.now(),
    live: live.map((s) => ({ ...withNick(s), appId: appByPid.get(s.pid) || null, context: contextBrief(s) })),
    closed: closed.map(withNick),
    history: history.map(withNick),
    folders: recentFolders([...live, ...closed, ...history]).slice(0, 12),
    projects: store.state.projects,
    terminals: { up: host.up, outdated: host.outdated, error: host.error, list: terms },
    usage: usage.planUsage(CLAUDE_DIR, DATA_DIR),
    update: { ...updateStatus(), busy: updateBusy },
    settings: {
      autoUpdate: !!store.state.settings.autoUpdate,
      startWithWindows: startup.isEnabled(),
      wikiDirs: store.state.settings.wikiDirs,
      theme: store.state.settings.theme || 'system',
      terminal: store.state.settings.terminal || null,
      remote: !!store.state.settings.remote,
    },
  };
}

// Terminal look: a preset name, three colors and a font size. null means the default look.
const HEX = /^#[0-9a-f]{6}$/i;
function checkTerminalLook(t) {
  if (t === null) return null;
  if (!t || typeof t !== 'object') throw fail(400, 'bad terminal settings');
  const out = {
    preset: typeof t.preset === 'string' && /^[a-z0-9-]{1,24}$/.test(t.preset) ? t.preset : 'custom',
    fontSize: Number.isInteger(t.fontSize) && t.fontSize >= 10 && t.fontSize <= 24 ? t.fontSize : 13,
  };
  for (const k of ['background', 'foreground', 'cursor']) {
    if (!HEX.test(String(t[k]))) throw fail(400, `terminal ${k} must be a color like #1e1e1e`);
    out[k] = t[k].toLowerCase();
  }
  return out;
}

function recentFolders(list) {
  const folders = [];
  for (const s of list) {
    if (s.cwd && !folders.includes(s.cwd) && !/\\AppData\\Local\\Temp\\claude\\/i.test(s.cwd)) folders.push(s.cwd);
  }
  return folders;
}

// ---- wiki, skills, context -------------------------------------------------------

function cached(ms, fn) {
  let at = 0;
  let value = null;
  let pending = null;
  const get = async () => {
    if (value && Date.now() - at < ms) return value;
    if (!pending) {
      pending = Promise.resolve().then(fn)
        .then((v) => { value = v; at = Date.now(); return v; })
        .finally(() => { pending = null; });
    }
    return pending;
  };
  get.clear = () => { at = 0; };
  return get;
}

// Folders whose .claude holds project skills: project folders and recent session folders.
function knownProjectFolders() {
  const out = new Set();
  for (const p of store.state.projects) for (const f of p.folders) out.add(f);
  for (const f of recentFolders([...live, ...store.state.closed])) out.add(f);
  return [...out];
}

const wikiCache = cached(20000, () => library.wiki({
  claudeDir: CLAUDE_DIR,
  wikiDirs: store.state.settings.wikiDirs,
  folders: [os.homedir(), ...knownProjectFolders()],
}));
const allCache = cached(30000, () => sessions.history(CLAUDE_DIR, { days: 36500, limit: 2000 }));
const skillsCache = cached(30000, () => library.skills({ claudeDir: CLAUDE_DIR, folders: knownProjectFolders() }));

function contextBrief(s) {
  try {
    const c = usage.contextFor({ claudeDir: CLAUDE_DIR, dataDir: DATA_DIR, sessionId: s.sessionId, transcript: sessions.findTranscript(CLAUDE_DIR, s.sessionId), cwd: null });
    return c.available ? { pct: c.pct, used: c.used, size: c.size } : null;
  } catch { return null; }
}

function contextOf(s) {
  return {
    ...usage.contextFor({
      claudeDir: CLAUDE_DIR, dataDir: DATA_DIR, sessionId: s.sessionId,
      transcript: sessions.findTranscript(CLAUDE_DIR, s.sessionId), cwd: s.cwd,
    }),
    title: store.state.nicknames[s.sessionId] || s.title || s.firstPrompt || s.name || null,
    cwd: s.cwd,
    status: s.status || null,
    live: live.includes(s),
  };
}

function checkProject(b) {
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) throw fail(400, 'give the project a name');
  if (!PROJECT_COLORS.includes(b.color)) throw fail(400, 'pick one of the colors');
  if (!Array.isArray(b.folders) || b.folders.length > 10) throw fail(400, 'folders must be a list of up to 10');
  const folders = [];
  for (const f of b.folders) {
    let dir;
    try { dir = terminal.checkDir(String(f).trim()); } catch (e) { throw fail(400, e.message); }
    if (!folders.some((x) => x.toLowerCase() === dir.toLowerCase())) folders.push(dir);
  }
  return { name, color: b.color, folders };
}

const PROJECT_COLORS = ['#d97757', '#5b9cf6', '#4fbf8a', '#e8b04b', '#b07ce8', '#e86fa5', '#4cc3c9', '#8d95a5'];

// ---- terminals ---------------------------------------------------------------

let claudeExePath = null;

// On macOS the app may be started from Finder with a bare PATH, so the usual
// install folders are checked too; the bridge's login shell finds anything else.
function claudeExe() {
  if (claudeExePath && fs.existsSync(claudeExePath)) return claudeExePath;
  const home = os.homedir();
  const dirs = platform.WIN
    ? [path.join(home, '.local', 'bin'), ...String(process.env.PATH || '').split(';')]
    : [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.npm-global', 'bin'),
      '/opt/homebrew/bin', '/usr/local/bin', ...String(process.env.PATH || '').split(':')];
  const name = platform.WIN ? 'claude.exe' : 'claude';
  claudeExePath = dirs.filter(Boolean).map((d) => path.join(d, name)).find((p) => fs.existsSync(p)) || null;
  if (!claudeExePath && platform.WIN) throw fail(500, 'claude.exe was not found (looked in ~/.local/bin and PATH)');
  return claudeExePath;
}

function claudeCommand(resumeId) {
  if (TEST_MODE && process.env.CS_CLAUDE_CMD) return process.env.CS_CLAUDE_CMD;
  const exe = claudeExe();
  const cmd = platform.WIN ? `"${exe}"` : exe ? terminal.shQuote(exe) : 'claude';
  return cmd + (resumeId ? ` --resume ${resumeId}` : '');
}

function size(b) {
  return {
    cols: Number.isInteger(b.cols) ? b.cols : 120,
    rows: Number.isInteger(b.rows) ? b.rows : 32,
  };
}

async function startTerminal(cwd, resumeId, b) {
  const dir = terminal.checkDir(cwd);
  if (resumeId !== undefined && !sessions.UUID_RE.test(String(resumeId))) throw fail(400, 'bad session id');
  await host.ensure();
  const r = await host.request({ t: 'spawn', cwd: dir, command: claudeCommand(resumeId), resumeId: resumeId || null, ...size(b) });
  log(`terminal ${r.session.id} started in ${dir}${resumeId ? ' resuming ' + resumeId : ''}`);
  return { ok: true, id: r.session.id };
}

function cwdForResume(sessionId) {
  const closed = store.state.closed.find((c) => c.sessionId === sessionId);
  const info = sessions.lookup(CLAUDE_DIR, sessionId);
  const cwd = (closed && closed.cwd) || (info && info.cwd);
  if (!cwd) throw fail(404, 'no folder recorded for that session');
  return cwd;
}

function processGone(pid, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      try { process.kill(pid, 0); } catch { return resolve(true); }
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 200);
    };
    tick();
  });
}

// One event stream per open dashboard window carries every terminal's output.
const streams = new Set();

function sse(res, msg) {
  res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

function replayAll(client) {
  for (const t of host.list()) {
    client.pending.add(t.id);
    // Synchronous with the pipe: outs that arrive after this reply are not in it.
    host.call({ t: 'replay', id: t.id }, (r) => {
      client.pending.delete(t.id);
      if (!client.res.writableEnded) sse(client.res, { t: 'replay', id: t.id, data: r.ok ? r.data : '' });
    });
  }
}

host.on('event', (msg) => {
  for (const c of streams) {
    if (msg.t === 'out' && c.pending.has(msg.id)) continue;
    sse(c.res, msg);
  }
});
host.on('up', () => {
  for (const c of streams) { sse(c.res, { t: 'host', up: true }); replayAll(c); }
});
host.on('down', () => {
  for (const c of streams) sse(c.res, { t: 'host', up: false });
});

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });
  const client = { res, pending: new Set() };
  streams.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); streams.delete(client); });
  sse(res, { t: 'host', up: host.up });
  if (host.up) replayAll(client);
  else host.ensure().catch((e) => sse(res, { t: 'host', up: false, error: e.message }));
}

function termOf(id) {
  const t = host.list().find((x) => x.id === id);
  if (!t) throw fail(404, 'no such terminal');
  return t;
}

// ---- updates -----------------------------------------------------------------

let updateBusy = false;
let lastWindowIcon = 0;

// The saved result predates any restart, so "available" is re-judged against the running version.
function updateStatus() {
  const u = { ...store.state.update, current: pkg.version };
  let newer = false;
  try { newer = !!u.latest && updater.compare(u.latest, pkg.version) > 0; } catch { /* bad saved tag */ }
  u.available = !!u.available && newer;
  return u;
}

async function checkForUpdate() {
  if (updateBusy) return store.state.update;
  updateBusy = true;
  try {
    store.state.update = { ...(await updater.check(APP_DIR, pkg.version)), checkedAt: Date.now() };
  } catch (e) {
    store.state.update = { current: pkg.version, available: false, error: e.message, checkedAt: Date.now() };
  } finally {
    updateBusy = false;
  }
  store.save();
  if (store.state.update.available && store.state.settings.autoUpdate && store.state.update.mode === 'release') {
    installUpdate(store.state.update.latest).catch((e) => log(`auto update failed: ${e.message}`));
  }
  return store.state.update;
}

async function installUpdate(tag) {
  if (updateBusy) throw new Error('an update is already running');
  updateBusy = true;
  try {
    await updater.install(APP_DIR, tag);
    log(`installed ${tag}, restarting`);
    restart();
  } finally {
    updateBusy = false;
  }
}

// Only the dashboard restarts; terminals live in the session host and keep running.
// The new process waits for the port in listen(), so it is safe to start it first.
function restart() {
  const child = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], {
    cwd: APP_DIR, detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
  });
  child.unref();
  setTimeout(() => process.exit(0), 300);
}

// ---- http --------------------------------------------------------------------

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

// Any web page can fire requests at localhost. The Host check stops DNS
// rebinding; Sec-Fetch-Site and Origin keep other sites off the API (opening
// the page itself from a link is fine); the custom header on POST forces a
// CORS preflight we never answer.
function guard(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return 'bad host';
  const site = req.headers['sec-fetch-site'];
  if (req.url.startsWith('/api/') && site && site !== 'same-origin' && site !== 'none') return 'cross-site request';
  const o = req.headers.origin;
  if (o && !ALLOWED_ORIGINS.has(o)) return 'bad origin';
  if (req.method === 'POST' && req.headers['x-claude-sessions'] !== '1') return 'missing header';
  return null;
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(Object.assign(new Error('body too large'), { code: 413 }));
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('bad json'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function knownFolder(cwd) {
  return snapshot().folders.includes(cwd) || store.state.projects.some((p) => p.folders.includes(cwd));
}

const routes = {
  'GET /api/ping': () => ({ ok: true, app: 'claude-sessions', version: pkg.version }),
  'GET /api/state': () => snapshot(),

  'POST /api/focus': async (b) => {
    const s = live.find((x) => x.sessionId === b.sessionId);
    if (!s) throw fail(404, 'that session is not open');
    if (TEST_MODE) return { ok: true, test: true };
    const r = await terminal.focus(s.pid, s.title);
    if (!r.ok) throw fail(500, r.error || 'could not find the window');
    return r;
  },

  // Reopen a closed or past session. Default is an in-app terminal; where:'terminal' uses Windows Terminal.
  'POST /api/resume': async (b) => {
    if (!sessions.UUID_RE.test(String(b.sessionId))) throw fail(400, 'bad session id');
    if (live.some((x) => x.sessionId === b.sessionId)) throw fail(409, 'already open');
    const cwd = cwdForResume(b.sessionId);
    if (b.where === 'terminal') {
      const args = terminal.claudeTabArgs(cwd, b.sessionId); // validates before anything runs
      if (TEST_MODE) return { ok: true, test: true, args };
      terminal.resume(cwd, b.sessionId);
      log(`reopened ${b.sessionId} in Windows Terminal, ${cwd}`);
      return { ok: true };
    }
    return startTerminal(cwd, b.sessionId, b);
  },

  'POST /api/new': async (b) => {
    if (!knownFolder(b.cwd)) throw fail(400, 'pick a folder from the list');
    if (b.where === 'terminal') {
      const args = terminal.claudeTabArgs(b.cwd);
      if (TEST_MODE) return { ok: true, test: true, args };
      terminal.newSession(b.cwd);
      return { ok: true };
    }
    return startTerminal(b.cwd, undefined, b);
  },

  // Bring a Windows Terminal session into the app: end it there, resume it here.
  // Only while idle, so no running work or open permission prompt is cut off.
  'POST /api/move': async (b) => {
    const s = live.find((x) => x.sessionId === b.sessionId);
    if (!s) throw fail(404, 'that session is not open');
    if (appTerminals().some((t) => t.pid === s.pid && !t.exited)) throw fail(409, 'already in the app');
    if (s.status !== 'idle') throw fail(409, 'wait until it is idle, then move it');
    if (!TEST_MODE) {
      if (platform.WIN) {
        await new Promise((resolve) => execFile('taskkill', ['/PID', String(s.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
      } else {
        try { process.kill(s.pid, 'SIGTERM'); } catch { /* already gone */ }
        if (!(await processGone(s.pid, 5000))) try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone */ }
      }
      if (!(await processGone(s.pid, 8000))) throw fail(500, `the session did not close in ${platform.WIN ? 'Windows Terminal' : 'Terminal'}`);
      live = live.filter((x) => x.pid !== s.pid);
    }
    log(`moving ${s.sessionId} from Windows Terminal into the app`);
    return startTerminal(s.cwd, s.sessionId, b);
  },

  'POST /api/term/input': async (b) => {
    const t = termOf(b.id);
    if (typeof b.data !== 'string') throw fail(400, 'data must be text');
    if (t.exited) throw fail(409, 'that session has ended');
    await host.request({ t: 'input', id: t.id, data: b.data });
    return { ok: true };
  },

  'POST /api/term/resize': async (b) => {
    const t = termOf(b.id);
    if (!Number.isInteger(b.cols) || !Number.isInteger(b.rows)) throw fail(400, 'cols and rows must be whole numbers');
    await host.request({ t: 'resize', id: t.id, cols: b.cols, rows: b.rows });
    return { ok: true };
  },

  'POST /api/term/kill': async (b) => {
    const t = termOf(b.id);
    await host.request({ t: 'kill', id: t.id });
    log(`terminal ${t.id} ended from the dashboard`);
    return { ok: true };
  },

  'POST /api/term/forget': async (b) => {
    const t = termOf(b.id);
    await host.request({ t: 'forget', id: t.id });
    host.sessions.delete(t.id);
    return { ok: true };
  },

  'POST /api/rename': async (b) => {
    if (!sessions.UUID_RE.test(String(b.sessionId))) throw fail(400, 'bad session id');
    const name = String(b.name || '').trim().slice(0, 80);
    if (name) store.state.nicknames[b.sessionId] = name;
    else delete store.state.nicknames[b.sessionId];
    store.save();
    return { ok: true };
  },

  'POST /api/closed/dismiss': async (b) => {
    store.state.closed = store.state.closed.filter((c) => c.sessionId !== b.sessionId);
    store.save();
    return { ok: true };
  },

  // ---- projects
  'POST /api/projects/save': async (b) => {
    const p = checkProject(b);
    if (b.id) {
      const old = store.state.projects.find((x) => x.id === b.id);
      if (!old) throw fail(404, 'no such project');
      Object.assign(old, p);
    } else {
      if (store.state.projects.length >= 50) throw fail(400, 'that is a lot of projects; delete one first');
      store.state.projects.push({ id: crypto.randomUUID(), ...p });
    }
    store.save();
    skillsCache.clear();
    return { ok: true, id: b.id || store.state.projects[store.state.projects.length - 1].id };
  },

  'POST /api/projects/delete': async (b) => {
    if (!store.state.projects.some((p) => p.id === b.id)) throw fail(404, 'no such project');
    store.state.projects = store.state.projects.filter((p) => p.id !== b.id);
    for (const [sid, pid] of Object.entries(store.state.assign)) if (pid === b.id) delete store.state.assign[sid];
    store.save();
    return { ok: true };
  },

  // sessionId or sessionIds (many at once); projectId: a project, 'none' (keep
  // them out of every project), or null (their folder decides again)
  'POST /api/projects/assign': async (b) => {
    const ids = Array.isArray(b.sessionIds) ? b.sessionIds : [b.sessionId];
    if (!ids.length || ids.length > 1000 || !ids.every((id) => sessions.UUID_RE.test(String(id)))) throw fail(400, 'bad session id');
    const clear = b.projectId === null || b.projectId === undefined;
    if (!clear && b.projectId !== 'none' && !store.state.projects.some((p) => p.id === b.projectId)) throw fail(404, 'no such project');
    for (const id of ids) {
      if (clear) delete store.state.assign[id];
      else store.state.assign[id] = b.projectId;
    }
    store.save();
    allCache.clear();
    return { ok: true, count: ids.length };
  },

  // Every session there is (open, closed and every saved transcript), for picking ones to put in a project.
  'GET /api/sessions/all': async () => {
    const nick = store.state.nicknames;
    const liveIds = new Set(live.map((s) => s.sessionId));
    const closed = store.state.closed.filter((c) => !liveIds.has(c.sessionId));
    const seen = new Set([...liveIds, ...closed.map((c) => c.sessionId)]);
    const past = (await allCache()).filter((h) => !seen.has(h.sessionId));
    const row = (s, state) => ({
      sessionId: s.sessionId, state, cwd: s.cwd, title: s.title || null, firstPrompt: s.firstPrompt || null, lastPrompt: s.lastPrompt || null,
      nickname: nick[s.sessionId] || null, when: state === 'open' ? s.lastActivity || s.startedAt : state === 'closed' ? s.closedAt : s.lastActivity,
      project: projectOf(store.state, s), picked: store.state.assign[s.sessionId] || null,
    });
    return { sessions: [...live.map((s) => row(s, 'open')), ...closed.map((s) => row(s, 'closed')), ...past.map((s) => row(s, 'past'))] };
  },

  // ---- wiki, skills, context, plan usage
  'GET /api/wiki': async (b, url) => {
    if (url.searchParams.get('fresh')) wikiCache.clear();
    return { groups: await wikiCache() };
  },

  'GET /api/skills': async () => ({ skills: (await skillsCache()).map(({ file, ...s }) => ({ ...s, where: library.home(file) })) }),

  'GET /api/skills/file': async (b, url) => {
    const s = (await skillsCache()).find((x) => x.id === url.searchParams.get('id'));
    if (!s) throw fail(404, 'no such skill');
    let text;
    try { text = fs.readFileSync(s.file, 'utf8'); } catch { throw fail(404, 'the file is gone'); }
    return { id: s.id, text: library.frontmatter(text).body, where: library.home(s.file) };
  },

  'GET /api/context': async (b, url) => {
    const id = url.searchParams.get('id');
    if (id) {
      if (!sessions.UUID_RE.test(id)) throw fail(400, 'bad session id');
      const s = live.find((x) => x.sessionId === id) || sessions.lookup(CLAUDE_DIR, id);
      if (!s) throw fail(404, 'no such session');
      return { sessions: [contextOf(s)] };
    }
    return { sessions: live.map(contextOf) };
  },

  'POST /api/usage/statusline': async (b) => {
    if (b.on) usage.enableStatusLine(CLAUDE_DIR, DATA_DIR, APP_DIR);
    else usage.disableStatusLine(CLAUDE_DIR);
    log(`status line ${b.on ? 'turned on' : 'turned off'}`);
    return usage.planUsage(CLAUDE_DIR, DATA_DIR);
  },

  'POST /api/settings': async (b) => {
    if (Array.isArray(b.wikiDirs)) {
      const dirs = b.wikiDirs.map((d) => String(d).trim()).filter(Boolean).slice(0, 5);
      if (dirs.some((d) => !path.isAbsolute(d))) throw fail(400, 'wiki folders must be full paths');
      store.state.settings.wikiDirs = dirs;
      wikiCache.clear();
    }
    if (b.theme !== undefined) {
      if (!['system', 'dark', 'light'].includes(b.theme)) throw fail(400, 'theme must be system, dark or light');
      store.state.settings.theme = b.theme;
    }
    if (b.terminal !== undefined) store.state.settings.terminal = checkTerminalLook(b.terminal);
    if (typeof b.autoUpdate === 'boolean') store.state.settings.autoUpdate = b.autoUpdate;
    if (typeof b.startWithWindows === 'boolean' && !TEST_MODE) await startup.setEnabled(b.startWithWindows);
    store.save();
    return snapshot().settings;
  },

  'POST /api/update/check': () => checkForUpdate(),

  // The page asks on every load: Edge puts its own taskbar app ID back on a reload,
  // which drops the window under a plain browser icon.
  'POST /api/window-icon': () => {
    if (TEST_MODE || !platform.WIN) return { ok: true, skipped: true };
    if (Date.now() - lastWindowIcon > 3000) {
      lastWindowIcon = Date.now();
      giveWindowIcon(APP_DIR);
    }
    return { ok: true };
  },

  'POST /api/update/install': async () => {
    const u = updateStatus();
    if (!u.available) throw fail(400, 'no update available');
    if (TEST_MODE) return { ok: true, test: true };
    await installUpdate(u.latest);
    return { ok: true, restarting: true };
  },

  // Phone access. handle() answers these on the PC only, never over the tailnet.
  'GET /api/remote': () => remoteInfo(),

  'POST /api/remote': async (b) => {
    if (typeof b.enabled !== 'boolean') throw fail(400, 'enabled must be true or false');
    store.state.settings.remote = b.enabled;
    if (!b.enabled) remote.pending = null;
    store.save();
    log(`phone access turned ${b.enabled ? 'on' : 'off'}`);
    await syncRemote();
    return remoteInfo();
  },

  'POST /api/remote/https': async (b) => {
    if (typeof b.on !== 'boolean') throw fail(400, 'on must be true or false');
    if (b.on && !store.state.settings.remote) throw fail(400, 'turn on phone access first');
    if (TEST_MODE) return remoteInfo();
    const t = await tailscale(0);
    if (!t.running || !t.dns) throw fail(400, 'Tailscale is not connected on this PC');
    const r = b.on
      ? await tsCli(['serve', '--bg', '--yes', '--https=443', `http://127.0.0.1:${PORT}`], 20000)
      : await tsCli(['serve', '--https=443', 'off'], 10000);
    httpsCache.at = 0;
    const info = await remoteInfo();
    log(`phone HTTPS ${b.on ? 'on' : 'off'} requested: ${info.https.on ? 'on' : 'off'}${r.ok ? '' : ` (${r.out.trim().slice(0, 200)})`}`);
    if (b.on && !info.https.on) {
      // Most often the tailnet has HTTPS certificates switched off; Tailscale prints where to switch them on.
      const link = (r.out.match(/https:\/\/login\.tailscale\.com\/\S+/) || [])[0] || null;
      info.https.enableUrl = link || 'https://login.tailscale.com/admin/dns';
      info.https.message = r.out.trim().slice(0, 300);
    }
    return info;
  },

  'POST /api/remote/code': () => {
    if (!store.state.settings.remote) throw fail(400, 'turn on phone access first');
    remote.newCode();
    return remoteInfo();
  },

  'POST /api/remote/forget': (b) => {
    const id = String(b.id || '');
    if (id !== 'all' && !/^[0-9a-f]{12}$/.test(id)) throw fail(400, 'bad device id');
    remote.forget(id);
    // Drop open phone connections; devices that are still paired reconnect by themselves.
    if (remoteSrv && remoteSrv.closeAllConnections) remoteSrv.closeAllConnections();
    return remoteInfo();
  },
};

// ---- phone access over Tailscale ----------------------------------------------

let ts = { installed: false, running: false, ip: null, dns: null, at: 0 };
let remoteSrv = null;
let remoteBound = null;
let remoteError = null;
let remoteSyncing = false;

async function tailscale(maxAgeMs = 10000) {
  if (Date.now() - ts.at < maxAgeMs) return ts;
  const t = REMOTE_IP_OVERRIDE
    ? { installed: true, running: true, ip: REMOTE_IP_OVERRIDE, dns: process.env.CS_REMOTE_DNS || null }
    : await remoteLib.tailscaleStatus();
  ts = { ...t, at: Date.now() };
  return ts;
}

// Listens on the Tailscale address while phone access is on and Tailscale is up,
// and follows the address if it changes. Never binds to the LAN or 0.0.0.0.
async function syncRemote() {
  if (remoteSyncing) return;
  remoteSyncing = true;
  try {
    const want = !!store.state.settings.remote;
    const t = want ? await tailscale(0) : null;
    const ip = t && t.running ? t.ip : null;
    if (ip === remoteBound && (ip || !remoteSrv)) return;
    if (remoteSrv) {
      const old = remoteSrv;
      remoteSrv = null;
      remoteBound = null;
      old.close();
      if (old.closeAllConnections) old.closeAllConnections();
      log('phone access listener closed');
    }
    if (!ip) return;
    await new Promise((resolve) => {
      const srv = http.createServer((req, res) => handle(req, res, true));
      srv.once('error', (e) => {
        remoteError = e.message;
        log(`phone access could not listen on ${ip}:${PORT}: ${e.message}`);
        // Right after an update the old server can still hold the address for a moment.
        if (e.code === 'EADDRINUSE') setTimeout(syncRemote, 2000);
        resolve();
      });
      srv.listen(PORT, ip, () => {
        remoteSrv = srv;
        remoteBound = ip;
        remoteError = null;
        log(`phone access on http://${ip}:${PORT}`);
        resolve();
      });
    });
  } catch (e) {
    remoteError = e.message;
    log(`phone access: ${e.stack || e}`);
  } finally {
    remoteSyncing = false;
  }
}

// HTTPS for phones goes through Tailscale Serve (https://<pc>.<tailnet>.ts.net, a real
// certificate), which a phone needs before it offers to install the app. Only turned
// on or off from Settings on the PC.
function tsCli(args, ms) {
  return new Promise((resolve) => {
    execFile(remoteLib.tailscaleExe(), args, { timeout: ms, windowsHide: true }, (err, out, errOut) => {
      resolve({ ok: !err, out: `${out || ''}${errOut || ''}` });
    });
  });
}

let httpsCache = { at: 0, value: { on: false, url: null } };
async function httpsState(t) {
  if (REMOTE_IP_OVERRIDE || !t.dns || !t.running) return { on: false, url: null };
  if (Date.now() - httpsCache.at < 10000) return httpsCache.value;
  const r = await tsCli(['serve', 'status', '--json'], 6000);
  let on = false;
  try {
    const web = (JSON.parse(r.out || '{}').Web || {})[`${t.dns}:443`];
    const h = web && web.Handlers && web.Handlers['/'];
    on = !!h && h.Proxy === `http://127.0.0.1:${PORT}`;
  } catch { /* no serve config */ }
  httpsCache = { at: Date.now(), value: { on, url: on ? `https://${t.dns}` : null } };
  return httpsCache.value;
}

async function remoteInfo() {
  const t = await tailscale();
  return {
    https: await httpsState(t),
    enabled: !!store.state.settings.remote,
    port: PORT,
    tailscale: { installed: t.installed, running: t.running, ip: t.ip, dns: t.dns },
    listening: remoteBound,
    error: remoteBound ? null : remoteError,
    url: t.ip ? `http://${t.ip}:${PORT}` : null,
    dnsUrl: t.dns ? `http://${t.dns}:${PORT}` : null,
    code: remote.code(),
    devices: remote.list(),
  };
}

// Tailscale Serve (the HTTPS address phones can install from) hands requests to
// 127.0.0.1 with this PC's tailnet name as Host and the phone's address in
// X-Forwarded-For. Those are phone requests: they get the tailnet rules and pairing,
// never the trust a request from this PC gets.
function servedHost(req) {
  return String(req.headers.host || '').toLowerCase().replace(/:443$/, '');
}
function viaServe(req) {
  return !!ts.dns && servedHost(req) === ts.dns && req.headers['x-forwarded-for'] !== undefined;
}

// Phone requests: they must come from a tailnet address, name this PC's tailnet
// address or MagicDNS name, and stay same-origin.
function remoteGuard(req, served) {
  let h, origin;
  if (served) {
    if (!store.state.settings.remote) return 'phone access is off';
    const peer = String(req.headers['x-forwarded-for']).split(',').pop().trim();
    if (!remoteLib.isTailnetPeer(peer)) return 'not on your tailnet';
    h = servedHost(req);
    origin = `https://${h}`;
  } else {
    if (!REMOTE_IP_OVERRIDE && !remoteLib.isTailnetPeer(req.socket.remoteAddress)) return 'not on your tailnet';
    h = String(req.headers.host || '').toLowerCase();
    const names = [remoteBound, ts.dns, ts.dns && ts.dns.split('.')[0]].filter(Boolean).map((n) => `${n}:${PORT}`);
    if (!names.includes(h)) return 'bad host';
    origin = `http://${h}`;
  }
  const site = req.headers['sec-fetch-site'];
  if (req.url.startsWith('/api/') && site && site !== 'same-origin' && site !== 'none') return 'cross-site request';
  const o = req.headers.origin;
  if (o && o.toLowerCase() !== origin) return 'bad origin';
  if (req.method === 'POST' && req.headers['x-claude-sessions'] !== '1') return 'missing header';
  return null;
}

const pairTries = [];
async function pairDevice(req, res) {
  const now = Date.now();
  while (pairTries.length && now - pairTries[0] > 60000) pairTries.shift();
  if (pairTries.length >= 10) return send(res, 429, { error: 'too many tries; wait a minute' });
  pairTries.push(now);
  try {
    const b = await readBody(req);
    const token = remote.pair(b.code, req.headers['user-agent']);
    log(`paired ${remoteLib.deviceName(req.headers['user-agent'])} from ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
    res.setHeader('Set-Cookie', `${remoteLib.COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`);
    send(res, 200, { ok: true });
  } catch (e) {
    send(res, Number.isInteger(e.code) ? e.code : 500, { error: e.message });
  }
}

// What a phone may load before it is paired: the pairing page's icon and what installing needs.
const PUBLIC_FILES = new Set(['/icon.svg', '/manifest.webmanifest', '/sw.js', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png']);

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/icon-maskable-512.png': ['icon-maskable-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/vendor/xterm.js': ['vendor/xterm.js', 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': ['vendor/xterm.css', 'text/css; charset=utf-8'],
  '/vendor/addon-fit.js': ['vendor/addon-fit.js', 'text/javascript; charset=utf-8'],
};

async function handle(req, res, isRemote = false) {
  const served = !isRemote && viaServe(req);
  if (served) isRemote = true;
  const why = isRemote ? remoteGuard(req, served) : guard(req);
  if (why) return send(res, 403, { error: why });
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (isRemote) {
    if (!remote.check(req.headers.cookie)) {
      // Not paired: only the pairing page, its icon and the pairing call.
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(path.join(APP_DIR, 'public', 'pair.html')), 'text/html; charset=utf-8');
      if (req.method === 'POST' && url.pathname === '/api/remote/pair') return pairDevice(req, res);
      if (!(req.method === 'GET' && PUBLIC_FILES.has(url.pathname))) return send(res, 401, { error: 'pair this phone first' });
    } else if (url.pathname.startsWith('/api/remote')) {
      return send(res, 403, { error: 'phone access is managed on the PC' });
    }
  }

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    try { return send(res, 200, fs.readFileSync(path.join(APP_DIR, 'public', file)), type); } catch { return send(res, 404, { error: 'missing' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/term/stream') return openStream(req, res);

  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) return send(res, 404, { error: 'not found' });
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    send(res, 200, await route(body, url));
  } catch (e) {
    const code = Number.isInteger(e.code) ? e.code : 500;
    if (code === 500) log(`${url.pathname}: ${e.stack || e}`);
    send(res, code, { error: e.message });
  }
}

const server = http.createServer((req, res) => handle(req, res, false));

// Attached once: a callback passed to listen() would be added again on every retry.
server.once('listening', () => {
  log(`v${pkg.version} listening on http://${HOST}:${PORT}`);
  poll();
  setInterval(poll, POLL_MS);
  host.attach();
  syncRemote();
  setInterval(syncRemote, 30000);
  // An update may have changed the status line script; refresh the copy Claude Code runs.
  try { if (usage.statusLineState(CLAUDE_DIR).enabled) usage.installScript(DATA_DIR, APP_DIR); } catch (e) { log(`status line copy failed: ${e.message}`); }
  usage.pruneStatus(DATA_DIR);
  setInterval(() => usage.pruneStatus(DATA_DIR), 86400000);
  if (!TEST_MODE) {
    setTimeout(checkForUpdate, 30000);
    setInterval(checkForUpdate, UPDATE_EVERY_MS);
  }
});

// After an update the old server may still hold the port for a moment.
function listen(tries = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 40) return setTimeout(() => listen(tries + 1), 250);
    log(`listen failed: ${e.message}`);
    process.exit(1);
  });
  server.listen(PORT, HOST);
}

listen();
