'use strict';
// Self-update from tagged GitHub releases, the same model as the conveyor Pi:
// the installed copy is a git clone, a release is a `vX.Y.Z` tag, installing
// checks that tag out and restarts the server. A copy sitting on a branch is a
// dev checkout and is never moved by the updater.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(v) {
  const m = TAG_RE.exec(v.startsWith('v') ? v : 'v' + v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`bad version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function latestTag(tags) {
  const good = tags.map((t) => t.trim()).filter((t) => TAG_RE.test(t));
  good.sort(compare);
  return good.length ? good[good.length - 1] : null;
}

function git(appDir, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: appDir,
      windowsHide: true,
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // never hang on a login prompt
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error((String(stderr).trim() || err.message).split('\n').pop()));
      resolve(String(stdout).trim());
    });
  });
}

async function mode(appDir) {
  if (!fs.existsSync(path.join(appDir, '.git'))) return { kind: 'none' };
  try {
    const branch = await git(appDir, ['symbolic-ref', '--short', '-q', 'HEAD']);
    return { kind: 'dev', branch };
  } catch {
    return { kind: 'release' }; // detached at a tag
  }
}

async function check(appDir, current) {
  const m = await mode(appDir);
  if (m.kind === 'none') return { current, available: false, mode: 'none', error: 'not installed from git, updates are off' };
  await git(appDir, ['fetch', '--tags', '--force', '--quiet', 'origin']);
  const latest = latestTag((await git(appDir, ['tag', '-l', 'v*'])).split('\n'));
  return {
    current,
    latest,
    available: !!latest && compare(latest, current) > 0,
    mode: m.kind,
    branch: m.branch || null,
    error: null,
  };
}

async function install(appDir, tag) {
  if (!TAG_RE.test(tag)) throw new Error('bad tag');
  const m = await mode(appDir);
  if (m.kind !== 'release') throw new Error(m.kind === 'dev' ? `dev copy on branch ${m.branch}: use git pull` : 'not installed from git');
  const dirty = await git(appDir, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw new Error('install folder has local edits, update stopped so nothing is lost');
  await git(appDir, ['checkout', '--quiet', `refs/tags/${tag}`]);
}

module.exports = { parseVersion, compare, latestTag, check, install, mode };
