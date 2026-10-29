// Run browser and lifecycle checks using a disposable profile and free ports. Reads only the browser
// and browser-server settings from MCP_GATEWAY_CONFIG. Never stops the configured production gateway.
//   node tests/manual/isolated-browser.mjs [code-root]
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const code = path.resolve(process.argv[2] || ROOT);
const original = loadConfig();
if (!original.browser || !original.servers['chrome-devtools']?.browser) throw new Error('Configure browser and chrome-devtools first');
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const dir = fs.mkdtempSync(path.join(ROOT, '.tmp', 'isolated-browser-'));
const freePort = () => new Promise(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const port = await freePort();
let browserPort = await freePort();
while (port === browserPort) browserPort = await freePort();
const url = `http://127.0.0.1:${port}`;
const server = original.servers['chrome-devtools'];
const config = path.join(dir, 'servers.json');
fs.writeFileSync(config, JSON.stringify({
  gateway: { port, heartbeatSec: 1 },
  browser: { ...original.browser, port: browserPort, userDataDir: path.join(dir, 'profile') },
  servers: { 'chrome-devtools': { ...server, args: server.args.map(a => a.replace(`127.0.0.1:${original.browser.port}`, `127.0.0.1:${browserPort}`)) } },
}));
const env = { ...process.env, MCP_GATEWAY_CONFIG: config, MCP_GATEWAY_STATE: path.join(dir, 'state') };
const gateway = spawn(process.execPath, [path.join(code, 'src/gateway.mjs')], { env, stdio: 'ignore', windowsHide: true });
const run = script => new Promise((resolve, reject) => {
  execFile(process.execPath, [path.join(code, 'tests/manual', script)], { env, windowsHide: true, timeout: 180_000 }, (err, stdout, stderr) => {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    if (err) reject(err); else resolve();
  });
});
console.log(`Isolated gateway ${port}, Chrome ${browserPort}, profile ${path.join(dir, 'profile')}`);
let passed = false;
try {
  await run('browser-sessions.mjs');
  await run('lifecycle.mjs');
  passed = true;
} finally {
  // All cleanup addresses the disposable ports/profile, never the configured shared browser.
  try {
    const token = fs.readFileSync(path.join(dir, 'state/token'), 'utf8').trim();
    await fetch(`${url}/admin/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
  } catch {}
  await new Promise(r => setTimeout(r, 800));
  gateway.kill();
  try {
    const v = await (await fetch(`http://127.0.0.1:${browserPort}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
    await new Promise(resolve => {
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      const timer = setTimeout(() => { ws.close(); resolve(); }, 3000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      ws.onclose = ws.onerror = () => { clearTimeout(timer); resolve(); };
    });
  } catch {}
  await new Promise(r => setTimeout(r, 800));
  if (passed) fs.rmSync(dir, { recursive: true, force: true });
  else console.log(`Failure evidence kept in ${dir}`);
}
