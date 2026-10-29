// Starts a gateway on a spare port with copies of a tiny fixture server (shared, per owner, per-client env)
// and checks how many backend processes the gateway starts, what env they get and where long results go.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

async function connectShim(name, config = path.join(state, 'servers.json')) {
  const c = new Client({ name, version: '0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'src', 'shim.mjs')],
    env: { ...process.env, MCP_GATEWAY_CONFIG: config, MCP_GATEWAY_STATE: state }, stderr: 'ignore',
  });
  await c.connect(transport);
  clients.push(c);
  return { c, transport };
}

before(async () => {
  const echo = { command: process.execPath, args: [FIXTURE] };
  fs.writeFileSync(path.join(state, 'servers.json'), JSON.stringify({
    gateway: { port: PORT, heartbeatSec: 1, outputDir: 'spilled', inlineTextLimit: 1000, dropEnv: ['GW_TEST_DROP'], clientAliases: { '^test$': 'aliased' } },
    servers: {
      'shared-echo': { description: 'fixture', scope: 'shared', ...echo },
      'owner-echo': { description: 'fixture', scope: 'owner', ...echo },
      'client-echo': { description: 'fixture', scope: 'owner', ...echo, clientEnv: { GW_TEST_CLIENT: '${CLIENT}' } },
      'dir-echo': { description: 'fixture', scope: 'shared', cwd: 'key', cwdArgs: ['--dir', '${CWD}'], ...echo },
      'slow-echo': { description: 'fixture', scope: 'owner', ...echo, env: { GW_TEST_STARTUP_MS: '1000', GW_TEST_PID_FILE: path.join(state, 'slow-pid') } },
    },
  }));
  gateway = spawn(process.execPath, ['--import', pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'clock.mjs')).href, path.join(ROOT, 'src', 'gateway.mjs')], {
    env: {
      ...process.env, MCP_GATEWAY_CONFIG: path.join(state, 'servers.json'), MCP_GATEWAY_STATE: state, GW_IDLE_MINUTES: '0.05',
      GW_TEST_DROP: 'leaked', GW_TEST_KEEP: 'kept', ZCODE_TEST: 'leaked',
      GW_TEST_CLOCK: path.join(state, 'clock'),
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
  const hints = Object.fromEntries(tools.map(t => [t.name, t.annotations?.readOnlyHint]));
  assert.deepEqual(hints, { list: true, describe: true, resource: true, status: true, call: false, reset: false });
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

test('two timeouts in a row restart a per-session instance; shared instances are kept', async () => {
  const a = await connect('k');
  const slow = async server => text(await a.callTool({ name: 'call', arguments: { server, tool: 'sleep', arguments: { ms: 3000 }, timeout_sec: 1 } }));
  const owned = await pidOf(a, 'owner-echo');
  assert.match(await slow('owner-echo'), /timed out after 1s\. .*wait behind it/);
  assert.match(await slow('owner-echo'), /restarted it/);
  assert.notEqual(await pidOf(a, 'owner-echo'), owned);
  const shared = await pidOf(a, 'shared-echo');
  await slow('shared-echo');
  assert.doesNotMatch(await slow('shared-echo'), /restarted/);
  assert.equal(await pidOf(a, 'shared-echo'), shared);
});

test('when a shim exits, its per-session instances stop; other sessions keep theirs', async () => {
  const other = await connect('l');
  const kept = await pidOf(other, 'owner-echo');
  const c = new Client({ name: 'shim-end', version: '0' }, { capabilities: {} });
  await c.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'shim.mjs')],
    env: { ...process.env, MCP_GATEWAY_CONFIG: path.join(state, 'servers.json'), MCP_GATEWAY_STATE: state },
    stderr: 'ignore',
  }));
  const gone = await pidOf(c, 'owner-echo');
  const owner = (await status(c)).caller;
  await c.close();
  for (let i = 0; i < 20 && (await status(other)).instances.some(x => x.owner === owner); i++) await sleep(100);
  assert.ok(!(await status(other)).instances.some(x => x.owner === owner), 'instance of the ended session still listed');
  for (let i = 0; i < 20 && alive(gone); i++) await sleep(100);
  assert.equal(alive(gone), false);
  assert.equal(await pidOf(other, 'owner-echo'), kept);
});

