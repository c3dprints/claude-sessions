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

// The CHANGELOG sections newer than `from`, up to and including `to`, newest first:
// [{ version, date, body }]. Headings look like `## 1.5.23 (2026-11-08)`.
function parseNotes(text, from, to) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const h = /^##\s+v?(\d+\.\d+\.\d+)\s*(?:\(([^)]*)\))?\s*$/.exec(line);
    if (h) {
      cur = null;
      let inRange = false;
      try { inRange = compare(h[1], from) > 0 && (!to || compare(h[1], to) <= 0); } catch { /* bad version */ }
      if (inRange) { cur = { version: h[1], date: h[2] || '', body: '' }; out.push(cur); }
    } else if (cur) cur.body += line + '\n';
  }
  for (const n of out) n.body = n.body.trim();
  return out.slice(0, 20);
}

// What changed between `from` and `tag`, read from the tag's own CHANGELOG
// (check() has fetched it), or from the local file when `tag` is omitted.
async function notes(appDir, from, tag) {
  let text = '';
  if (tag && TAG_RE.test(tag)) {
    try { text = await git(appDir, ['show', `refs/tags/${tag}:CHANGELOG.md`]); } catch { /* no tag or no git */ }
  }
  if (!text) {
    try { text = fs.readFileSync(path.join(appDir, 'CHANGELOG.md'), 'utf8'); } catch { /* none */ }
  }
  return parseNotes(text, from, tag || null);
}

module.exports = { parseVersion, compare, latestTag, check, install, mode, parseNotes, notes };
