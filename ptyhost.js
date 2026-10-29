'use strict';
// Session host: owns every terminal started from the dashboard. It runs as its
// own process so that restarting the dashboard (an update, a crash) never ends
// a running Claude session. The dashboard server talks to it over a named pipe.
//
//   node ptyhost.js <conpty-bridge.exe | pty-bridge>
//
// Protocol: JSON lines. The first message must be {t:'auth', token}.
// Requests carry `rid` and get {t:'res', rid, ok, ...}. Events are broadcast
// to every connected client: spawned, info (pid known), out (base64), exit.

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const platform = require('./lib/platform');

const PIPE = platform.hostPipe();
const DATA_DIR = platform.dataDir();
const VERSION = process.env.CS_HOST_VERSION || 'dev';
const BRIDGE = process.argv[2];
const BUFFER_MAX = 2 * 1024 * 1024;       // scrollback kept per session for reconnecting windows
const EXITED_KEEP_MS = 60 * 60 * 1000;
const TOKEN = fs.readFileSync(path.join(DATA_DIR, 'host.token'), 'utf8').trim();

// Set when the dashboard itself was started from inside a Claude session;
// a new session must not believe it is nested in that one.
const SESSION_ENV = new Set([
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SSE_PORT',
]);

function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!SESSION_ENV.has(k.toUpperCase()) && !k.toUpperCase().startsWith('CS_')) env[k] = v;
  }
  return env;
}

