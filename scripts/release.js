'use strict';
// Publishes a release: `npm run release`
// Checks that the version is new and logged in CHANGELOG.md, the tree is clean
// and the tests pass, then pushes main and the vX.Y.Z tag that installed copies look for.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
const die = (msg) => { console.error('release stopped: ' + msg); process.exit(1); };

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const tag = `v${version}`;

const top = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').match(/^## (\d+\.\d+\.\d+)/m);
if (!top || top[1] !== version) die(`CHANGELOG.md top entry is ${top ? top[1] : 'missing'}, package.json says ${version}`);
if (run('git', ['symbolic-ref', '--short', 'HEAD']) !== 'main') die('not on main');
if (run('git', ['status', '--porcelain'])) die('uncommitted changes, commit first');
if (run('git', ['tag', '-l', tag])) die(`${tag} already exists locally, bump the version`);
if (run('git', ['ls-remote', '--tags', 'origin', tag])) die(`${tag} already exists on GitHub, bump the version`);

console.log('running tests...');
try {
  console.log(run(process.execPath, ['tests/run-all.js']));
} catch (e) {
  die('tests failed\n' + (e.stdout || e.message));
}

execFileSync('git', ['push', '--quiet', 'origin', 'main'], { cwd: ROOT, stdio: 'inherit' });
run('git', ['tag', '-a', tag, '-m', `Claude Sessions ${version}`]);
execFileSync('git', ['push', '--quiet', 'origin', tag], { cwd: ROOT, stdio: 'inherit' });
console.log(`released ${tag}. Installed copies will offer it on their next check (or press Check now).`);

// The GitHub release page carries ClaudeSessionsSetup.exe for new installs.
// The tag is already out, so a failure here only warns.
if (process.platform === 'win32') {
  try {
    const exe = require('./build-setup').buildSetup();
    const notes = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
      .split(/^## /m).find((s) => /^[\d.]+/.exec(s)?.[0] === version)
      .replace(/^.*\r?\n/, '').trim();
    run('gh', ['release', 'create', tag, exe, '--title', `Claude Sessions ${version}`, '--notes', notes]);
    console.log(`GitHub release ${tag} published with ClaudeSessionsSetup.exe`);
  } catch (e) {
    console.warn(`GitHub release not published (${(e.stderr || e.message).trim()}). Run: npm run build-setup, then gh release create ${tag} dist\\ClaudeSessionsSetup.exe`);
  }
}
