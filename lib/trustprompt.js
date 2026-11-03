// Answers Claude Code's folder trust question ("Quick safety check: Is this a project you
// created or one you trust?") with "Yes, I trust this folder". The answers' order has changed
// between versions (2.x lists "No, exit" first, with the pointer on it), so this keeps a rough
// copy of the screen and moves the ❯ pointer onto the Yes row before pressing Enter.

const YES = 'Yes, I trust this folder';
const POINTER = '❯';

// Just enough of a terminal to know what text is on which row: cursor moves, erasing and
// printing. ConPTY draws with absolute cursor moves, so scrolling is not needed.
class Screen {
  constructor() { this.rows = new Map(); this.r = 1; this.c = 1; }

  row(r) {
    if (!this.rows.has(r)) this.rows.set(r, []);
    return this.rows.get(r);
  }

  feed(s) {
    for (let i = 0; i < s.length;) {
      const ch = s[i];
      if (ch === '\x1b') { i = this.escape(s, i); continue; }
      if (ch === '\r') this.c = 1;
      else if (ch === '\n') this.r++;
      else if (ch === '\b') this.c = Math.max(1, this.c - 1);
      else if (ch >= ' ') this.row(this.r)[this.c++ - 1] = ch;
      i++;
    }
  }

  // Returns the index after the escape sequence starting at i.
  escape(s, i) {
    const k = s[i + 1];
    if (k === '[') {
      let j = i + 2;
      while (j < s.length && !(s[j] >= '@' && s[j] <= '~')) j++;
      if (j < s.length) this.csi(s.slice(i + 2, j), s[j]);
      return j + 1;
    }
    if (k === ']' || k === 'P' || k === '_') { // strings end with BEL or ESC \
      for (let j = i + 2; j < s.length; j++) {
        if (s[j] === '\x07') return j + 1;
        if (s[j] === '\x1b' && s[j + 1] === '\\') return j + 2;
      }
      return s.length;
    }
    if (k === '(' || k === ')') return i + 3;
    return i + 2;
  }

  csi(params, final) {
    if (/[?<>=]/.test(params)) return; // modes and queries
    const n = params.split(';').map((x) => parseInt(x, 10));
    const a = n[0] || 1;
    switch (final) {
      case 'H': case 'f': this.r = n[0] || 1; this.c = n[1] || 1; break;
      case 'A': this.r = Math.max(1, this.r - a); break;
      case 'B': this.r += a; break;
      case 'C': this.c += a; break;
      case 'D': this.c = Math.max(1, this.c - a); break;
      case 'G': this.c = a; break;
      case 'd': this.r = a; break;
      case 'K': {
        const row = this.row(this.r);
        if (!n[0]) row.length = Math.min(row.length, this.c - 1);
        else if (n[0] === 1) for (let x = 0; x < this.c && x < row.length; x++) row[x] = ' ';
        else row.length = 0;
        break;
      }
      case 'J':
        if (n[0] === 2 || n[0] === 3) this.rows.clear();
        else if (!n[0]) {
          for (const r of [...this.rows.keys()]) if (r > this.r) this.rows.delete(r);
          const row = this.row(this.r);
          row.length = Math.min(row.length, this.c - 1);
        }
        break;
      case 'X': { const row = this.row(this.r); for (let x = 0; x < a; x++) if (this.c - 1 + x < row.length) row[this.c - 1 + x] = ' '; break; }
      default: break;
    }
  }

  // [{ r, text }] top to bottom; gaps in a row read as spaces.
  lines() {
    return [...this.rows.keys()].sort((x, y) => x - y)
      .map((r) => ({ r, text: Array.from(this.rows.get(r), (ch) => ch || ' ').join('') }));
  }
}

// The key that brings the trust question closer to "Yes": Enter when the pointer is on it,
// otherwise Down or Up. null while the question is not (fully) on the screen.
function keyFor(screen) {
  const lines = screen.lines();
  if (!lines.some((l) => /Enter to confirm/.test(l.text))) return null;
  const yes = lines.find((l) => l.text.includes(YES));
  const at = lines.find((l) => l.text.includes(POINTER));
  if (!yes || !at) return null;
  if (at.r === yes.r) return '\r';
  return at.r < yes.r ? '\x1b[B' : '\x1b[A';
}

module.exports = { Screen, keyFor, YES };