test('a running shim keeps its per-session instance past the idle timeout; a session without heartbeats does not', async () => {
  const quiet = await connect('n');
  const reaped = await pidOf(quiet, 'owner-echo');
  const c = new Client({ name: 'shim-alive', version: '0' }, { capabilities: {} });
  await c.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'shim.mjs')],
    env: { ...process.env, MCP_GATEWAY_CONFIG: path.join(state, 'servers.json'), MCP_GATEWAY_STATE: state },
    stderr: 'ignore',
  }));
  try {
    const kept = await pidOf(c, 'owner-echo');
    await sleep(6000); // GW_IDLE_MINUTES is 3 s
    assert.ok((await status(c)).instances.some(i => i.pid === kept && i.sessionAlive), 'instance of the live session was stopped');
    assert.equal(await pidOf(c, 'owner-echo'), kept);
    assert.equal(alive(reaped), false, 'instance without heartbeats still running');
  } finally {
    await c.close();
  }
});

test('a held session survives a forward clock jump and a different shim heartbeat setting', async () => {
  const config = JSON.parse(fs.readFileSync(path.join(state, 'servers.json'), 'utf8'));
  config.gateway.heartbeatSec = 60; // gateway is running with 1 s
  const file = path.join(state, 'slow-shim.json');
  fs.writeFileSync(file, JSON.stringify(config));
  const { c } = await connectShim('clock-jump', file);
  try {
    const kept = await pidOf(c, 'owner-echo');
    const mine = (await status(c)).caller;
    fs.writeFileSync(path.join(state, 'clock'), '3600000');
    await sleep(4500); // beyond idle timeout and the old gateway's heartbeat lease
    assert.ok((await status(c)).instances.some(i => i.pid === kept && i.sessionAlive), 'live instance was reaped after the clock jump');
    assert.equal(await pidOf(c, 'owner-echo'), kept);
    assert.match(mine, /clock-jump/);
  } finally {
    await c.close();
    fs.writeFileSync(path.join(state, 'clock'), '0');
  }
});

test('hard-killing a shim closes its session before the ordinary idle timeout', async () => {
  const { c, transport } = await connectShim('hard-kill');
  const backend = await pidOf(c, 'owner-echo');
  assert.ok(transport.pid);
  process.kill(transport.pid);
  for (let i = 0; i < 20 && alive(backend); i++) await sleep(100);
  assert.equal(alive(backend), false, 'backend survived the killed shim');
});

