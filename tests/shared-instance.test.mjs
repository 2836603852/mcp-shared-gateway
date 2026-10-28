// Starts a gateway on a spare port with copies of a tiny fixture server (shared, per owner, per-client env)
// and checks how many backend processes the gateway starts, what env they get and where long results go.
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
    gateway: { port: PORT, outputDir: 'spilled', inlineTextLimit: 1000, dropEnv: ['GW_TEST_DROP'], clientAliases: { '^test$': 'aliased' } },
    servers: {
      'shared-echo': { description: 'fixture', scope: 'shared', ...echo },
      'owner-echo': { description: 'fixture', scope: 'owner', ...echo },
      'client-echo': { description: 'fixture', scope: 'owner', ...echo, clientEnv: { GW_TEST_CLIENT: '${CLIENT}' } },
      'dir-echo': { description: 'fixture', scope: 'shared', cwd: 'key', cwdArgs: ['--dir', '${CWD}'], ...echo },
    },
  }));
  gateway = spawn(process.execPath, [path.join(ROOT, 'src', 'gateway.mjs')], {
    env: {
      ...process.env, MCP_GATEWAY_CONFIG: path.join(state, 'servers.json'), MCP_GATEWAY_STATE: state, GW_IDLE_MINUTES: '0.05',
      GW_TEST_DROP: 'leaked', GW_TEST_KEEP: 'kept', ZCODE_TEST: 'leaked',
    },
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

test('backend env: client alias via clientEnv, dropEnv and client prefixes removed, the rest kept', async () => {
  const a = await connect('f');
  const env = async name => text(await a.callTool({ name: 'call', arguments: { server: 'client-echo', tool: 'env', arguments: { name } } }));
  assert.equal(await env('GW_TEST_CLIENT'), 'aliased');
  assert.equal(await env('GW_TEST_DROP'), '');
  assert.equal(await env('ZCODE_TEST'), '');
  assert.equal(await env('GW_TEST_KEEP'), 'kept');
});

test('long text results are written to gateway.outputDir', async () => {
  const a = await connect('g');
  const r = text(await a.callTool({ name: 'call', arguments: { server: 'shared-echo', tool: 'big', arguments: { chars: 5000 } } }));
  const file = r.match(/written to (.+)\]$/)?.[1];
  assert.ok(file && path.dirname(file) === path.join(state, 'spilled'), r.slice(-200));
  assert.equal(fs.readFileSync(file, 'utf8').length, 5000);
});

test('cwd "key": one instance per directory, ${CWD} filled into cwdArgs', async () => {
  const a = await connect('h');
  const [d1, d2] = ['d1', 'd2'].map(d => fs.mkdirSync(path.join(state, d), { recursive: true }) || path.join(state, d));
  const run = async (tool, cwd) => text(await a.callTool({ name: 'call', arguments: { server: 'dir-echo', tool, cwd } }));
  const [p1, p2, p1again] = [await run('pid', d1), await run('pid', d2), await run('pid', d1)];
  assert.equal(p1, p1again);
  assert.notEqual(p1, p2);
  assert.deepEqual(JSON.parse(await run('argv', d2)), ['--dir', d2]);
});

const alive = pid => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

test('reset stops the session\'s instance together with the processes it started', async () => {
  const a = await connect('i');
  const server = await pidOf(a, 'owner-echo');
  const child = Number(text(await a.callTool({ name: 'call', arguments: { server: 'owner-echo', tool: 'spawn_child' } })));
  assert.ok(alive(child));
  assert.match(text(await a.callTool({ name: 'reset', arguments: { server: 'owner-echo' } })), /Stopped 1 /);
  for (let i = 0; i < 20 && (alive(server) || alive(child)); i++) await sleep(250);
  assert.equal(alive(server), false, 'backend still running');
  assert.equal(alive(child), false, 'backend child still running');
});

test('token file is private to its owner', { skip: process.platform === 'win32' && 'POSIX permissions' }, () => {
  assert.equal(fs.statSync(path.join(state, 'token')).mode & 0o077, 0);
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
