'use strict';
// The dashboard's side of the session host: starts it when needed, keeps one
// authenticated pipe connection, mirrors its session list, and re-emits its events.

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { ensureBridge, sourceHash } = require('./bridge');
const platform = require('./platform');

const APP_DIR = path.join(__dirname, '..');
const HOST_JS = path.join(APP_DIR, 'ptyhost.js');

// Host and bridge are restarted only when their code changed and nothing runs on them.
function expectedVersion() {
  return crypto.createHash('sha256').update(fs.readFileSync(HOST_JS)).update(sourceHash()).digest('hex').slice(0, 12);
}

class HostClient extends EventEmitter {
  constructor({ dataDir, pipe }) {
    super();
    this.dataDir = dataDir;
    this.binDir = path.join(path.dirname(dataDir), 'bin');
    this.pipe = pipe || platform.hostPipe();
    this.sock = null;
    this.version = null;
    this.sessions = new Map();
    this.pending = new Map();
    this.nextRid = 1;
    this.connecting = null;
    this.outdated = false;
    this.error = null;
  }

  token() {
    const file = path.join(this.dataDir, 'host.token');
    try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* create below */ }
    fs.mkdirSync(this.dataDir, { recursive: true });
    const t = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, t, { mode: 0o600 });
    return t;
  }

  get up() { return !!this.sock; }

  // Picks up a host that is already running (sessions from before a dashboard restart) without starting one.
  attach() {
    return this._connect().then(() => this._upgradeIfIdle()).catch(() => {});
  }

  // Resolves once connected; starts the host if nobody is listening.
  ensure() {
    if (this.sock) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this._connectOrStart().then(
        () => { this.connecting = null; this.error = null; },
        (e) => { this.connecting = null; this.error = e.message; throw e; });
    }
    return this.connecting;
  }

  async _connectOrStart() {
    try {
      await this._connect();
    } catch {
      await this._start();
      let last;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 150));
        try { await this._connect(); last = null; break; } catch (e) { last = e; }
      }
      if (last) throw new Error('the session host did not start: ' + last.message);
    }
    await this._upgradeIfIdle();
  }

  async _start() {
    const exe = await ensureBridge(this.binDir);
    this.token();
    const child = spawn(process.execPath, [HOST_JS, exe], {
      cwd: APP_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, CS_DATA: this.dataDir, CS_HOST_PIPE: this.pipe, CS_HOST_VERSION: expectedVersion() },
    });
    child.unref();
  }

  async _upgradeIfIdle() {
    this.outdated = this.version !== expectedVersion();
    if (!this.outdated) return;
    if ([...this.sessions.values()].some((s) => !s.exited)) return; // retried when the last one ends
    await this.request({ t: 'shutdown' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    this.sessions.clear();
    await this._start();
    for (let i = 0; i < 40 && !this.sock; i++) {
      await new Promise((r) => setTimeout(r, 150));
      try { await this._connect(); } catch { /* still starting */ }
    }
    this.outdated = this.version !== expectedVersion();
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.pipe);
      let buf = '';
      let authed = false;
      sock.setEncoding('utf8');
      sock.once('error', (e) => { if (!authed) reject(e); });
      sock.on('connect', () => sock.write(JSON.stringify({ t: 'auth', token: this.token() }) + '\n'));
      sock.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (!authed) {
            if (msg.t !== 'auth' || !msg.ok) { sock.destroy(); return reject(new Error('session host refused the token')); }
            authed = true;
            this.sock = sock;
            this.version = msg.version;
            this.request({ t: 'list' }).then((r) => {
              this.sessions = new Map(r.sessions.map((s) => [s.id, s]));
              this.emit('up');
              resolve();
            }, reject);
            continue;
          }
          this._dispatch(msg);
        }
      });
      sock.on('close', () => {
        if (this.sock !== sock) return;
        this.sock = null;
        for (const cb of this.pending.values()) cb({ ok: false, error: 'session host went away' });
        this.pending.clear();
        // Its sessions went with it.
        for (const s of this.sessions.values()) {
          if (s.exited) continue;
          Object.assign(s, { exited: true, exitCode: null, endedAt: Date.now(), error: 'the session host stopped' });
          this.emit('event', { t: 'exit', session: s });
        }
        this.emit('down');
      });
    });
  }

  // Runs synchronously per line, so a replay reply is handled before any later 'out'.
  _dispatch(msg) {
    if (msg.t === 'res') {
      const cb = this.pending.get(msg.rid);
      if (cb) { this.pending.delete(msg.rid); cb(msg); }
      return;
    }
    if (msg.session) this.sessions.set(msg.session.id, msg.session);
    if (msg.t === 'exit' && this.outdated) this._upgradeIfIdle().catch(() => {});
    this.emit('event', msg);
  }

  // cb form is synchronous with the stream; the promise form is for everything else.
  call(msg, cb) {
    if (!this.sock) return cb({ ok: false, error: 'session host is not running' });
    const rid = this.nextRid++;
    this.pending.set(rid, cb);
    this.sock.write(JSON.stringify({ ...msg, rid }) + '\n');
  }

  request(msg) {
    return new Promise((resolve, reject) => {
      this.call(msg, (r) => (r.ok ? resolve(r) : reject(new Error(r.error || 'session host error'))));
    });
  }

  list() {
    return [...this.sessions.values()];
  }
}

module.exports = { HostClient, expectedVersion };
