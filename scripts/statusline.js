'use strict';
// Claude Code status line for Claude Sessions. Claude Code runs this after
// each response with the session's status as JSON on stdin. It saves what the
// dashboard needs (context window, plan usage) next to itself and prints a
// short line for the bottom of the terminal.
// The app copies this file into its data folder, so updates never move it.

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'status');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

function pct(n) {
  return typeof n === 'number' && isFinite(n) ? Math.round(n) + '%' : null;
}

function line(d) {
  const parts = [];
  if (d.model && d.model.display_name) parts.push(d.model.display_name);
  const cw = d.context_window || {};
  const ctx = pct(cw.used_percentage);
  if (ctx) parts.push(`context ${ctx}`);
  const rl = d.rate_limits || {};
  const five = rl.five_hour && pct(rl.five_hour.used_percentage);
  if (five) {
    let s = `5h ${five}`;
    if (rl.five_hour.resets_at) {
      const t = new Date(rl.five_hour.resets_at * 1000);
      s += ` (resets ${t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})`;
    }
    parts.push(s);
  }
  const week = rl.seven_day && pct(rl.seven_day.used_percentage);
  if (week) parts.push(`week ${week}`);
  return parts.join(' · ');
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let d;
  try { d = JSON.parse(raw); } catch { return; }
  const now = Date.now();
  try {
    fs.mkdirSync(OUT, { recursive: true });
    if (UUID_RE.test(String(d.session_id))) {
      writeJson(path.join(OUT, `${d.session_id}.json`), {
        at: now,
        sessionId: d.session_id,
        cwd: (d.workspace && d.workspace.current_dir) || d.cwd || null,
        model: d.model || null,
        context_window: d.context_window || null,
        cost: d.cost || null,
      });
    }
    // Plan usage is account-wide, so whichever session spoke last has the newest numbers.
    if (d.rate_limits && Object.keys(d.rate_limits).length) {
      writeJson(path.join(OUT, 'usage.json'), { at: now, rate_limits: d.rate_limits });
    }
  } catch { /* the status line must still print */ }
  process.stdout.write(line(d));
});
