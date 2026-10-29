// Manual check of the shared browser with two sessions (needs a "browser" section and a chrome-devtools-mcp
// server with "browser": true in your config). Each session must get its own window, navigate on its own
// and take its own screenshot. A third session's first new_page must use its window's blank start tab, the
// second one must open a tab next to it.
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

// The window of the first page whose URL starts with url, and the URLs of all pages in that window.
async function windowOf(url) {
  const v = await (await fetch(`http://127.0.0.1:${cfg.browser.port}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0;
  const waiters = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); waiters.get(m.id)?.(m); };
  const send = (method, params = {}) => new Promise(r => { waiters.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const pages = (await send('Target.getTargets')).result.targetInfos.filter(t => t.type === 'page');
  const wins = await Promise.all(pages.map(t => send('Browser.getWindowForTarget', { targetId: t.targetId }).then(w => w.result?.windowId ?? null)));
  ws.close();
  const i = pages.findIndex(t => t.url.startsWith(url));
  const windowId = i >= 0 ? wins[i] : null;
  return { windowId, urls: windowId === null ? [] : pages.filter((_, j) => wins[j] === windowId).map(t => t.url) };
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
const [wa, wb] = [(await windowOf(pages.A)).windowId, (await windowOf(pages.B)).windowId];
check(wa !== null && wb !== null && wa !== wb, `sessions use different windows (${wa}, ${wb})`);

const tabs = ['https://example.net/', 'https://www.iana.org/help/example-domains'];
check((await call('C', 'new_page', { url: tabs[0] })).ok, `C: new_page ${tabs[0]}`);
let c = await windowOf(tabs[0]);
check(c.urls.length === 1, `C: first new_page used the blank start tab (window has ${JSON.stringify(c.urls)})`);
check((await call('C', 'new_page', { url: tabs[1], background: true })).ok, `C: new_page ${tabs[1]}`);
c = await windowOf(tabs[0]);
check(c.urls.length === 2 && c.urls.some(u => u.startsWith(tabs[1])), `C: second new_page opened a tab next to it (window has ${JSON.stringify(c.urls)})`);
check(c.windowId !== wa && c.windowId !== wb, 'C: its own window');
const r = await call('C', 'evaluate_script', { function: '() => location.href' });
check(r.text.includes(tabs[1]), 'C: the new tab is selected');

for (const owner of [...Object.keys(pages), 'C']) await cli('reset', server, '--owner', run(owner));
if (!failed) fs.rmSync(out, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
