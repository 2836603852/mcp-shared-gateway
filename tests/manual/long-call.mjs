// Manual check (not in CI, takes over 5 minutes): a call that lasts longer than 300 s must succeed through
// the shim. fetch() gives up after 300 s without response headers, which is why the shim uses node:http.
//   node tests/manual/long-call.mjs [ms]   (default 320000)
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ms = Number(process.argv[2]) || 320000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-shared-gateway-longcall-'));
const port = await new Promise(resolve => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const echo = { scope: 'shared', command: process.execPath, args: [path.join(ROOT, 'tests', 'fixtures', 'echo-server.mjs')] };
fs.writeFileSync(path.join(dir, 'servers.json'), JSON.stringify({ gateway: { port }, servers: { echo } }));
const env = { ...process.env, MCP_GATEWAY_CONFIG: path.join(dir, 'servers.json'), MCP_GATEWAY_STATE: path.join(dir, 'state') };

const c = new Client({ name: 'longcall', version: '0' }, { capabilities: {} });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src', 'shim.mjs')], env, stderr: 'inherit' }));
const t0 = Date.now();
const r = await c.callTool({ name: 'call', arguments: { server: 'echo', tool: 'sleep', arguments: { ms }, timeout_sec: 600 } }, undefined, { timeout: 900_000 });
console.log(`after ${Math.round((Date.now() - t0) / 1000)}s isError=${Boolean(r.isError)} text=${r.content[0].text.slice(0, 200)}`);
await c.close();
const token = fs.readFileSync(path.join(dir, 'state', 'token'), 'utf8').trim();
await fetch(`http://127.0.0.1:${port}/admin/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
fs.rmSync(dir, { recursive: true, force: true });
process.exitCode = r.isError ? 1 : 0;
