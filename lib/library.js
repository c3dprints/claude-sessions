'use strict';
// Read-only views of the user's notes and Claude's add-ons:
//   wiki    markdown pages in the wiki folders (set in the app) plus
//           Claude's auto memory (~/.claude/projects/<slug>/memory/*.md)
//   skills  personal, claude.ai-synced, plugin and project skills and commands
// Nothing here writes anywhere.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAGE_MAX = 256 * 1024;
const SLOW_MS = 4000; // a network share that is offline must not stall the app

function idOf(file) {
  return crypto.createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 12);
}

function tokens(chars) {
  return Math.ceil(chars / 4);
}

// The YAML subset Claude's skill and memory files use: `key: value`,
// quoted values, and `>` / `|` blocks.
function frontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text.replace(/^﻿/, '') };
  const data = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      v = block.join(v[0] === '>' ? ' ' : '\n').trim();
    } else if (/^"(.*)"$/.test(v)) {
      try { v = JSON.parse(v); } catch { v = v.slice(1, -1); }
    } else if (/^'(.*)'$/.test(v)) {
      v = v.slice(1, -1).replace(/''/g, "'");
    }
    data[kv[1]] = v;
  }
  // metadata.type sits one level down, which the flat parser above skips.
  const t = /^\s+type:\s*(\w+)/m.exec(m[1]);
  if (t && !data.type) data.type = t[1];
  return { data, body: text.slice(m[0].length) };
}

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Every top-level .md file in a folder; null when the folder cannot be read.
async function readMarkdownDir(dir) {
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return null; }
  const out = [];
  for (const n of names) {
    if (!/\.md$/i.test(n)) continue;
    const file = path.join(dir, n);
    try {
      const st = await fs.promises.stat(file);
      if (!st.isFile()) continue;
      const fd = await fs.promises.open(file, 'r');
      let text;
      try {
        const buf = Buffer.alloc(Math.min(st.size, PAGE_MAX));
        const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
        text = buf.toString('utf8', 0, bytesRead);
      } finally { await fd.close(); }
      out.push({ file, name: n.replace(/\.md$/i, ''), mtime: st.mtimeMs, size: st.size, text, truncated: st.size > PAGE_MAX });
    } catch { /* unreadable page: skip it */ }
  }
  return out;
}

function headingOf(body) {
  const m = /^#\s+(.+)$/m.exec(body);
  return m ? m[1].trim() : null;
}

function home(p) {
  return String(p).replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');
}

// Claude names a project folder by turning every character that is not a letter or digit into "-".
function slugOf(dir) {
  return String(dir).replace(/[^A-Za-z0-9]/g, '-');
}

// Auto memory folders, one per project Claude has remembered things for.
function memoryDirs(claudeDir) {
  const root = path.join(claudeDir, 'projects');
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  return names.map((n) => ({ slug: n, dir: path.join(root, n, 'memory') }))
    .filter((d) => fs.existsSync(d.dir));
}

async function wiki({ claudeDir, wikiDirs, folders = [] }) {
  const groups = [];
  for (const dir of wikiDirs) {
    const pages = await withTimeout(readMarkdownDir(dir), SLOW_MS, undefined);
    groups.push({
      key: 'wiki:' + dir,
      label: 'Wiki',
      where: dir,
      error: pages === undefined ? 'took too long to answer (is the share online?)' : pages === null ? 'folder not reachable' : null,
      pages: (pages || []).map((p) => {
        const { body } = frontmatter(p.text);
        return { id: idOf(p.file), name: p.name, title: headingOf(body) || p.name, file: p.file, mtime: p.mtime, size: p.size, truncated: p.truncated, text: body };
      }).sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  // A memory slug cannot be turned back into a path for sure, so known folders name it when they can.
  const bySlug = new Map(folders.map((f) => [slugOf(f), f]));
  for (const m of memoryDirs(claudeDir)) {
    const pages = (await readMarkdownDir(m.dir)) || [];
    if (!pages.length) continue;
    groups.push({
      key: 'memory:' + m.slug,
      label: 'Claude memory',
      where: bySlug.has(m.slug) ? home(bySlug.get(m.slug)) : m.slug,
      error: null,
      pages: pages.map((p) => {
        const { data, body } = frontmatter(p.text);
        const index = p.name.toUpperCase() === 'MEMORY';
        return {
          id: idOf(p.file),
          name: index ? 'MEMORY' : (data.name || p.name),
          title: index ? 'Memory index' : (headingOf(body) || data.name || p.name),
          description: data.description || null,
          type: data.type || null,
          file: p.file, mtime: p.mtime, size: p.size, truncated: p.truncated, text: body,
          index,
        };
      }).sort((a, b) => (b.index - a.index) || a.name.localeCompare(b.name)),
    });
  }
  return groups;
}

// ---- skills ------------------------------------------------------------------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

function skillDirs(dir) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return names.filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => path.join(dir, d.name, 'SKILL.md'))
    .filter((f) => fs.existsSync(f));
}

function commandFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith('.md')).map((n) => path.join(dir, n));
}

