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
