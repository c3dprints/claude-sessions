'use strict';
// Builds dist/ClaudeSessionsSetup.exe: `npm run build-setup` (Windows only)
// installer/setup.cs compiled with the csc.exe that ships with Windows, with
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

module.exports = { buildSetup };

if (require.main === module) console.log('built ' + buildSetup());
