'use strict';
// Plain assert checks, no test framework. `node tests/run-all.js`
// Everything runs against a fake ~/.claude in a temp folder; the HTTP check
// starts its own server on port 8931 so it never touches the real one on 8930.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sessions = require('../lib/sessions');
const terminal = require('../lib/terminal');
const updater = require('../lib/updater');
const { trackClosures, Store } = require('../lib/store');
const { HostClient } = require('../lib/hostclient');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(100);
  }
}
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

// Ends whatever a test left in a session host, then stops the host itself.
async function stopHost(dataDir, pipe) {
  const c = new HostClient({ dataDir, pipe });
  await c.attach();
  if (!c.up) return;
  for (const s of c.list()) if (!s.exited) await c.request({ t: 'kill', id: s.id }).catch(() => {});
  await until(() => c.list().every((s) => s.exited), 10000).catch(() => {});
  await c.request({ t: 'shutdown' }).catch(() => {});
}

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); }
}

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';

function fakeClaude() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(dir, 'sessions'));
  const proj = path.join(dir, 'projects', 'C--work');
  fs.mkdirSync(proj, { recursive: true });
  const line = (o) => JSON.stringify(o) + '\n';
  const user = (content, extra = {}) => line({ type: 'user', cwd: work, origin: { kind: 'human' }, message: { role: 'user', content }, ...extra });
  fs.writeFileSync(path.join(proj, ID1 + '.jsonl'),
    line({ type: 'mode', mode: 'normal' }) +
    user('fix the <b>printer</b> page') +
    user([{ type: 'tool_result', content: 'ignored' }]) +
    user('<command-name>/clear</command-name>') +
    user('subagent text', { isSidechain: true }) +
    line({ type: 'ai-title', aiTitle: 'Printer page fix' }) +
    user([{ type: 'text', text: 'now   add\n tests' }]));
  fs.writeFileSync(path.join(proj, ID2 + '.jsonl'),
    user('second session') + line({ type: 'ai-title', aiTitle: 'Old title' }) + line({ type: 'custom-title', customTitle: 'My name' }));
  fs.writeFileSync(path.join(proj, ID3 + '.jsonl'), line({ type: 'mode' })); // no human prompt
  const reg = (pid, sessionId, extra = {}) => fs.writeFileSync(path.join(dir, 'sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd: work, startedAt: pid, status: 'busy', kind: 'interactive', name: 'n' + pid, ...extra }));
  reg(100, ID1);
  reg(200, ID2, { status: 'idle' });
  fs.writeFileSync(path.join(dir, 'sessions', '300.json'), '{half'); // half-written
  fs.writeFileSync(path.join(dir, 'sessions', '400.abc.key'), 'secret'); // must be ignored
  return { dir, work };
}

function request(port, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers, ...(data ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* html */ } resolve({ status: res.statusCode, json: j, text: s }); });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`${method} ${p} timed out`)));
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const fx = fakeClaude();

  await check('tasklist parsing keeps only claude.exe', () => {
    const pids = sessions.parseTasklist('"claude.exe","94796","Console","1","400,000 K"\r\n"node.exe","5","Console","1","1 K"\r\nINFO: No tasks');
    assert.deepStrictEqual([...pids], [94796]);
  });

  await check('prompt text skips tool results, wrappers, sidechains, non-human', () => {
    assert.strictEqual(sessions.promptText({ type: 'user', message: { content: 'hi' } }), 'hi');
    assert.strictEqual(sessions.promptText({ type: 'user', message: { content: [{ type: 'tool_result' }] } }), null);
    assert.strictEqual(sessions.promptText({ type: 'user', message: { content: '<command-name>x' } }), null);
    assert.strictEqual(sessions.promptText({ type: 'user', isSidechain: true, message: { content: 'x' } }), null);
    assert.strictEqual(sessions.promptText({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'x' } }), null);
    assert.strictEqual(sessions.promptText({ type: 'user', promptSource: 'sdk', entrypoint: 'sdk-cli', message: { content: 'Below is a log' } }), null);
    assert.ok(sessions.promptText({ type: 'user', message: { content: 'a'.repeat(1000) } }).length <= 300);
  });

  await check('transcript info: title, cwd, first and last prompt', () => {
    const info = sessions.lookup(fx.dir, ID1);
    assert.strictEqual(info.title, 'Printer page fix');
    assert.strictEqual(info.cwd, fx.work);
    assert.strictEqual(info.firstPrompt, 'fix the <b>printer</b> page');
    assert.strictEqual(info.lastPrompt, 'now add tests');
  });

  await check('a /rename title beats the automatic one', () => {
    assert.strictEqual(sessions.lookup(fx.dir, ID2).title, 'My name');
  });

  await check('large transcript: head and tail both read', () => {
    const p = path.join(fx.dir, 'projects', 'C--work', '44444444-4444-4444-8444-444444444444.jsonl');
    const filler = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(2000) } }) + '\n';
    fs.writeFileSync(p, JSON.stringify({ type: 'user', cwd: 'C:\\big', message: { content: 'first one' } }) + '\n' + filler.repeat(400) +
      JSON.stringify({ type: 'ai-title', aiTitle: 'Big' }) + '\n' + JSON.stringify({ type: 'user', message: { content: 'last one' } }) + '\n');
    const info = sessions.readTranscriptInfo(p);
    assert.deepStrictEqual([info.cwd, info.firstPrompt, info.lastPrompt, info.title], ['C:\\big', 'first one', 'last one', 'Big']);
    fs.unlinkSync(p);
  });

  await check('live sessions: only running pids, bad files ignored', () => {
    const live = sessions.liveSessions(fx.dir, new Set([100]));
    assert.deepStrictEqual(live.map((s) => s.sessionId), [ID1]);
    assert.strictEqual(live[0].title, 'Printer page fix');
    assert.strictEqual(sessions.liveSessions(fx.dir, new Set([100, 200])).length, 2);
  });

  await check('live sessions: tasklist failure falls back to the registry', () => {
    assert.strictEqual(sessions.liveSessions(fx.dir, null).length, 2);
  });

  await check('history excludes live ids and prompt-less sessions', () => {
    const h = sessions.history(fx.dir, { excludeIds: new Set([ID1]) });
    assert.deepStrictEqual(h.map((x) => x.sessionId), [ID2]);
  });

  await check('closure tracking: gone pid is closed, /clear in same tab is not', () => {
    const a = { pid: 1, sessionId: ID1, cwd: 'C:\\a', title: 'A' };
    const b = { pid: 2, sessionId: ID2, cwd: 'C:\\b', title: 'B' };
    let closed = trackClosures([a, b], [{ ...b, sessionId: ID3 }], 1000, []);
    assert.deepStrictEqual(closed.map((c) => c.sessionId), [ID1]);
    assert.strictEqual(closed[0].closedAt, 1000);
    closed = trackClosures([], [a], 2000, closed); // reopened: drops off the list
    assert.strictEqual(closed.length, 0);
    const old = trackClosures([], [], 8 * 86400000, [{ ...a, closedAt: 0 }]);
    assert.strictEqual(old.length, 0, 'entries expire after 7 days');
  });

  await check('store persists and only writes on change', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-store-'));
    const s = new Store(d);
    s.observe([{ pid: 1, sessionId: ID1, cwd: 'C:\\a', title: 'A', kind: 'interactive' }], 1);
    s.observe([], 2);
    const again = new Store(d);
    assert.strictEqual(again.state.closed[0].sessionId, ID1);
    const m = fs.statSync(path.join(d, 'state.json')).mtimeMs;
    again.save();
    assert.strictEqual(fs.statSync(path.join(d, 'state.json')).mtimeMs, m);
  });

  await check('wt args: resume command, ; escaped, trailing slash trimmed', () => {
    const semi = path.join(fx.dir, 'a;b');
    fs.mkdirSync(semi);
    const args = terminal.claudeTabArgs(semi + '\\', ID1);
    assert.deepStrictEqual(args.slice(0, 3), ['-w', '0', 'new-tab']);
    assert.strictEqual(args[4], semi.replace(';', '\\;'));
    assert.strictEqual(args[args.length - 1], `claude --resume ${ID1}`);
    assert.strictEqual(terminal.claudeTabArgs(fx.work).pop(), 'claude');
  });

  await check('wt args: refuse bad ids and missing or relative folders', () => {
    assert.throws(() => terminal.claudeTabArgs(fx.work, 'x; rm -rf'), /bad session id/);
    assert.throws(() => terminal.claudeTabArgs(path.join(fx.dir, 'nope'), ID1), /no longer exists/);
    assert.throws(() => terminal.claudeTabArgs('relative\\dir', ID1), /unknown folder/);
  });

  await check('updater: semver ordering, not string ordering', () => {
    assert.strictEqual(updater.latestTag(['v1.0.9', 'v1.0.10', 'v1.0.2', 'junk', 'v2.0.0-beta']), 'v1.0.10');
    assert.ok(updater.compare('v1.10.0', '1.9.9') > 0);
    assert.strictEqual(updater.compare('1.0.0', 'v1.0.0'), 0);
    assert.strictEqual(updater.latestTag([]), null);
  });

  await check('updater: install refuses a bad tag', async () => {
    await assert.rejects(updater.install(ROOT, 'v1; evil'), /bad tag/);
  });

  await check('version matches the top CHANGELOG entry', () => {
    const v = require('../package.json').version;
    const top = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').match(/^## (\d+\.\d+\.\d+)/m);
    assert.ok(top, 'CHANGELOG has no "## x.y.z" heading');
    assert.strictEqual(top[1], v);
  });

  // ---- session host + ConPTY bridge ----------------------------------------
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-host-'));
  const hostData = path.join(hostRoot, 'data');
  const hostPipe = `\\\\.\\pipe\\cs-test-host-${process.pid}`;
  const hc = new HostClient({ dataDir: hostData, pipe: hostPipe });
  try {
    await check('host: starts, runs a command in a pseudo console, takes typing', async () => {
      await hc.ensure();
      let out = '';
      hc.on('event', (m) => { if (m.t === 'out') out += Buffer.from(m.data, 'base64').toString('utf8'); });
      const r = await hc.request({ t: 'spawn', cwd: fx.work, command: 'cmd.exe /q /k echo HOST-READY', cols: 100, rows: 30 });
      const id = r.session.id;
      await until(() => strip(out).includes('HOST-READY'));
      await until(() => hc.list().find((s) => s.id === id).pid > 0);
      await hc.request({ t: 'input', id, data: 'echo typed-%COMPUTERNAME%\r' });
      await until(() => /typed-\w+/.test(strip(out)));
      await hc.request({ t: 'resize', id, cols: 140, rows: 40 });
      const rep = await hc.request({ t: 'replay', id });
      assert.ok(strip(Buffer.from(rep.data, 'base64').toString('utf8')).includes('HOST-READY'), 'replay holds earlier output');
      await hc.request({ t: 'kill', id });
      await until(() => hc.list().find((s) => s.id === id).exited, 10000);
    });

    await check('host: a second dashboard connection sees the running sessions (survives restarts)', async () => {
      const r = await hc.request({ t: 'spawn', cwd: fx.work, command: 'cmd.exe /q /k echo AGAIN', cols: 80, rows: 24 });
      const other = new HostClient({ dataDir: hostData, pipe: hostPipe });
      await other.attach();
      assert.ok(other.up);
      assert.ok(other.list().some((s) => s.id === r.session.id && !s.exited));
      other.sock.destroy();
    });

    await check('host: refuses shutdown while a session runs', async () => {
      await assert.rejects(hc.request({ t: 'shutdown' }), /still running/);
    });

    await check('host: wrong token is refused', async () => {
      const bad = new HostClient({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bad-')), pipe: hostPipe });
      await assert.rejects(bad._connect(), /refused/);
    });
  } finally {
    if (hc.sock) hc.sock.destroy();
    await stopHost(hostData, hostPipe);
  }

  // ---- HTTP contract -------------------------------------------------------
  const PORT = 8931;
  const data = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-data-')), 'data');
  fs.mkdirSync(data);
  const httpPipe = `\\\\.\\pipe\\cs-test-http-${process.pid}`;
  // What a server leaves behind right before it installs v0.0.1 and restarts.
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ update: { current: '0.0.0', latest: 'v0.0.1', available: true, mode: 'release' } }));
  // Hold the port briefly, like an old server mid-restart, so the server has to retry.
  const blocker = require('net').createServer((sock) => sock.destroy());
  await new Promise((r) => blocker.listen(PORT, '127.0.0.1', r));
  setTimeout(() => blocker.close(), 700);
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env, CS_PORT: String(PORT), CS_CLAUDE_DIR: fx.dir, CS_DATA: data, CS_FAKE_PIDS: '100,200', CS_TEST: '1',
      CS_HOST_PIPE: httpPipe, CS_CLAUDE_CMD: 'cmd.exe /q /k echo APP-READY',
    },
    stdio: 'ignore', windowsHide: true,
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await new Promise((r) => setTimeout(r, 150));
      up = await request(PORT, 'GET', '/api/ping').then((r) => r.status === 200, () => false);
    }
    const H = { 'X-Claude-Sessions': '1' };

    await check('http: port retry after a restart starts the server only once', () => {
      assert.ok(up, 'server never came up after the port was freed');
      const lines = fs.readFileSync(path.join(data, 'server.log'), 'utf8').split('\n').filter((l) => l.includes('listening'));
      assert.strictEqual(lines.length, 1);
    });

    await check('http: state lists live sessions', async () => {
      const r = await request(PORT, 'GET', '/api/state');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json.live.map((s) => s.sessionId).sort(), [ID1, ID2]);
      assert.strictEqual(r.json.folders[0], fx.work);
    });

    await check('http: a saved update older than the running version is not offered', async () => {
      const r = await request(PORT, 'GET', '/api/state');
      assert.strictEqual(r.json.update.available, false);
      assert.strictEqual(r.json.update.current, require('../package.json').version);
      const inst = await request(PORT, 'POST', '/api/update/install', { body: {}, headers: H });
      assert.strictEqual(inst.status, 400);
    });

    await check('http: page is served', async () => {
      const r = await request(PORT, 'GET', '/');
      assert.strictEqual(r.status, 200);
      assert.ok(r.text.includes('<title>Claude Sessions</title>'));
    });

    await check('http: foreign Host header is refused (DNS rebinding)', async () => {
      const r = await request(PORT, 'GET', '/api/state', { headers: { Host: 'evil.example:8931' } });
      assert.strictEqual(r.status, 403);
    });

    await check('http: POST without the app header is refused (CSRF)', async () => {
      const r = await request(PORT, 'POST', '/api/rename', { body: { sessionId: ID1, name: 'x' } });
      assert.strictEqual(r.status, 403);
    });

    await check('http: POST from another origin is refused', async () => {
      const r = await request(PORT, 'POST', '/api/rename', { body: { sessionId: ID1, name: 'x' }, headers: { ...H, Origin: 'https://evil.example' } });
      assert.strictEqual(r.status, 403);
    });

    await check('http: rename sets and clears a nickname', async () => {
      await request(PORT, 'POST', '/api/rename', { body: { sessionId: ID1, name: '  Printer work  ' }, headers: H });
      let s = (await request(PORT, 'GET', '/api/state')).json;
      assert.strictEqual(s.live.find((x) => x.sessionId === ID1).nickname, 'Printer work');
      await request(PORT, 'POST', '/api/rename', { body: { sessionId: ID1, name: '' }, headers: H });
      s = (await request(PORT, 'GET', '/api/state')).json;
      assert.strictEqual(s.live.find((x) => x.sessionId === ID1).nickname, null);
    });

    await check('http: resume of an open session is refused', async () => {
      const r = await request(PORT, 'POST', '/api/resume', { body: { sessionId: ID1 }, headers: H });
      assert.strictEqual(r.status, 409);
    });

    await check('http: closing a session shows it under Recently closed, resume builds the right tab', async () => {
      fs.unlinkSync(path.join(fx.dir, 'sessions', '200.json'));
      let s;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        s = (await request(PORT, 'GET', '/api/state')).json;
        if (s.closed.length) break;
      }
      assert.deepStrictEqual(s.closed.map((c) => c.sessionId), [ID2]);
      assert.ok(!s.history.some((h) => h.sessionId === ID2), 'closed sessions are not repeated in history');
      const wt = await request(PORT, 'POST', '/api/resume', { body: { sessionId: ID2, where: 'terminal' }, headers: H });
      assert.strictEqual(wt.status, 200);
      assert.strictEqual(wt.json.args[wt.json.args.length - 1], `claude --resume ${ID2}`);
      const inApp = await request(PORT, 'POST', '/api/resume', { body: { sessionId: ID2 }, headers: H });
      assert.strictEqual(inApp.status, 200, JSON.stringify(inApp.json));
      assert.ok(inApp.json.id, 'reopening defaults to an in-app terminal');
      const t = (await request(PORT, 'GET', '/api/state')).json.terminals.list.find((x) => x.id === inApp.json.id);
      assert.strictEqual(t.resumeId, ID2);
    });

    await check('http: new session only in a known folder', async () => {
      const bad = await request(PORT, 'POST', '/api/new', { body: { cwd: 'C:\\Windows' }, headers: H });
      assert.strictEqual(bad.status, 400);
      const ok = await request(PORT, 'POST', '/api/new', { body: { cwd: fx.work }, headers: H });
      assert.strictEqual(ok.status, 200);
    });

    await check('http: oversized body is rejected', async () => {
      const r = await request(PORT, 'POST', '/api/rename', { body: { sessionId: ID1, name: 'x'.repeat(300000) }, headers: H });
      assert.strictEqual(r.status, 413);
    });

    await check('http: a cross-site request is refused even with the header', async () => {
      const r = await request(PORT, 'GET', '/api/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
      assert.strictEqual(r.status, 403);
      const s = await request(PORT, 'GET', '/api/term/stream', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
      assert.strictEqual(s.status, 403, 'terminal output is not readable cross-site');
      const page = await request(PORT, 'GET', '/', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } });
      assert.strictEqual(page.status, 200, 'opening the page from a link still works');
    });

    await check('http: in-app terminal: start, stream, type, end, close', async () => {
      let streamed = '';
      const events = [];
      const sreq = http.get({ host: '127.0.0.1', port: PORT, path: '/api/term/stream', headers: { Host: `127.0.0.1:${PORT}` } }, (res) => {
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (!block.startsWith('data: ')) continue;
            const m = JSON.parse(block.slice(6));
            events.push(m);
            if ((m.t === 'out' || m.t === 'replay') && m.data) streamed += Buffer.from(m.data, 'base64').toString('utf8');
          }
        });
      });
      try {
        const r = await request(PORT, 'POST', '/api/new', { body: { cwd: fx.work, cols: 100, rows: 30 }, headers: H });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        const id = r.json.id;
        await until(() => strip(streamed).includes('APP-READY'), 15000);
        const typed = await request(PORT, 'POST', '/api/term/input', { body: { id, data: 'echo via-http-ok\r' }, headers: H });
        assert.strictEqual(typed.status, 200);
        await until(() => strip(streamed).includes('via-http-ok'));
        assert.strictEqual((await request(PORT, 'POST', '/api/term/resize', { body: { id, cols: 90, rows: 20 }, headers: H })).status, 200);
        const st = (await request(PORT, 'GET', '/api/state')).json;
        assert.ok(st.terminals.up && st.terminals.list.some((t) => t.id === id && !t.exited));
        await request(PORT, 'POST', '/api/term/kill', { body: { id }, headers: H });
        await until(() => events.some((m) => m.t === 'exit' && m.session.id === id), 10000);
        const late = await request(PORT, 'POST', '/api/term/input', { body: { id, data: 'x' }, headers: H });
        assert.strictEqual(late.status, 409, 'typing into an ended session is refused');
        await request(PORT, 'POST', '/api/term/forget', { body: { id }, headers: H });
        const after = (await request(PORT, 'GET', '/api/state')).json;
        assert.ok(!after.terminals.list.some((t) => t.id === id));
      } finally {
        sreq.destroy();
      }
    });

    await check('http: Move here only while idle', async () => {
      const busy = await request(PORT, 'POST', '/api/move', { body: { sessionId: ID1 }, headers: H });
      assert.strictEqual(busy.status, 409);
      // pid 200 is free again after the closing test; give it an idle session.
      fs.writeFileSync(path.join(fx.dir, 'sessions', '200.json'),
        JSON.stringify({ pid: 200, sessionId: ID3, cwd: fx.work, startedAt: 5, status: 'idle', kind: 'interactive' }));
      await until(async () => (await request(PORT, 'GET', '/api/state')).json.live.some((s) => s.sessionId === ID3));
      const idle = await request(PORT, 'POST', '/api/move', { body: { sessionId: ID3, cols: 80, rows: 24 }, headers: H });
      assert.strictEqual(idle.status, 200, JSON.stringify(idle.json));
      assert.ok(idle.json.id);
    });
  } finally {
    srv.kill();
    await stopHost(data, httpPipe);
  }

  const total = passed + failures.length;
  if (failures.length) {
    console.log(`FAILED ${failures.length} of ${total}`);
    for (const f of failures) console.log('  x ' + f);
    process.exit(1);
  }
  console.log(`all ${total} checks passed`);
})();
