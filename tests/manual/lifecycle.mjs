// Manual check against the gateway of your config (it restarts that gateway; run it when nobody is mid-call).
//   node tests/manual/lifecycle.mjs
// 1. A shim starts the gateway (if needed); killing the shim's whole process tree must not kill the gateway
//    (on Windows the gateway is started through WMI, outside the client's tree and job object).
// 2. The gateway is stopped while a shim is connected; the shim's next call must start a new gateway.
// 3. Another client starts the new gateway first; the shim must still reconnect.
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, gatewayUrl, healthCheck, readToken, sleep } from '../../src/common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cfg = loadConfig();
const alive = pid => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
let failed = false;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed = true; };

// A bare stdio client, so that killing it kills nothing but the shim tree.
function startShim(name) {
  const p = spawn(process.execPath, [path.join(ROOT, 'src', 'shim.mjs')], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let buf = '';
  const waiters = new Map();
  p.stdout.on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); waiters.get(m.id)?.(m); } catch {}
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise(resolve => {
    waiters.set(++id, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const status = async () => {
    const r = await rpc('tools/call', { name: 'status', arguments: {} });
    try { return JSON.parse(r.result.content[0].text).gateway.pid; } catch { return null; }
  };
  const ready = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1' } })
    .then(() => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'));
  return { p, ready, status };
}

const shutdown = () => fetch(`${gatewayUrl(cfg)}/admin/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${readToken()}` } });

const a = startShim('lifecycle-a');
await a.ready;
const gw = await a.status();
check(Boolean(gw), `shim reached the gateway (pid ${gw})`);
if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(a.p.pid)], { windowsHide: true, stdio: 'ignore' });
else a.p.kill('SIGKILL');
await sleep(1000);
check(alive(gw) && Boolean(await healthCheck(cfg)), 'gateway survives when the client kills the shim tree');

for (const relaunched of [false, true]) {
  const b = startShim('lifecycle-b');
  await b.ready;
  const before = await b.status();
  await shutdown();
  await sleep(1500);
  if (relaunched) execFileSync(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'), 'status'], { windowsHide: true, stdio: 'ignore' });
  const after = await b.status();
  check(Boolean(after) && after !== before, `shim reconnects after a gateway restart${relaunched ? ' started by another client' : ''} (${before} -> ${after})`);
  b.p.kill();
}
process.exit(failed ? 1 : 0);
