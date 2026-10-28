// Manual check of the shared browser with two sessions (needs a "browser" section and a chrome-devtools-mcp
// server with "browser": true in your config). Each session must get its own window, navigate on its own
// and take its own screenshot.
//   node tests/manual/browser-sessions.mjs [server]   (default chrome-devtools)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const server = process.argv[2] || 'chrome-devtools';
const cfg = loadConfig();
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-shared-gateway-browser-'));
const run = id => `browser-check-${id}-${process.pid}`;
let failed = false;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed = true; };

const cli = (...args) => new Promise(resolve => execFile(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'), ...args],
  { windowsHide: true, timeout: 180_000 }, (err, stdout) => resolve({ ok: !err, text: String(stdout) })));
const call = (owner, tool, args = {}) => cli('call', server, tool, JSON.stringify(args), '--owner', run(owner));

async function windowOf(url) {
  const v = await (await fetch(`http://127.0.0.1:${cfg.browser.port}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0;
  const waiters = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); waiters.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { waiters.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const { result } = await send('Target.getTargets');
  const target = result.targetInfos.find(t => t.type === 'page' && t.url.startsWith(url));
  const w = target ? await send('Browser.getWindowForTarget', { targetId: target.targetId }) : null;
  ws.close();
  return w?.result?.windowId ?? null;
}

const pages = { A: 'https://example.com/', B: 'https://example.org/' };
for (const [owner, url] of Object.entries(pages)) {
  check((await call(owner, 'navigate_page', { type: 'url', url })).ok, `${owner}: navigate to ${url}`);
}
for (const [owner, url] of Object.entries(pages)) {
  const r = await call(owner, 'evaluate_script', { function: '() => location.href' });
  check(r.text.includes(url), `${owner}: still on its own page`);
  const file = path.join(out, `${owner}.png`);
  await call(owner, 'take_screenshot', { filePath: file });
  check(fs.existsSync(file) && fs.statSync(file).size > 0, `${owner}: screenshot ${file}`);
}
const [wa, wb] = [await windowOf(pages.A), await windowOf(pages.B)];
check(wa !== null && wb !== null && wa !== wb, `sessions use different windows (${wa}, ${wb})`);
for (const owner of Object.keys(pages)) await cli('reset', server, '--owner', run(owner));
process.exit(failed ? 1 : 0);
