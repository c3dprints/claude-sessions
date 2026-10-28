'use strict';
// Claude Sessions: a local dashboard of every Claude Code terminal session.
// Zero dependencies. Listens on 127.0.0.1 only; it can open terminals, so it is never exposed.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const pkg = require('./package.json');
const sessions = require('./lib/sessions');
const terminal = require('./lib/terminal');
const updater = require('./lib/updater');
const startup = require('./lib/startup');
const { Store } = require('./lib/store');

const PORT = Number(process.env.CS_PORT || 8930);
const HOST = '127.0.0.1';
const APP_DIR = __dirname;
const CLAUDE_DIR = process.env.CS_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const DATA_DIR = process.env.CS_DATA || path.join(process.env.LOCALAPPDATA || os.homedir(), 'ClaudeSessions', 'data');
const POLL_MS = 3000;
const UPDATE_EVERY_MS = 6 * 3600000;
const HISTORY_TTL_MS = 15000;
// Tests pass a fixed pid list instead of asking tasklist, and switch off terminal actions.
const FAKE_PIDS = process.env.CS_FAKE_PIDS !== undefined
  ? new Set(process.env.CS_FAKE_PIDS.split(',').filter(Boolean).map(Number)) : null;
const TEST_MODE = process.env.CS_TEST === '1';

const store = new Store(DATA_DIR);
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

function snapshot() {
  const nick = store.state.nicknames;
  const liveIds = new Set(live.map((s) => s.sessionId));
  const closed = store.state.closed.filter((c) => !liveIds.has(c.sessionId));
  const closedIds = new Set(closed.map((c) => c.sessionId));
  const history = getHistory(new Set([...liveIds, ...closedIds]));
  const folders = [];
  for (const s of [...live, ...closed, ...history]) {
    if (s.cwd && !folders.includes(s.cwd) && !/\\AppData\\Local\\Temp\\claude\\/i.test(s.cwd)) folders.push(s.cwd);
  }
  const withNick = (s) => ({ ...s, nickname: nick[s.sessionId] || null });
  return {
    app: { name: 'Claude Sessions', version: pkg.version },
    now: Date.now(),
    live: live.map(withNick),
    closed: closed.map(withNick),
    history: history.map(withNick),
    folders: folders.slice(0, 12),
    update: { ...updateStatus(), busy: updateBusy },
    settings: { autoUpdate: !!store.state.settings.autoUpdate, startWithWindows: startup.isEnabled() },
  };
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
// rebinding; the custom header on POST forces a CORS preflight we never
// answer, so other sites cannot trigger actions.
function guard(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return 'bad host';
  if (req.method === 'POST') {
    if (req.headers['x-claude-sessions'] !== '1') return 'missing header';
    const o = req.headers.origin;
    if (o && !ALLOWED_ORIGINS.has(o)) return 'bad origin';
  }
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
      if (size <= 16384) chunks.push(c);
    });
    req.on('end', () => {
      if (size > 16384) return reject(Object.assign(new Error('body too large'), { code: 413 }));
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
  return snapshot().folders.includes(cwd);
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

  'POST /api/resume': async (b) => {
    if (!sessions.UUID_RE.test(String(b.sessionId))) throw fail(400, 'bad session id');
    if (live.some((x) => x.sessionId === b.sessionId)) throw fail(409, 'already open, use Go to tab');
    const closed = store.state.closed.find((c) => c.sessionId === b.sessionId);
    const info = sessions.lookup(CLAUDE_DIR, b.sessionId);
    const cwd = (closed && closed.cwd) || (info && info.cwd);
    if (!cwd) throw fail(404, 'no folder recorded for that session');
    const args = terminal.claudeTabArgs(cwd, b.sessionId); // validates before anything runs
    if (TEST_MODE) return { ok: true, test: true, args };
    terminal.resume(cwd, b.sessionId);
    log(`reopened ${b.sessionId} in ${cwd}`);
    return { ok: true };
  },

  'POST /api/new': async (b) => {
    if (!knownFolder(b.cwd)) throw fail(400, 'pick a folder from the list');
    const args = terminal.claudeTabArgs(b.cwd);
    if (TEST_MODE) return { ok: true, test: true, args };
    terminal.newSession(b.cwd);
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

  'POST /api/settings': async (b) => {
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
};

const server = http.createServer(async (req, res) => {
  const why = guard(req);
  if (why) return send(res, 403, { error: why });
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    try { return send(res, 200, fs.readFileSync(path.join(APP_DIR, 'public', file)), type); } catch { return send(res, 404, { error: 'missing' }); }
  }

  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) return send(res, 404, { error: 'not found' });
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    send(res, 200, await route(body));
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
