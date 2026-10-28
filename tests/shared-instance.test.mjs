// Starts a gateway on a spare port with two copies of a tiny fixture server (one shared, one per owner)
// and checks how many backend processes the gateway starts for two different sessions.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'echo-server.mjs');
// Ask the OS for a free port (fixed ranges may be reserved, e.g. by Hyper-V on Windows).
const PORT = await new Promise(resolve => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const URL_BASE = `http://127.0.0.1:${PORT}`;
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-shared-gateway-test-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let gateway;
let token;
const clients = [];

async function connect(owner) {
  const c = new Client({ name: `gw-cli/test/${owner}`, version: '0' }, { capabilities: {} });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  clients.push(c);
  return c;
}

const text = r => r.content.map(c => c.text).join('\n');
const pidOf = async (c, server) => {
  const r = await c.callTool({ name: 'call', arguments: { server, tool: 'pid' } });
  assert.ok(!r.isError, text(r));
  return Number(text(r));
};
const status = async c => JSON.parse(text(await c.callTool({ name: 'status', arguments: {} })));

before(async () => {
  const echo = { command: process.execPath, args: [FIXTURE] };
  fs.writeFileSync(path.join(state, 'servers.json'), JSON.stringify({
    gateway: { port: PORT },
    servers: {
      'shared-echo': { description: 'fixture', scope: 'shared', ...echo },
      'owner-echo': { description: 'fixture', scope: 'owner', ...echo },
    },
  }));
  gateway = spawn(process.execPath, [path.join(ROOT, 'src', 'gateway.mjs')], {
    env: { ...process.env, MCP_GATEWAY_CONFIG: path.join(state, 'servers.json'), MCP_GATEWAY_STATE: state, GW_IDLE_MINUTES: '0.05' },
    stdio: 'ignore',
    windowsHide: true,
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${URL_BASE}/health`)).ok) break; } catch {}
    await sleep(200);
  }
  token = fs.readFileSync(path.join(state, 'token'), 'utf8').trim();
});

after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await fetch(`${URL_BASE}/admin/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  await sleep(500);
  gateway.kill();
  fs.rmSync(state, { recursive: true, force: true });
});

test('shared server: two sessions use one backend process', async () => {
  const [a, b] = [await connect('a'), await connect('b')];
  const [pa, pb] = await Promise.all([pidOf(a, 'shared-echo'), pidOf(b, 'shared-echo')]);
  assert.equal(pa, pb);
  const shared = (await status(a)).instances.filter(i => i.server === 'shared-echo');
  assert.equal(shared.length, 1);
});

test('owner server: each session gets its own process, reused across its calls', async () => {
  const [a, b] = [await connect('c'), await connect('d')];
  const pa1 = await pidOf(a, 'owner-echo');
  const pa2 = await pidOf(a, 'owner-echo');
  const pb = await pidOf(b, 'owner-echo');
  assert.equal(pa1, pa2);
  assert.notEqual(pa1, pb);
});

test('shim: answers initialize and tools/list locally, forwards calls to the gateway', async () => {
  const c = new Client({ name: 'shim-test', version: '0' }, { capabilities: {} });
  await c.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'shim.mjs')],
    env: { ...process.env, MCP_GATEWAY_CONFIG: path.join(state, 'servers.json'), MCP_GATEWAY_STATE: state },
    stderr: 'ignore',
  }));
  clients.push(c);
  assert.match(c.getInstructions(), /shared/);
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['call', 'describe', 'list', 'reset', 'resource', 'status']);
  assert.ok((await pidOf(c, 'shared-echo')) > 0);
  assert.match((await status(c)).caller, /^gw-shim\/shim-test\//);
});

test('idle backends are stopped', async () => {
  const a = await connect('e');
  await pidOf(a, 'shared-echo');
  for (let i = 0; i < 30; i++) {
    if ((await status(a)).instances.length === 0) return;
    await sleep(500);
  }
  assert.fail('instances still running after the idle timeout');
});
