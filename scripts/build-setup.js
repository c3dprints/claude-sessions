'use strict';
// Builds the installers: `npm run build-setup`
// dist/ClaudeSessionsSetup.exe (on Windows only): installer/setup.cs compiled with the csc.exe that ships with Windows, with
// scripts/install.ps1 embedded so the exe needs nothing else to run.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { findCsc } = require('../lib/bridge');

const ROOT = path.join(__dirname, '..');

function buildSetup() {
  if (process.platform !== 'win32') throw new Error('the setup exe is built on Windows');
  const csc = findCsc();
  if (!csc) throw new Error('the .NET Framework C# compiler (csc.exe) was not found');
  const out = path.join(ROOT, 'dist', 'ClaudeSessionsSetup.exe');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(csc, [
    '-nologo', '-optimize', '-target:exe', `-out:${out}`,
    `-win32icon:${path.join(ROOT, 'public', 'icon.ico')}`,
    `-resource:${path.join(ROOT, 'scripts', 'install.ps1')},install.ps1`,
    path.join(ROOT, 'installer', 'setup.cs'),
  ], { encoding: 'utf8' });
  return out;
}

// dist/ClaudeSessionsSetup-mac.zip holds "Install Claude Sessions.command":
// installer/install-mac.command with scripts/install-mac.sh put in its marker
// line. A zip keeps the file executable after download (its mode is stored
// as a Unix attribute), so it opens in Terminal on a double-click.
function buildMacSetup() {
  const lf = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
  const install = lf('scripts/install-mac.sh').trimEnd();
  if (/^INSTALL_SH$/m.test(install)) throw new Error('install-mac.sh must not contain an INSTALL_SH line');
  const script = lf('installer/install-mac.command').replace('#@INSTALL_MAC_SH@', () => install);
  const out = path.join(ROOT, 'dist', 'ClaudeSessionsSetup-mac.zip');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, zipOne('Install Claude Sessions.command', Buffer.from(script), 0o100755));
  return out;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) {
    let c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// A zip with one stored (uncompressed) file, made on "Unix" so the mode counts.
function zipOne(name, data, mode) {
  const n = Buffer.from(name);
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(10, 4);
  local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(10, 6);
  central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE((mode << 16) >>> 0, 38);
  const cdOffset = local.length + n.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + n.length, 12); end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, n, data, central, n, end]);
}

module.exports = { buildSetup, buildMacSetup };

if (require.main === module) {
  if (process.platform === 'win32') console.log('built ' + buildSetup());
  console.log('built ' + buildMacSetup());
}
