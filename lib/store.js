'use strict';
// The app's own state, kept outside the install folder so updates never touch it.

const fs = require('fs');
const path = require('path');

const CLOSED_KEEP_MS = 7 * 86400000;
const CLOSED_MAX = 50;

const WIKI_DEFAULT = ['\\\\Mobius\\Chris'];

// projects: [{ id, name, color, folders: [path] }]
// assign:   { sessionId: projectId | 'none' }, a choice made by hand that beats the folder match
function defaults() {
  return {
    nicknames: {}, closed: [], lastLive: [], projects: [], assign: {},
    settings: { autoUpdate: false, wikiDirs: WIKI_DEFAULT, theme: 'system', terminal: null }, update: {},
  };
}

function inside(cwd, folder) {
  const c = String(cwd || '').toLowerCase().replace(/[\\/]+$/, '');
  const f = String(folder || '').toLowerCase().replace(/[\\/]+$/, '');
  return !!f && (c === f || c.startsWith(f + '\\') || c.startsWith(f + '/'));
}

// The project a session belongs to: picked by hand, else the project with the
// deepest folder that holds the session's folder.
function projectOf(state, s) {
  const pick = state.assign[s.sessionId];
  if (pick === 'none') return null;
  if (pick && state.projects.some((p) => p.id === pick)) return pick;
  let best = null;
  let depth = -1;
  for (const p of state.projects) {
    for (const f of p.folders) {
      if (inside(s.cwd, f) && f.length > depth) { best = p.id; depth = f.length; }
    }
  }
  return best;
}

function brief(s) {
  return { sessionId: s.sessionId, pid: s.pid, cwd: s.cwd, title: s.title || s.firstPrompt || s.name || null };
}

// A session counts as closed when its claude process is gone. Matching on pid,
// not sessionId: /clear or /resume inside a tab swaps the session but the tab is still open.
function trackClosures(prevLive, nowLive, now, closed) {
  const nowPids = new Set(nowLive.map((s) => s.pid));
  const nowIds = new Set(nowLive.map((s) => s.sessionId));
  let out = closed.filter((c) => !nowIds.has(c.sessionId) && now - c.closedAt < CLOSED_KEEP_MS);
  for (const p of prevLive) {
    if (nowPids.has(p.pid) || nowIds.has(p.sessionId)) continue;
    out = out.filter((c) => c.sessionId !== p.sessionId);
    out.unshift({ ...p, closedAt: now });
  }
  return out.slice(0, CLOSED_MAX);
}

class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'state.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.state = defaults();
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = { ...defaults(), ...saved, settings: { ...defaults().settings, ...(saved.settings || {}) } };
    } catch { /* first run or unreadable: start clean */ }
    this.lastWritten = JSON.stringify(this.state);
  }

  save() {
    const json = JSON.stringify(this.state);
    if (json === this.lastWritten) return;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    fs.renameSync(tmp, this.file);
    this.lastWritten = json;
  }

  observe(live, now = Date.now()) {
    const interactive = live.filter((s) => s.kind === 'interactive').map(brief);
    this.state.closed = trackClosures(this.state.lastLive, interactive, now, this.state.closed);
    this.state.lastLive = interactive;
    this.save();
  }
}

module.exports = { Store, trackClosures, projectOf, inside, CLOSED_KEEP_MS };