function describe(file, kind, source, prefix, enabled) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const { data } = frontmatter(text);
  const base = kind === 'skill' ? path.basename(path.dirname(file)) : path.basename(file, '.md');
  const name = String(data.name || base);
  const description = String(data.description || '');
  return {
    id: idOf(file),
    name,
    qualified: prefix ? `${prefix}:${name}` : name,
    kind,
    source,
    description,
    enabled,
    file,
    listTokens: tokens(name.length + description.length + 6),
    fullTokens: tokens(text.length),
  };
}

function skills({ claudeDir, folders = [] }) {
  const settings = readJson(path.join(claudeDir, 'settings.json')) || {};
  const enabledPlugins = settings.enabledPlugins || {};
  const out = [];
  const add = (x) => { if (x) out.push(x); };

  const own = path.join(claudeDir, 'skills');
  for (const f of skillDirs(own)) {
    if (/[\\/](synced|learned)[\\/]SKILL\.md$/i.test(f)) continue;
    add(describe(f, 'skill', 'Personal', '', true));
  }
  for (const f of skillDirs(path.join(own, 'learned'))) add(describe(f, 'skill', 'Learned', '', true));
  for (const f of commandFiles(path.join(claudeDir, 'commands'))) add(describe(f, 'command', 'Personal', '', true));

  let buckets = [];
  try { buckets = fs.readdirSync(path.join(own, 'synced')).filter((n) => !n.startsWith('.')); } catch { /* none */ }
  for (const b of buckets) {
    for (const f of skillDirs(path.join(own, 'synced', b))) add(describe(f, 'skill', 'claude.ai', 'anthropic-skills', true));
  }

  const installed = (readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json')) || {}).plugins || {};
  for (const [key, entries] of Object.entries(installed)) {
    const entry = Array.isArray(entries) ? entries[entries.length - 1] : entries;
    if (!entry || !entry.installPath) continue;
    const plugin = key.split('@')[0];
    const on = enabledPlugins[key] === true;
    const label = `Plugin ${plugin}` + (entry.version ? ` ${entry.version}` : '');
    for (const f of skillDirs(path.join(entry.installPath, 'skills'))) add(describe(f, 'skill', label, plugin, on));
    for (const f of commandFiles(path.join(entry.installPath, 'commands'))) add(describe(f, 'command', label, plugin, on));
  }

  for (const folder of folders) {
    const dir = path.join(folder, '.claude');
    if (path.resolve(dir).toLowerCase() === path.resolve(claudeDir).toLowerCase()) continue; // home folder: already listed as Personal
    const src = `Project ${home(folder)}`;
    for (const f of skillDirs(path.join(dir, 'skills'))) add(describe(f, 'skill', src, '', true));
    for (const f of commandFiles(path.join(dir, 'commands'))) add(describe(f, 'command', src, '', true));
  }

  const seen = new Set();
  return out.filter((s) => (seen.has(s.id) ? false : seen.add(s.id)))
    .sort((a, b) => a.qualified.localeCompare(b.qualified));
}

module.exports = { frontmatter, wiki, skills, idOf, tokens, slugOf, readJson, home };
