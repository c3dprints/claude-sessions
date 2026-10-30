'use strict';
// Groups: in-app sessions shown side by side under one name, which can message each other.
// A session started in the app gets a small MCP server (scripts/team-mcp.js) with a key
// that names its terminal; the dashboard checks the key and delivers a message into the
// teammate's terminal as a prompt, only while that teammate is idle (never into an open
// permission prompt). A run of agent messages with no human typing in between stops at
// RUN_LIMIT, so two sessions can not talk to each other forever.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MCP_NAME = 'sessions-team';
// Tests shorten the limit and the wait between two messages to one terminal.
const TEST = process.env.CS_TEST === '1';
const RUN_LIMIT = TEST && process.env.CS_TEAM_RUN_LIMIT ? Number(process.env.CS_TEAM_RUN_LIMIT) : 20;
const MSG_MAX = 20000;
const LOG_MAX = 300;
const COOLDOWN_MS = TEST && process.env.CS_TEAM_COOLDOWN ? Number(process.env.CS_TEAM_COOLDOWN) : 12000;
const LAYOUTS = ['cols', 'rows', 'grid'];

function secret(dataDir) {
  const file = path.join(dataDir, 'team.key');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* create below */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

function tokenFor(sec, key) {
  return crypto.createHmac('sha256', sec).update(String(key)).digest('hex');
}

function tokenOk(sec, key, token) {
  if (!/^[0-9a-f]{18}$/.test(String(key)) || typeof token !== 'string' || token.length !== 64) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(tokenFor(sec, key)));
}

// Writes the --mcp-config file for one new terminal. Returns { key, file }.
function writeConfig(dataDir, appDir, port) {
  const dir = path.join(dataDir, 'team');
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.randomBytes(9).toString('hex');
  const file = path.join(dir, `${key}.json`);
  const cfg = {
    mcpServers: {
      [MCP_NAME]: {
        type: 'stdio',
        command: process.execPath,
        args: [path.join(appDir, 'scripts', 'team-mcp.js')],
        env: { CS_TEAM_URL: `http://127.0.0.1:${port}`, CS_TEAM_KEY: key, CS_TEAM_TOKEN: tokenFor(secret(dataDir), key) },
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 1), { mode: 0o600 });
  return { key, file };
}

// Keys (and their config files) of terminals the host no longer has.
function pruneKeys(dataDir, keys, termIds) {
  let changed = false;
  for (const [k, tid] of Object.entries(keys)) {
    if (termIds.has(tid)) continue;
    delete keys[k];
    try { fs.unlinkSync(path.join(dataDir, 'team', `${k}.json`)); } catch { /* gone */ }
    changed = true;
  }
  return changed;
}

function checkName(v, what, max) {
  const s = String(v == null ? '' : v).replace(/[\r\n\t"]/g, ' ').trim().slice(0, max);
  if (!s) throw Object.assign(new Error(`give the ${what} a name`), { code: 400 });
  return s;
}

// Members follow their Claude session: a reopened session runs in a new terminal
// (its resumeId is the old session id), and /clear changes the session id in the same terminal.
function syncGroups(groups, terms) {
  let changed = false;
  const alive = terms.filter((t) => !t.exited);
  for (const g of groups) {
    for (const m of g.members) {
      const t = terms.find((x) => x.id === m.tid);
      if ((!t || t.exited) && m.sid) {
        const n = alive.find((x) => (x.sessionId === m.sid || x.resumeId === m.sid) && !groups.some((o) => o.members.some((om) => om.tid === x.id)));
        if (n) { m.tid = n.id; changed = true; }
      }
      const now = terms.find((x) => x.id === m.tid);
      if (now && !now.exited && now.sessionId && now.sessionId !== m.sid) { m.sid = now.sessionId; changed = true; }
    }
  }
  return changed;
}

function groupOf(groups, tid) {
  return groups.find((g) => g.members.some((m) => m.tid === tid)) || null;
}

// "Build", "build", or "all"; the sender is never a recipient.
function recipients(group, fromTid, to) {
  const others = group.members.filter((m) => m.tid !== fromTid);
  const want = String(to || '').trim().toLowerCase();
  if (want === 'all' || want === 'everyone') return others;
  return others.filter((m) => m.role.toLowerCase() === want);
}

// The last thing Claude wrote in a transcript (text only, no tool calls).
function lastReply(file, tailBytes = 1024 * 1024) {
  let fd;
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, tailBytes);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"type":"assistant"')) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.isSidechain || !o.message || !Array.isArray(o.message.content)) continue;
      const text = o.message.content.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n\n').trim();
      if (text) return text.length > MSG_MAX ? text.slice(0, MSG_MAX) + '\n[cut short]' : text;
    }
  } catch { /* no transcript yet */ } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

function messageText(msgs, groupName) {
  return msgs.map((m) => (m.kind === 'agent'
    ? `[Team message from ${m.fromRole} in group "${groupName}". Answer with the send_message tool, to "${m.fromRole}", only if it needs an answer.]\n${m.text}`
    : `[From ${m.fromRole} in group "${groupName}", passed on by the user]\n${m.text}`)).join('\n\n');
}

// What to type into a terminal. With bracketed paste on, the text keeps its lines and
// arrives as one paste; without it every newline would send the prompt early.
function typed(text, bracketed) {
  const clean = text.replace(/\x1b/g, '').replace(/\r\n?/g, '\n');
  return bracketed ? `\x1b[200~${clean}\x1b[201~` : clean.replace(/\n+/g, ' ');
}

module.exports = {
  MCP_NAME, RUN_LIMIT, MSG_MAX, LOG_MAX, COOLDOWN_MS, LAYOUTS,
  secret, tokenFor, tokenOk, writeConfig, pruneKeys, checkName, syncGroups, groupOf, recipients, lastReply, messageText, typed,
};