function log(msg) {
  try { fs.appendFileSync(path.join(DATA_DIR, 'host.log'), `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
}

const sessions = new Map();
const clients = new Set();

function info(s) {
  return {
    id: s.id, cwd: s.cwd, resumeId: s.resumeId, pid: s.pid, startedAt: s.startedAt,
    exited: s.exited, exitCode: s.exitCode, endedAt: s.endedAt, error: s.error, cols: s.cols, rows: s.rows,
  };
}

function broadcast(msg) {
  const line = JSON.stringify(msg) + '\n';
  for (const c of clients) c.write(line);
}

function frame(type, payload) {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeInt32LE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function sendFrame(s, type, payload) {
  if (s.exited || !s.proc.stdin.writable) return;
  s.proc.stdin.write(frame(type, payload));
}

function keep(s, chunk) {
  s.chunks.push(chunk);
  s.size += chunk.length;
  while (s.size > BUFFER_MAX && s.chunks.length > 1) s.size -= s.chunks.shift().length;
}

function spawnSession({ cwd, command, cols, rows, resumeId }) {
  const s = {
    id: crypto.randomUUID(), cwd, resumeId: resumeId || null, pid: null, startedAt: Date.now(),
    exited: false, exitCode: null, endedAt: null, error: null, cols, rows, chunks: [], size: 0,
  };
  s.proc = spawn(BRIDGE, [String(cols), String(rows), cwd, command], { cwd, env: childEnv(), windowsHide: true });
  s.proc.stdin.on('error', () => {});
  s.proc.stdout.on('data', (d) => {
    keep(s, d);
    broadcast({ t: 'out', id: s.id, data: d.toString('base64') });
  });
  let errBuf = '';
  s.proc.stderr.on('data', (d) => {
    errBuf += d.toString('utf8');
    let i;
    while ((i = errBuf.indexOf('\n')) >= 0) {
      const line = errBuf.slice(0, i).trim();
      errBuf = errBuf.slice(i + 1);
      const m = /^PID (\d+)$/.exec(line);
      if (m) { s.pid = Number(m[1]); broadcast({ t: 'info', session: info(s) }); }
      else if (line.startsWith('ERR ')) { s.error = line.slice(4); log(`${s.id} ${line}`); }
    }
  });
  const done = (code) => {
    if (s.exited) return;
    s.exited = true;
    s.exitCode = code;
    s.endedAt = Date.now();
    broadcast({ t: 'exit', session: info(s) });
    log(`${s.id} exited ${code}`);
  };
  s.proc.on('exit', (code) => done(code));
  s.proc.on('error', (e) => { s.error = e.message; done(-1); });
  sessions.set(s.id, s);
  log(`${s.id} started in ${cwd}: ${command}`);
  broadcast({ t: 'spawned', session: info(s) });
  return s;
}

function running() {
  return [...sessions.values()].filter((s) => !s.exited);
}

function handle(sock, msg) {
  const reply = (extra) => { if (msg.rid !== undefined) sock.write(JSON.stringify({ t: 'res', rid: msg.rid, ok: true, ...extra }) + '\n'); };
  const fail = (error) => { if (msg.rid !== undefined) sock.write(JSON.stringify({ t: 'res', rid: msg.rid, ok: false, error }) + '\n'); };
  const s = msg.id ? sessions.get(msg.id) : null;
  switch (msg.t) {
    case 'list': return reply({ version: VERSION, sessions: [...sessions.values()].map(info) });
    case 'spawn': {
      if (typeof msg.cwd !== 'string' || typeof msg.command !== 'string') return fail('cwd and command required');
      const cols = Math.min(Math.max(msg.cols | 0, 20), 500);
      const rows = Math.min(Math.max(msg.rows | 0, 5), 300);
      return reply({ session: info(spawnSession({ cwd: msg.cwd, command: msg.command, cols, rows, resumeId: msg.resumeId })) });
    }
    case 'input':
      if (s && typeof msg.data === 'string') sendFrame(s, 0, Buffer.from(msg.data, 'utf8'));
      return reply({});
    case 'resize':
      if (s) {
        const p = Buffer.alloc(4);
        s.cols = Math.min(Math.max(msg.cols | 0, 20), 500);
        s.rows = Math.min(Math.max(msg.rows | 0, 5), 300);
        p.writeInt16LE(s.cols, 0);
        p.writeInt16LE(s.rows, 2);
        sendFrame(s, 1, p);
      }
      return reply({});
    case 'kill':
      if (s) sendFrame(s, 2, Buffer.alloc(0));
      return reply({});
    case 'replay':
      // Answered on the same socket, in order: every 'out' sent after this
      // reply is newer than the buffer it carries.
      return reply({ id: msg.id, data: s ? Buffer.concat(s.chunks).toString('base64') : '' });
    case 'forget':
      if (s && s.exited) sessions.delete(s.id);
      return reply({});
    case 'shutdown':
      if (running().length) return fail('sessions are still running');
      reply({});
      log('shutdown requested');
      return setTimeout(() => process.exit(0), 100);
    default:
      return fail('unknown message');
  }
}

const server = net.createServer((sock) => {
  let authed = false;
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('error', () => {});
  sock.on('close', () => clients.delete(sock));
  sock.on('data', (d) => {
    buf += d;
    if (buf.length > 4 * 1024 * 1024) return sock.destroy();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (!authed) {
        const ok = msg.t === 'auth' && typeof msg.token === 'string' && msg.token.length === TOKEN.length &&
          crypto.timingSafeEqual(Buffer.from(msg.token), Buffer.from(TOKEN));
        if (!ok) { sock.write(JSON.stringify({ t: 'auth', ok: false }) + '\n'); return sock.destroy(); }
        authed = true;
        clients.add(sock);
        sock.write(JSON.stringify({ t: 'auth', ok: true, version: VERSION }) + '\n');
        continue;
      }
      handle(sock, msg);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) if (s.exited && now - s.endedAt > EXITED_KEEP_MS) sessions.delete(s.id);
}, 60000).unref();

function listen() {
  server.listen(PIPE, () => {
    if (!platform.WIN) try { fs.chmodSync(PIPE, 0o600); } catch { /* the token still guards it */ }
    log(`host ${VERSION} listening on ${PIPE} with ${BRIDGE}`);
  });
}

// A Unix socket file outlives a host that crashed. Remove it only when nobody answers on it.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && !platform.WIN && !listen.retried) {
    listen.retried = true;
    const probe = net.connect(PIPE);
    probe.once('connect', () => { probe.destroy(); log('another host is already listening'); process.exit(1); });
    probe.once('error', () => { try { fs.unlinkSync(PIPE); } catch { /* gone */ } listen(); });
    return;
  }
  log(`pipe failed: ${e.message}`);
  process.exit(1);
});
listen();
