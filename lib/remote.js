'use strict';
// Phone access over Tailscale. Finds this PC's tailnet address, pairs a device
// with a short code shown in Settings on the PC, and recognises paired devices
// by a cookie. Only a hash of each device's token is kept on disk.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const CODE_TTL_MS = 5 * 60000;
const CODE_TRIES = 5;
const MAX_DEVICES = 10;
const COOKIE = 'cs_device';

function tailscaleExe() {
  const full = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')
    : '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  return fs.existsSync(full) ? full : 'tailscale';
}

// { installed, running, ip, dns }. ip is the IPv4 tailnet address (100.x.y.z).
function tailscaleStatus() {
  return new Promise((resolve) => {
    execFile(tailscaleExe(), ['status', '--json'], { timeout: 6000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err && !out) return resolve({ installed: err.code !== 'ENOENT', running: false, ip: null, dns: null });
      try {
        const j = JSON.parse(out);
        const self = j.Self || {};
        const ip = (self.TailscaleIPs || []).find((a) => /^100\.\d+\.\d+\.\d+$/.test(a)) || null;
        const dns = self.DNSName ? String(self.DNSName).replace(/\.$/, '').toLowerCase() : null;
        resolve({ installed: true, running: j.BackendState === 'Running' && !!ip, ip, dns });
      } catch {
        resolve({ installed: true, running: false, ip: null, dns: null });
      }
    });
  });
}

// Tailscale hands out addresses in 100.64.0.0/10.
function isTailnetPeer(addr) {
  const m = /^(?:::ffff:)?100\.(\d+)\.\d+\.\d+$/.exec(String(addr || ''));
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

function deviceName(ua) {
  ua = String(ua || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /EdgA?\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${os}, ${browser}` : os;
}

function hash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function cookieToken(header) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,100})`).exec(String(header || ''));
  return m ? m[1] : null;
}

class Remote {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'remote.json');
    this.devices = [];
    this.pending = null;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(j.devices)) this.devices = j.devices.filter((d) => d && /^[0-9a-f]{64}$/.test(d.hash));
    } catch { /* first run */ }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ devices: this.devices }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // A new 6 digit code replaces the old one. It lasts 5 minutes and 5 wrong tries.
  newCode() {
    this.pending = { code: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), until: Date.now() + CODE_TTL_MS, tries: 0 };
    return this.code();
  }

  code() {
    const p = this.pending;
    if (!p || Date.now() > p.until) return null;
    return { code: p.code, until: p.until };
  }

  // Returns the new device's token, or throws.
  pair(code, ua) {
    const p = this.pending;
    if (!p || Date.now() > p.until) throw Object.assign(new Error('no pairing code is open; make one in Settings on the PC'), { code: 400 });
    const given = Buffer.from(String(code || '').replace(/\D/g, '').padEnd(6, 'x').slice(0, 6));
    if (!crypto.timingSafeEqual(given, Buffer.from(p.code))) {
      if (++p.tries >= CODE_TRIES) this.pending = null;
      throw Object.assign(new Error(this.pending ? 'wrong code' : 'too many wrong tries; make a new code on the PC'), { code: 403 });
    }
    this.pending = null;
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.devices.push({ id: crypto.randomBytes(6).toString('hex'), hash: hash(token), name: deviceName(ua), added: now, seen: now });
    while (this.devices.length > MAX_DEVICES) this.devices.shift();
    this.save();
    return token;
  }

  // The paired device behind a request's cookie, or null.
  check(cookieHeader) {
    const token = cookieToken(cookieHeader);
    if (!token) return null;
    const h = Buffer.from(hash(token));
    const d = this.devices.find((x) => crypto.timingSafeEqual(Buffer.from(x.hash), h));
    if (d && Date.now() - d.seen > 10 * 60000) {
      d.seen = Date.now();
      try { this.save(); } catch { /* last seen is only a hint */ }
    }
    return d || null;
  }

  forget(id) {
    const before = this.devices.length;
    this.devices = id === 'all' ? [] : this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.save();
    return true;
  }

  list() {
    return this.devices.map(({ id, name, added, seen }) => ({ id, name, added, seen }));
  }
}

module.exports = { Remote, tailscaleStatus, isTailnetPeer, deviceName, cookieToken, COOKIE };
