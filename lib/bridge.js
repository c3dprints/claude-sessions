'use strict';
// Compiles native/conpty-bridge.cs with the csc.exe that ships with Windows.
// The exe is named after a hash of its source and kept outside the install
// folder: an update can then add a new bridge while the old one is still
// running a session (a running exe cannot be overwritten).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SOURCE = path.join(__dirname, '..', 'native', 'conpty-bridge.cs');

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

function ensureBridge(binDir) {
  const exe = path.join(binDir, `conpty-bridge-${sourceHash()}.exe`);
  if (fs.existsSync(exe)) return Promise.resolve(exe);
  const csc = findCsc();
  if (!csc) return Promise.reject(new Error('the .NET Framework C# compiler (csc.exe) was not found'));
  fs.mkdirSync(binDir, { recursive: true });
  const tmp = exe + '.building.exe';
  return new Promise((resolve, reject) => {
    execFile(csc, ['-nologo', '-optimize', '-target:exe', `-out:${tmp}`, SOURCE], { windowsHide: true, timeout: 120000 }, (err, stdout) => {
      if (err) return reject(new Error('compiling the terminal bridge failed: ' + String(stdout || err.message).trim().split('\n').slice(-3).join(' ')));
      try { fs.renameSync(tmp, exe); } catch (e) { if (!fs.existsSync(exe)) return reject(e); }
      resolve(exe);
    });
  });
}

module.exports = { ensureBridge, sourceHash, SOURCE };
