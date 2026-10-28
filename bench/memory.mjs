// Memory benchmark: N agent sessions x M MCP servers.
//   direct : every session spawns its own copy of every server (what a plain client config does)
//   gateway: every session spawns one shim; the gateway starts each shared server once
// Usage: node bench/memory.mjs [sessions=5]
// Servers are public npm packages started with `npx -y`, exactly as most client configs do.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = Number(process.argv[2]) || 5;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bench-'));

const SERVERS = {
  filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', scratch] },
  memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  'sequential-thinking': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
};

// pid -> { ppid, rss } for every process on the machine.
function processTable() {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress';
      execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, maxBuffer: 64 << 20 }, (err, out) => {
        if (err) return reject(err);
        resolve(new Map(JSON.parse(out).map(p => [p.ProcessId, { ppid: p.ParentProcessId, rss: Number(p.WorkingSetSize) }])));
      });
    } else {
      execFile('ps', ['-eo', 'pid=,ppid=,rss='], (err, out) => {
        if (err) return reject(err);
        resolve(new Map(out.trim().split('\n').map(l => l.trim().split(/\s+/).map(Number)).map(([pid, ppid, rss]) => [pid, { ppid, rss: rss * 1024 }])));
      });
    }
  });
}

// Process count and total RSS of the given roots and all their descendants.
async function measure(roots) {
  const table = await processTable();
  const children = new Map();
  for (const [pid, p] of table) children.set(p.ppid, [...(children.get(p.ppid) || []), pid]);
  const seen = new Set();
  const stack = roots.filter(pid => table.has(pid));
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    stack.push(...(children.get(pid) || []));
  }
  let rss = 0;
  for (const pid of seen) rss += table.get(pid).rss;
  return { processes: seen.size, mb: Math.round(rss / 1048576) };
}

const freePort = () => new Promise(resolve => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

async function startClient(command, args, env) {
  const transport = new StdioClientTransport({ command, args, env: { ...process.env, ...env }, stderr: 'ignore' });
  const client = new Client({ name: 'bench', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, pid: transport.pid };
}

async function direct() {
  const clients = [];
  for (let s = 0; s < N; s++) {
    for (const def of Object.values(SERVERS)) clients.push(await startClient(def.command, def.args));
  }
  await sleep(3000);
  const result = await measure(clients.map(c => c.pid));
  for (const c of clients) await c.client.close().catch(() => {});
  return result;
}

async function viaGateway() {
  const port = await freePort();
  const state = path.join(scratch, 'state');
  const config = path.join(scratch, 'servers.json');
  fs.writeFileSync(config, JSON.stringify({
    gateway: { port },
    servers: Object.fromEntries(Object.entries(SERVERS).map(([n, d]) => [n, { ...d, scope: 'shared' }])),
  }));
  const env = { MCP_GATEWAY_CONFIG: config, MCP_GATEWAY_STATE: state };
  const shims = [];
  for (let s = 0; s < N; s++) shims.push(await startClient(process.execPath, [path.join(ROOT, 'src', 'shim.mjs')], env));
  // Every session touches every server once, so each backend is started.
  for (const { client } of shims) {
    for (const server of Object.keys(SERVERS)) {
      await client.callTool({ name: 'list', arguments: { server } });
      await client.callTool({ name: 'resource', arguments: { server } });
    }
  }
  await sleep(3000);
  const gw = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  const result = await measure([...shims.map(s => s.pid), gw.pid]);
  const token = fs.readFileSync(path.join(state, 'token'), 'utf8').trim();
  await fetch(`http://127.0.0.1:${port}/admin/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  for (const s of shims) await s.client.close().catch(() => {});
  return result;
}

console.log(`Warming the npx cache…`);
for (const def of Object.values(SERVERS)) {
  const c = await startClient(def.command, def.args);
  await c.client.close();
}
console.log(`${N} sessions x ${Object.keys(SERVERS).length} servers (${Object.keys(SERVERS).join(', ')})`);
const d = await direct();
console.log(`direct : ${d.processes} processes, ${d.mb} MB`);
await sleep(2000);
const g = await viaGateway();
console.log(`gateway: ${g.processes} processes, ${g.mb} MB (includes ${N} shims and the gateway)`);
console.log(`saved  : ${d.mb - g.mb} MB (${Math.round((1 - g.mb / d.mb) * 100)}%)`);
console.log(`env    : ${os.type()} ${os.release()}, Node ${process.version}`);
await sleep(1000);
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(0);