const postSession = (endpoint, owner, extra = {}) => fetch(`${URL_BASE}/session/${endpoint}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ owner, ...extra }),
});

test('replacing a session connection does not close its instances; closing the replacement does', async () => {
  const c = await connect('replacement');
  const owner = (await status(c)).caller;
  const a = await postSession('connect', owner);
  const b = await postSession('connect', owner);
  try {
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    await a.body.cancel();
    const backend = await pidOf(c, 'owner-echo');
    assert.ok((await status(c)).instances.some(i => i.pid === backend && i.sessionAlive));
    await b.body.cancel();
    for (let i = 0; i < 20 && alive(backend); i++) await sleep(100);
    assert.equal(alive(backend), false);
  } finally {
    await b.body.cancel().catch(() => {});
  }
});

test('a session ending during backend startup leaves no late backend process', async () => {
  const { c, transport } = await connectShim('cold-exit');
  const started = c.callTool({ name: 'call', arguments: { server: 'slow-echo', tool: 'pid' } }).catch(() => {});
  const file = path.join(state, 'slow-pid');
  try {
    for (let i = 0; i < 40 && !fs.existsSync(file); i++) await sleep(50);
    assert.ok(fs.existsSync(file), 'slow fixture did not start');
    const backend = Number(fs.readFileSync(file, 'utf8'));
    process.kill(transport.pid);
    await started;
    for (let i = 0; i < 25 && alive(backend); i++) await sleep(100);
    assert.equal(alive(backend), false, 'backend finished starting after its session ended');
  } finally {
    await c.close().catch(() => {});
  }
});

test('legacy heartbeats remain supported and a supplied lease is independent of gateway heartbeatSec', async () => {
  const c = await connect('legacy');
  const owner = (await status(c)).caller;
  await (await postSession('alive', owner, { ttlMs: 8000 })).json();
  const kept = await pidOf(c, 'owner-echo');
  await sleep(4500);
  assert.ok((await status(c)).instances.some(i => i.pid === kept && i.sessionAlive));
  await (await postSession('end', owner)).json();
  for (let i = 0; i < 20 && alive(kept); i++) await sleep(100);
  assert.equal(alive(kept), false);
});

test('reconnecting during cold-start cleanup cannot close the replacement instance', async () => {
  const c = await connect('reconnect-startup');
  const owner = (await status(c)).caller;
  const a = await postSession('connect', owner);
  const file = path.join(state, 'slow-pid');
  fs.rmSync(file, { force: true });
  const oldCall = c.callTool({ name: 'call', arguments: { server: 'slow-echo', tool: 'pid' } }).catch(() => {});
  for (let i = 0; i < 40 && !fs.existsSync(file); i++) await sleep(50);
  assert.ok(fs.existsSync(file));
  await a.body.cancel();
  await sleep(100); // cleanup is now waiting for slow-echo's initialize
  const b = await postSession('connect', owner);
  try {
    const kept = await pidOf(c, 'owner-echo');
    await oldCall;
    await sleep(300);
    assert.ok(alive(kept), 'cleanup of the old connection closed the replacement backend');
    assert.equal(await pidOf(c, 'owner-echo'), kept);
  } finally {
    await b.body.cancel();
  }
});

test('a shim whose client died without closing its stdin ends its session', async () => {
  // The parent hands its stdin to the shim, then gets killed. That stdin is a local socket this test keeps
  // open (Node would close a 'pipe' it created when the parent exits), so the shim's stdin stays open, the
  // way it does when the pipe leaked into another process. detached keeps the shim out of the parent's
  // kill-on-close job on Windows.
  const where = process.platform === 'win32' ? path.join('\\\\?\\pipe', `gw-test-${process.pid}`) : path.join(state, 'stdin.sock');
  const srv = net.createServer();
  const accepted = new Promise(resolve => srv.once('connection', resolve));
  await new Promise(resolve => srv.listen(where, resolve));
  const stdin = net.connect(where);
  const held = await accepted;
  const launcher = `const c = require('node:child_process').spawn(process.execPath, [${JSON.stringify(path.join(ROOT, 'src', 'shim.mjs'))}], { stdio: 'inherit', detached: true, windowsHide: true });
console.log(JSON.stringify({ shim: c.pid })); setInterval(() => {}, 1e9);`;
  const parent = spawn(process.execPath, ['-e', launcher], {
    env: { ...process.env, MCP_GATEWAY_CONFIG: path.join(state, 'servers.json'), MCP_GATEWAY_STATE: state },
    stdio: [held, 'pipe', 'ignore'],
    windowsHide: true,
  });
  const lines = [];
  let buf = '';
  parent.stdout.on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) lines.push(JSON.parse(buf.slice(0, i)));
  });
  const next = async pred => {
    for (let i = 0; i < 100; i++) { const m = lines.find(pred); if (m) return m; await sleep(100); }
    throw new Error('no answer from the shim');
  };
  const rpc = (id, method, params) => stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  try {
    const shim = (await next(m => m.shim)).shim;
    rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'orphan', version: '0' } });
    await next(m => m.id === 1);
    rpc(2, 'tools/call', { name: 'call', arguments: { server: 'owner-echo', tool: 'pid' } });
    const backend = Number((await next(m => m.id === 2)).result.content[0].text);
    assert.ok(alive(backend));
    parent.kill();
    // Within 2.5 s: before the 3 s idle timeout could stop the backend on its own.
    for (let i = 0; i < 25 && (alive(shim) || alive(backend)); i++) await sleep(100);
    assert.equal(alive(shim), false, 'shim still running');
    assert.equal(alive(backend), false, 'instance of the ended session still running');
  } finally {
    parent.kill();
    for (const m of lines) if (m.shim && alive(m.shim)) process.kill(m.shim);
    stdin.destroy();
    held.destroy();
    srv.close();
  }
});

test('cross-server search and unknown servers', async () => {
  const a = await connect('m');
  const found = text(await a.callTool({ name: 'list', arguments: { query: 'sleep' } }));
  for (const s of ['shared-echo', 'owner-echo', 'client-echo', 'dir-echo']) assert.match(found, new RegExp(`- ${s} / sleep:`));
  const r = await a.callTool({ name: 'call', arguments: { server: 'some-host', tool: 'x' } });
  assert.ok(r.isError);
  assert.match(text(r), /go inside "arguments"/);
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
