'use strict';
// MCP server (stdio, newline-delimited JSON-RPC) that Claude Code starts for every
// session opened in Claude Sessions. It lets the session see its group and message
// its teammates; the dashboard does the delivering. Zero dependencies.
//   env CS_TEAM_URL    http://127.0.0.1:<port> of the dashboard
//       CS_TEAM_KEY    this terminal's key, CS_TEAM_TOKEN its proof

const http = require('http');
const readline = require('readline');

const URL_ = process.env.CS_TEAM_URL || 'http://127.0.0.1:8930';
const KEY = process.env.CS_TEAM_KEY || '';
const TOKEN = process.env.CS_TEAM_TOKEN || '';

const GENERAL = 'This session runs in Claude Sessions, where the user can put several sessions in a named group so they work together, ' +
  'for example one researching while another builds. Use team_info to see your group, your role and your teammates, and send_message to ' +
  'message a teammate. Messages from teammates arrive as a prompt that starts with "[Team message from <role> ...]". ' +
  'Keep messages short and self-contained, and do not send a message only to acknowledge or say thanks.';

const TOOLS = [
  {
    name: 'team_info',
    description: 'Shows the group this session is in, your role in it, and each teammate with its role and whether it is working or idle.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'send_message',
    description: 'Sends a message to a teammate in your group (by role, like "Build"), or to "all". It is typed into the teammate\'s session as a prompt once that session is idle, so the teammate starts working on it. Include everything the teammate needs; it cannot see your conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The teammate\'s role, as team_info lists it, or "all".' },
        message: { type: 'string', description: 'The message.' },
      },
      required: ['to', 'message'],
      additionalProperties: false,
    },
  },
];

function call(route, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const req = http.request(`${URL_}/api/team/${route}`, {
      method: 'POST',
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
        'X-Claude-Sessions': '1', 'X-Team-Key': KEY, 'X-Team-Token': TOKEN,
      },
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(out); } catch { /* not json */ }
        resolve(res.statusCode === 200 ? { ok: true, text: j.text || '' } : { ok: false, text: j.error || `the dashboard answered ${res.statusCode}` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (e) => resolve({ ok: false, text: `Claude Sessions is not reachable (${e.message}). It may be restarting; try again in a moment.` }));
    req.end(data);
  });
}

function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function error(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notifications
  switch (method) {
    case 'initialize': {
      const info = await call('info');
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'sessions-team', version: '1.0.0' },
        instructions: GENERAL + (info.ok && info.text && !/not in a group/i.test(info.text) ? '\n\nRight now: ' + info.text : ''),
      });
    }
    case 'ping': return reply(id, {});
    case 'tools/list': return reply(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      let r;
      if (name === 'team_info') r = await call('info');
      else if (name === 'send_message') r = await call('send', { to: args.to, message: args.message });
      else return error(id, -32602, `unknown tool ${name}`);
      return reply(id, { content: [{ type: 'text', text: r.text }], isError: !r.ok });
    }
    default: return error(id, -32601, `method not found: ${method}`);
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((e) => { if (msg.id !== undefined) error(msg.id, -32603, e.message); });
});
