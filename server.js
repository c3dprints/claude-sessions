'use strict';
// Claude Sessions: a local dashboard of every Claude Code terminal session,
// with built-in terminals for sessions started from the app.
// Zero dependencies. Listens on 127.0.0.1 only; it runs terminals, so it is never exposed.

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

const PORT = Number(process.env.CS_PORT || 8930);
const HOST = '127.0.0.1';
const APP_DIR = __dirname;
const CLAUDE_DIR = process.env.CS_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const DATA_DIR = process.env.CS_DATA || path.join(process.env.LOCALAPPDATA || os.homedir(), 'ClaudeSessions', 'data');
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

function getHistory(excludeIds) {
  const key = [...excludeIds].sort().join(',');
  if (Date.now() - historyCache.at < HISTORY_TTL_MS && historyCache.key === key) return historyCache.items;
  historyCache = { at: Date.now(), key, items: sessions.history(CLAUDE_DIR, { excludeIds }) };
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
    app: { name: 'Claude Sessions', version: pkg.version },
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
    },
  };
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

function claudeExe() {
  if (claudeExePath && fs.existsSync(claudeExePath)) return claudeExePath;
  const dirs = [path.join(os.homedir(), '.local', 'bin'), ...String(process.env.PATH || '').split(';')];
  claudeExePath = dirs.filter(Boolean).map((d) => path.join(d, 'claude.exe')).find((p) => fs.existsSync(p)) || null;
  if (!claudeExePath) throw fail(500, 'claude.exe was not found (looked in ~/.local/bin and PATH)');
  return claudeExePath;
}

function claudeCommand(resumeId) {
  if (TEST_MODE && process.env.CS_CLAUDE_CMD) return process.env.CS_CLAUDE_CMD;
  return `"${claudeExe()}"` + (resumeId ? ` --resume ${resumeId}` : '');
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
      await new Promise((resolve) => execFile('taskkill', ['/PID', String(s.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
      if (!(await processGone(s.pid, 8000))) throw fail(500, 'the session did not close in Windows Terminal');
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

  // projectId: a project, 'none' (keep it out of every project), or null (go by folder again)
  'POST /api/projects/assign': async (b) => {
    if (!sessions.UUID_RE.test(String(b.sessionId))) throw fail(400, 'bad session id');
    if (b.projectId === null || b.projectId === undefined) delete store.state.assign[b.sessionId];
    else if (b.projectId === 'none' || store.state.projects.some((p) => p.id === b.projectId)) store.state.assign[b.sessionId] = b.projectId;
    else throw fail(404, 'no such project');
    store.save();
    return { ok: true };
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
    if (typeof b.autoUpdate === 'boolean') store.state.settings.autoUpdate = b.autoUpdate;
    if (typeof b.startWithWindows === 'boolean' && !TEST_MODE) await startup.setEnabled(b.startWithWindows);
    store.save();
    return snapshot().settings;
  },

  'POST /api/update/check': () => checkForUpdate(),

  'POST /api/update/install': async () => {
    const u = updateStatus();
    if (!u.available) throw fail(400, 'no update available');
    if (TEST_MODE) return { ok: true, test: true };
    await installUpdate(u.latest);
    return { ok: true, restarting: true };
  },
};

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/vendor/xterm.js': ['vendor/xterm.js', 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': ['vendor/xterm.css', 'text/css; charset=utf-8'],
  '/vendor/addon-fit.js': ['vendor/addon-fit.js', 'text/javascript; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  const why = guard(req);
  if (why) return send(res, 403, { error: why });
  const url = new URL(req.url, `http://${req.headers.host}`);

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
});

// Attached once: a callback passed to listen() would be added again on every retry.
server.once('listening', () => {
  log(`v${pkg.version} listening on http://${HOST}:${PORT}`);
  poll();
  setInterval(poll, POLL_MS);
  host.attach();
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
