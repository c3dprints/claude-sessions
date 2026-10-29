'use strict';
// Compiles the terminal bridge on first use: native/conpty-bridge.cs with the
// csc.exe that ships with Windows, or native/pty-bridge.c with the cc from the
// Xcode command line tools on macOS. The binary is named after a hash of its
// source and kept outside the install folder: an update can then add a new
// bridge while the old one is still running a session (a running exe cannot
// be overwritten).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const WIN = process.platform === 'win32';
const SOURCE = path.join(__dirname, '..', 'native', WIN ? 'conpty-bridge.cs' : 'pty-bridge.c');

function sourceHash() {
  return crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).digest('hex').slice(0, 12);
}

function findCsc() {
  const win = process.env.WINDIR || 'C:\\Windows';
  return [
    path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].find((p) => fs.existsSync(p));
}

function compiler(out) {
  if (WIN) {
    const csc = findCsc();
    if (!csc) throw new Error('the .NET Framework C# compiler (csc.exe) was not found');
    return [csc, ['-nologo', '-optimize', '-target:exe', `-out:${out}`, SOURCE]];
  }
  const cc = ['/usr/bin/cc', '/usr/bin/clang'].find((p) => fs.existsSync(p));
  if (!cc) throw new Error('no C compiler found: run xcode-select --install');
  return [cc, ['-O2', '-Wall', '-o', out, SOURCE]];
}

function ensureBridge(binDir) {
  const exe = path.join(binDir, WIN ? `conpty-bridge-${sourceHash()}.exe` : `pty-bridge-${sourceHash()}`);
  if (fs.existsSync(exe)) return Promise.resolve(exe);
  fs.mkdirSync(binDir, { recursive: true });
  const tmp = exe + (WIN ? '.building.exe' : '.building');
  let cmd;
  try { cmd = compiler(tmp); } catch (e) { return Promise.reject(e); }
  return new Promise((resolve, reject) => {
    execFile(cmd[0], cmd[1], { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('compiling the terminal bridge failed: ' + String(stdout || stderr || err.message).trim().split('\n').slice(-3).join(' ')));
      try { fs.renameSync(tmp, exe); } catch (e) { if (!fs.existsSync(exe)) return reject(e); }
      resolve(exe);
    });
  });
}

module.exports = { ensureBridge, sourceHash, SOURCE };
