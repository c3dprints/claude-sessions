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
const { trackClosures, Store, projectOf } = require('../lib/store');
const library = require('../lib/library');
const usage = require('../lib/usage');
const { HostClient } = require('../lib/hostclient');

const WIN = process.platform === 'win32';
// Harmless stand-ins for claude that print a marker, then wait for typing.
const shellCmd = (marker) => (WIN ? `cmd.exe /q /k echo ${marker}` : `/bin/sh -c 'echo ${marker}; exec /bin/sh'`);
const testPipe = (name) => (WIN ? `\\\\.\\pipe\\${name}-${process.pid}` : path.join(os.tmpdir(), `${name}-${process.pid}.sock`));

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
  const assistant = (input, model) => line({ type: 'assistant', timestamp: '2026-10-28T12:00:00.000Z', message: { model, usage: { input_tokens: 10, cache_creation_input_tokens: input ? input - 10 : 0, cache_read_input_tokens: 0, output_tokens: 50 } } });
  fs.writeFileSync(path.join(proj, ID1 + '.jsonl'),
    line({ type: 'mode', mode: 'normal' }) +
    user('fix the <b>printer</b> page') +
    user([{ type: 'tool_result', content: 'ignored' }]) +
    user('<command-name>/clear</command-name>') +
    user('subagent text', { isSidechain: true }) +
    assistant(1000, 'claude-test-1') +
    assistant(0) + // synthetic message: no usage, must be skipped
    line({ type: 'ai-title', aiTitle: 'Printer page fix' }) +
    user([{ type: 'text', text: 'now   add\n tests' }]) +
    assistant(5000, 'claude-test-1'));
  // What Claude Code loads for that folder: a CLAUDE.md and the auto memory index.
  fs.writeFileSync(path.join(work, 'CLAUDE.md'), 'x'.repeat(400));
  const mem = path.join(dir, 'projects', library.slugOf(work), 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '- [Ports](ports.md) - which app uses which port\n');
  fs.writeFileSync(path.join(mem, 'ports.md'), '---\nname: ports\ndescription: "Every app and its port"\nmetadata:\n  type: reference\n---\n\nSee [[MEMORY]].\n');
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

  await check('ps parsing keeps only claude', () => {
    const pids = sessions.parsePs('  1470 claude\n 2001 /Users/a/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe\n   5 /usr/local/bin/node\n  77 claude-helper\n');
    assert.deepStrictEqual([...pids], [1470, 2001]);
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

  if (!WIN) await check('Terminal.app args: folder quoted for sh, trailing slash trimmed', () => {
    const odd = path.join(fx.dir, "it's here");
    fs.mkdirSync(odd);
    const args = terminal.claudeTabArgs(odd + '/', ID1);
    assert.strictEqual(args[0], '-e');
    assert.strictEqual(args[2], `cd '${odd.replace("'", "'\\''")}' && claude --resume ${ID1}`);
    assert.ok(terminal.claudeTabArgs(fx.work).pop().endsWith('&& claude'));
  });

  if (WIN) await check('wt args: resume command, ; escaped, trailing slash trimmed', () => {
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
    assert.throws(() => terminal.claudeTabArgs(WIN ? 'relative\\dir' : 'relative/dir', ID1), /unknown folder/);
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

  // ---- projects, wiki, skills, context, plan usage -----------------------------
  await check('projects: deepest folder wins, a hand-picked project or "none" beats folders', () => {
    const st = {
      projects: [{ id: 'a', folders: ['C:\\code'] }, { id: 'b', folders: ['C:\\code\\makerq\\'] }],
      assign: { [ID2]: 'a', [ID3]: 'none' },
    };
    assert.strictEqual(projectOf(st, { sessionId: ID1, cwd: 'C:\\Code\\MakerQ\\web' }), 'b');
    assert.strictEqual(projectOf(st, { sessionId: ID1, cwd: 'C:\\code' }), 'a');
    assert.strictEqual(projectOf(st, { sessionId: ID1, cwd: 'C:\\codex' }), null, 'a folder name prefix is not inside it');
    assert.strictEqual(projectOf(st, { sessionId: ID2, cwd: 'C:\\code\\makerq' }), 'a');
    assert.strictEqual(projectOf(st, { sessionId: ID3, cwd: 'C:\\code' }), null);
    assert.strictEqual(projectOf({ ...st, assign: { [ID1]: 'deleted' } }, { sessionId: ID1, cwd: 'C:\\code' }), 'a');
  });

  await check('frontmatter: quoted values, folded blocks, nested type', () => {
    const { data, body } = library.frontmatter('---\nname: x\ndescription: "say \\"hi\\""\nlong: >\n  one\n  two\nmetadata:\n  type: project\n---\n# Body\n');
    assert.strictEqual(data.name, 'x');
    assert.strictEqual(data.description, 'say "hi"');
    assert.strictEqual(data.long, 'one two');
    assert.strictEqual(data.type, 'project');
    assert.strictEqual(body, '# Body\n');
    assert.deepStrictEqual(library.frontmatter('# none').data, {});
  });

  await check('context: first and last reply give startup cost and total; memory files counted', () => {
    const c = usage.contextFor({ claudeDir: fx.dir, dataDir: fx.dir, sessionId: ID1, transcript: sessions.findTranscript(fx.dir, ID1), cwd: fx.work });
    assert.ok(c.available);
    assert.strictEqual(c.used, 5000);
    assert.strictEqual(c.size, 200000);
    assert.strictEqual(c.model, 'claude-test-1');
    const part = (k) => c.parts.find((p) => p.key === k).tokens;
    assert.strictEqual(part('messages'), 4000);
    assert.ok(part('memory') >= 100, 'CLAUDE.md (400 chars) and MEMORY.md are counted');
    assert.strictEqual(part('system') + part('memory'), 1000);
    assert.strictEqual(usage.contextFor({ claudeDir: fx.dir, dataDir: fx.dir, sessionId: ID3, transcript: sessions.findTranscript(fx.dir, ID3), cwd: fx.work }).available, false);
  });

  await check('context: finds the first reply past a large start of the transcript', () => {
    const f = path.join(fx.dir, 'big.jsonl');
    const pad = JSON.stringify({ type: 'file-history-snapshot', blob: 'y'.repeat(600 * 1024) }) + '\n';
    const a = (n) => JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: n } } }) + '\n';
    fs.writeFileSync(f, pad + a(777) + pad + pad + a(9000));
    const u = usage.transcriptUsage(f);
    assert.strictEqual(u.first.input, 777);
    assert.strictEqual(u.last.input, 9000);
  });

  await check('wiki: pages of each wiki folder and every auto memory folder', async () => {
    const wdir = path.join(fx.dir, 'wiki');
    fs.mkdirSync(wdir);
    fs.writeFileSync(path.join(wdir, 'Apps and Ports.md'), '# Our apps\n\n| App | Port |\n|---|---|\n| X | 1 |\n');
    fs.writeFileSync(path.join(wdir, 'notes.txt'), 'not markdown');
    const groups = await library.wiki({ claudeDir: fx.dir, wikiDirs: [wdir, path.join(fx.dir, 'missing')], folders: [fx.work] });
    const [w, missing, mem] = groups;
    assert.deepStrictEqual(w.pages.map((p) => p.title), ['Our apps']);
    assert.strictEqual(missing.error, 'folder not reachable');
    assert.strictEqual(mem.label, 'Claude memory');
    assert.ok(mem.where.endsWith('work'), 'memory folder is named by its project folder');
    assert.strictEqual(mem.pages[0].name, 'MEMORY', 'the index comes first');
    const ports = mem.pages.find((p) => p.name === 'ports');
    assert.strictEqual(ports.description, 'Every app and its port');
    assert.strictEqual(ports.type, 'reference');
  });

  await check('skills: personal, claude.ai, plugin (on and off) and project skills and commands', () => {
    const sk = (dir, name, desc) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nBody of ${name}\n`); };
    sk(path.join(fx.dir, 'skills'), 'mine', 'My own skill');
    sk(path.join(fx.dir, 'skills', 'synced', 'bucket1'), 'pdf', 'Read PDFs');
    const plug = path.join(fx.dir, 'plugins', 'cache', 'p1');
    sk(path.join(plug, 'skills'), 'review', 'Review code');
    fs.mkdirSync(path.join(plug, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(plug, 'commands', 'ship.md'), '---\ndescription: Ship it\n---\nSteps\n');
    fs.writeFileSync(path.join(fx.dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'p1@market': [{ installPath: plug, version: '1.2.3' }] } }));
    sk(path.join(fx.work, '.claude', 'skills'), 'local', 'Project skill');
    const list = library.skills({ claudeDir: fx.dir, folders: [fx.work] });
    const by = Object.fromEntries(list.map((s) => [s.qualified, s]));
    assert.deepStrictEqual(Object.keys(by).sort(), ['anthropic-skills:pdf', 'local', 'mine', 'p1:review', 'p1:ship']);
    assert.strictEqual(by['p1:review'].enabled, false, 'plugin is not in enabledPlugins');
    assert.strictEqual(by['p1:ship'].kind, 'command');
    assert.strictEqual(by['p1:ship'].description, 'Ship it');
    assert.ok(by.local.source.startsWith('Project'));
    assert.ok(by.mine.listTokens > 0 && by.mine.fullTokens > by.mine.listTokens);
  });

  await check('status line: turns on and off without touching other settings, never replaces a foreign one', () => {
    const cd = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sl-'));
    const dd = path.join(cd, 'data');
    const file = path.join(cd, 'settings.json');
    fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ theme: 'dark', enabledPlugins: { a: true } }));
    usage.enableStatusLine(cd, dd, ROOT);
    let s = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(s.theme, 'dark');
    assert.deepStrictEqual(s.enabledPlugins, { a: true });
    assert.strictEqual(s.statusLine.command, usage.commandFor(dd));
    assert.ok(fs.existsSync(path.join(dd, 'statusline.js')), 'the script is copied next to the app data');
    assert.strictEqual(usage.planUsage(cd, dd).statusLine, true);
    usage.disableStatusLine(cd);
    s = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(s.statusLine, undefined);
    assert.strictEqual(s.theme, 'dark');
    fs.writeFileSync(file, JSON.stringify({ statusLine: { type: 'command', command: 'my-own.sh' } }));
    assert.throws(() => usage.enableStatusLine(cd, dd, ROOT), /already has its own status line/);
    usage.disableStatusLine(cd);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command, 'my-own.sh', 'a foreign status line is left alone');
    assert.strictEqual(usage.planUsage(cd, dd).otherStatusLine, 'my-own.sh');
  });

  await check('status line script: saves usage and context, prints a short line', () => {
    const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-sls-'));
    usage.installScript(dd, ROOT);
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const input = {
      session_id: ID1, model: { id: 'm', display_name: 'Opus' }, workspace: { current_dir: 'C:\\w' },
      context_window: { used_percentage: 12.4, context_window_size: 1000000, current_usage: { input_tokens: 5, cache_read_input_tokens: 120000 } },
      rate_limits: { five_hour: { used_percentage: 34.6, resets_at: reset }, seven_day: { used_percentage: 10, resets_at: reset + 86400 } },
    };
    const r = require('child_process').spawnSync(process.execPath, [path.join(dd, 'statusline.js')], { input: JSON.stringify(input), encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(/Opus · context 12% · 5h 35%/.test(r.stdout), r.stdout);
    const pu = usage.planUsage(fx.dir, dd);
    assert.strictEqual(pu.fiveHour.pct, 34.6);
    assert.strictEqual(pu.fiveHour.resetsAt, reset * 1000);
    assert.strictEqual(usage.planUsage(fx.dir, dd, (reset + 1) * 1000).fiveHour, null, 'a window past its reset time reads as empty');
    const c = usage.contextFor({ claudeDir: fx.dir, dataDir: dd, sessionId: ID1, transcript: null, cwd: null });
    assert.strictEqual(c.size, 1000000);
    assert.strictEqual(c.used, 120005);
    assert.ok(c.sizeKnown);
    const bad = require('child_process').spawnSync(process.execPath, [path.join(dd, 'statusline.js')], { input: 'not json', encoding: 'utf8' });
    assert.strictEqual(bad.status, 0, 'bad input never breaks Claude Code');
  });

  // ---- session host + ConPTY bridge ----------------------------------------
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-host-'));
  const hostData = path.join(hostRoot, 'data');
  const hostPipe = testPipe('cs-test-host');
  const hc = new HostClient({ dataDir: hostData, pipe: hostPipe });
  try {
    await check('host: starts, runs a command in a pseudo console, takes typing', async () => {
      await hc.ensure();
      let out = '';
      hc.on('event', (m) => { if (m.t === 'out') out += Buffer.from(m.data, 'base64').toString('utf8'); });
      const r = await hc.request({ t: 'spawn', cwd: fx.work, command: shellCmd('HOST-READY'), cols: 100, rows: 30 });
      const id = r.session.id;
      await until(() => strip(out).includes('HOST-READY'));
      await until(() => hc.list().find((s) => s.id === id).pid > 0);
      await hc.request({ t: 'input', id, data: WIN ? 'echo typed-%COMPUTERNAME%\r' : 'echo typed-$((6*7))\r' });
      await until(() => /typed-\w+/.test(strip(out)));
      await hc.request({ t: 'resize', id, cols: 140, rows: 40 });
      const rep = await hc.request({ t: 'replay', id });
      assert.ok(strip(Buffer.from(rep.data, 'base64').toString('utf8')).includes('HOST-READY'), 'replay holds earlier output');
      await hc.request({ t: 'kill', id });
      await until(() => hc.list().find((s) => s.id === id).exited, 10000);
    });

    await check('host: a second dashboard connection sees the running sessions (survives restarts)', async () => {
      const r = await hc.request({ t: 'spawn', cwd: fx.work, command: shellCmd('AGAIN'), cols: 80, rows: 24 });
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
  const httpPipe = testPipe('cs-test-http');
  // What a server leaves behind right before it installs v0.0.1 and restarts.
  fs.writeFileSync(path.join(data, 'state.json'), JSON.stringify({ update: { current: '0.0.0', latest: 'v0.0.1', available: true, mode: 'release' } }));
  // Hold the port briefly, like an old server mid-restart, so the server has to retry.
  const blocker = require('net').createServer((sock) => sock.destroy());
  await new Promise((r) => blocker.listen(PORT, '127.0.0.1', r));
  setTimeout(() => blocker.close(), 700);
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env, CS_PORT: String(PORT), CS_CLAUDE_DIR: fx.dir, CS_DATA: data, CS_FAKE_PIDS: '100,200', CS_TEST: '1',
      CS_HOST_PIPE: httpPipe, CS_CLAUDE_CMD: shellCmd('APP-READY'),
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
      assert.ok(wt.json.args[wt.json.args.length - 1].endsWith(`claude --resume ${ID2}`));
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

    await check('http: projects: make, assign by folder and by hand, start a session in its folder, delete', async () => {
      const proj = path.join(fx.dir, 'proj-folder');
      fs.mkdirSync(proj);
      const bad = await request(PORT, 'POST', '/api/projects/save', { body: { name: 'X', color: '#d97757', folders: [path.join(fx.dir, 'nope')] }, headers: H });
      assert.strictEqual(bad.status, 400);
      const badColor = await request(PORT, 'POST', '/api/projects/save', { body: { name: 'X', color: 'red;}', folders: [] }, headers: H });
      assert.strictEqual(badColor.status, 400);
      const made = await request(PORT, 'POST', '/api/projects/save', { body: { name: ' Printer ', color: '#5b9cf6', folders: [fx.work, fx.work.toUpperCase(), proj] }, headers: H });
      assert.strictEqual(made.status, 200, JSON.stringify(made.json));
      const pid = made.json.id;
      let s = (await request(PORT, 'GET', '/api/state')).json;
      assert.strictEqual(s.projects[0].name, 'Printer');
      assert.strictEqual(s.projects[0].folders.length, 2, 'the same folder twice is kept once');
      assert.ok(s.live.every((x) => x.project === pid), 'sessions in its folder join by themselves');
      await request(PORT, 'POST', '/api/projects/assign', { body: { sessionId: ID1, projectId: 'none' }, headers: H });
      s = (await request(PORT, 'GET', '/api/state')).json;
      assert.strictEqual(s.live.find((x) => x.sessionId === ID1).project, null);
      assert.strictEqual((await request(PORT, 'POST', '/api/projects/assign', { body: { sessionId: ID1, projectId: 'no-such' }, headers: H })).status, 404);
      await request(PORT, 'POST', '/api/projects/assign', { body: { sessionId: ID1, projectId: null }, headers: H });
      s = (await request(PORT, 'GET', '/api/state')).json;
      assert.strictEqual(s.live.find((x) => x.sessionId === ID1).project, pid, 'back to going by folder');
      const started = await request(PORT, 'POST', '/api/new', { body: { cwd: proj, where: 'terminal' }, headers: H });
      assert.strictEqual(started.status, 200, 'a project folder counts as a known folder');
      await request(PORT, 'POST', '/api/projects/delete', { body: { id: pid }, headers: H });
      s = (await request(PORT, 'GET', '/api/state')).json;
      assert.strictEqual(s.projects.length, 0);
      assert.ok(s.live.every((x) => x.project === null));
    });

    await check('http: put many sessions in a project at once, old ones stay listed with it', async () => {
      // A session last used 30 days ago: too old for History until it is put in a project.
      const ID4 = '44444444-4444-4444-8444-444444444444';
      const old = path.join(fx.dir, 'projects', 'C--work', ID4 + '.jsonl');
      fs.writeFileSync(old, JSON.stringify({ type: 'user', cwd: fx.work, message: { content: 'an old job' } }) + '\n');
      const then = (Date.now() - 30 * 86400000) / 1000;
      fs.utimesSync(old, then, then);
      const all = (await request(PORT, 'GET', '/api/sessions/all')).json.sessions;
      const states = Object.fromEntries(all.map((s) => [s.sessionId, s.state]));
      assert.strictEqual(states[ID1], 'open');
      assert.strictEqual(states[ID2], 'closed');
      assert.strictEqual(states[ID4], 'past', 'the picker lists sessions of any age');
      let s = (await request(PORT, 'GET', '/api/state')).json;
      assert.ok(!s.history.some((h) => h.sessionId === ID4));
      const pid = (await request(PORT, 'POST', '/api/projects/save', { body: { name: 'Bulk', color: '#4fbf8a', folders: [] }, headers: H })).json.id;
      const bad = await request(PORT, 'POST', '/api/projects/assign', { body: { sessionIds: [ID1, 'nope'], projectId: pid }, headers: H });
      assert.strictEqual(bad.status, 400, 'one bad id refuses the whole batch');
      const r = await request(PORT, 'POST', '/api/projects/assign', { body: { sessionIds: [ID1, ID2, ID4], projectId: pid }, headers: H });
      assert.strictEqual(r.json.count, 3);
      s = (await request(PORT, 'GET', '/api/state')).json;
      assert.strictEqual(s.live.find((x) => x.sessionId === ID1).project, pid);
      assert.strictEqual(s.closed.find((x) => x.sessionId === ID2).project, pid);
      const h4 = s.history.find((h) => h.sessionId === ID4);
      assert.ok(h4 && h4.project === pid, 'an old session put in a project shows up in its history');
      await request(PORT, 'POST', '/api/projects/delete', { body: { id: pid }, headers: H });
      s = (await request(PORT, 'GET', '/api/state')).json;
      assert.ok(!s.history.some((h) => h.sessionId === ID4), 'deleting the project lets the old session go again');
    });

    await check('http: wiki, skills and a skill file', async () => {
      const w = await request(PORT, 'POST', '/api/settings', { body: { wikiDirs: [path.join(fx.dir, 'wiki')] }, headers: H });
      assert.strictEqual(w.status, 200);
      assert.strictEqual((await request(PORT, 'POST', '/api/settings', { body: { wikiDirs: ['relative'] }, headers: H })).status, 400);
      const wiki = (await request(PORT, 'GET', '/api/wiki')).json;
      assert.ok(wiki.groups.some((g) => g.label === 'Wiki' && g.pages.some((p) => p.title === 'Our apps')));
      const sk = (await request(PORT, 'GET', '/api/skills')).json.skills;
      const mine = sk.find((s) => s.qualified === 'mine');
      assert.ok(mine && !('file' in mine), 'the list gives no raw file paths to open');
      const f = await request(PORT, 'GET', '/api/skills/file?id=' + mine.id);
      assert.strictEqual(f.json.text, 'Body of mine\n');
      assert.strictEqual((await request(PORT, 'GET', '/api/skills/file?id=..%5C..%5Cwin.ini')).status, 404);
    });

    await check('http: settings: app theme and terminal look are checked, saved and reset', async () => {
      const post = (body) => request(PORT, 'POST', '/api/settings', { body, headers: H });
      let s = (await request(PORT, 'GET', '/api/state')).json.settings;
      assert.strictEqual(s.theme, 'system');
      assert.strictEqual(s.terminal, null);
      assert.strictEqual((await post({ theme: 'light' })).json.theme, 'light');
      assert.strictEqual((await post({ theme: 'pink' })).status, 400);
      const ok = await post({ terminal: { preset: 'forest', background: '#0F1A14', foreground: '#d3e8d8', cursor: '#4fbf8a', fontSize: 15 } });
      assert.deepStrictEqual(ok.json.terminal, { preset: 'forest', fontSize: 15, background: '#0f1a14', foreground: '#d3e8d8', cursor: '#4fbf8a' });
      assert.strictEqual((await post({ terminal: { background: 'red;}', foreground: '#ffffff', cursor: '#ffffff' } })).status, 400, 'only #rrggbb colors');
      const odd = await post({ terminal: { preset: '<b>', background: '#000000', foreground: '#ffffff', cursor: '#ffffff', fontSize: 99 } });
      assert.strictEqual(odd.json.terminal.preset, 'custom');
      assert.strictEqual(odd.json.terminal.fontSize, 13);
      assert.strictEqual(odd.json.theme, 'light', 'one setting leaves the others alone');
      await post({ terminal: null, theme: 'system' });
      s = (await request(PORT, 'GET', '/api/state')).json.settings;
      assert.strictEqual(s.terminal, null);
      assert.strictEqual(s.theme, 'system');
    });

    await check('http: context of open sessions, plan usage switch', async () => {
      const ctx = (await request(PORT, 'GET', '/api/context')).json.sessions;
      const one = ctx.find((c) => c.sessionId === ID1);
      assert.ok(one.available && one.used === 5000 && one.live);
      const s = (await request(PORT, 'GET', '/api/state')).json;
      assert.strictEqual(Math.round(s.live.find((x) => x.sessionId === ID1).context.pct * 100), 250);
      assert.strictEqual(s.usage.statusLine, false);
      const on = await request(PORT, 'POST', '/api/usage/statusline', { body: { on: true }, headers: H });
      assert.strictEqual(on.json.statusLine, true);
      assert.ok(JSON.parse(fs.readFileSync(path.join(fx.dir, 'settings.json'), 'utf8')).statusLine.command.includes(usage.MARK));
      await request(PORT, 'POST', '/api/usage/statusline', { body: { on: false }, headers: H });
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(fx.dir, 'settings.json'), 'utf8')).statusLine, undefined);
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
