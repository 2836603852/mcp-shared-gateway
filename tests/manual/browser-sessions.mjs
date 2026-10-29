// Manual check of the shared browser with two sessions (needs a "browser" section and a chrome-devtools-mcp
// server with "browser": true in your config). Each session must get its own window, navigate on its own
// and take its own screenshot. A third session's first new_page must use its window's blank start tab, the
// second one must open a tab next to it.
//   node tests/manual/browser-sessions.mjs [server]   (default chrome-devtools)
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const server = process.argv[2] || 'chrome-devtools';
const cfg = loadConfig();
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const out = fs.mkdtempSync(path.join(ROOT, '.tmp', 'browser-check-'));
const run = id => `browser-check-${id}-${process.pid}`;
let failed = false;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed = true; };

const cli = (...args) => new Promise(resolve => execFile(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'), ...args],
  { windowsHide: true, timeout: 180_000 }, (err, stdout) => resolve({ ok: !err, text: String(stdout) })));
const call = (owner, tool, args = {}) => cli('call', server, tool, JSON.stringify(args), '--owner', run(owner));

// The window of the first page whose URL starts with url, and the URLs of all pages in that window.
async function windowOf(url, terminateScript = false) {
  const v = await (await fetch(`http://127.0.0.1:${cfg.browser.port}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  const timer = setTimeout(() => ws.close(), 15_000);
  let id = 0;
  const waiters = new Map();
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = ws.onclose = () => reject(new Error('CDP connection closed')); });
    ws.onmessage = ev => { const m = JSON.parse(ev.data); const w = waiters.get(m.id); waiters.delete(m.id); if (m.error) w?.reject(new Error(m.error.message)); else w?.resolve(m); };
    ws.onclose = ws.onerror = () => { for (const w of waiters.values()) w.reject(new Error('CDP connection closed')); waiters.clear(); };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { waiters.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const pages = (await send('Target.getTargets')).result.targetInfos.filter(t => t.type === 'page');
    const wins = await Promise.all(pages.map(t => send('Browser.getWindowForTarget', { targetId: t.targetId }).then(w => w.result?.windowId ?? null)));
    const i = pages.findIndex(t => t.url.startsWith(url));
    if (terminateScript && i >= 0) {
      const attached = await send('Target.attachToTarget', { targetId: pages[i].targetId, flatten: true });
      await send('Runtime.terminateExecution', {}, attached.result.sessionId);
      await send('Target.detachFromTarget', { sessionId: attached.result.sessionId });
    }
    const windowId = i >= 0 ? wins[i] : null;
    return { windowId, urls: windowId === null ? [] : pages.filter((_, j) => wins[j] === windowId).map(t => t.url) };
  } finally {
    clearTimeout(timer);
    ws.close();
  }
}

// Local pages avoid dependence on internet access and cannot match an unrelated user's example.com tab.
const page = id => `data:text/html,${encodeURIComponent(`<title>gateway-${process.pid}-${id}</title><main>${id}</main>`)}`;
const pages = { A: page('A'), B: page('B') };
try {
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

  const tabs = [page('C1'), page('C2')];
  check((await call('C', 'new_page', { url: tabs[0] })).ok, `C: new_page ${tabs[0]}`);
  let c = await windowOf(tabs[0]);
  check(c.urls.length === 1, `C: first new_page used the blank start tab (window has ${JSON.stringify(c.urls)})`);
  check((await call('C', 'new_page', { url: tabs[1], background: true })).ok, `C: new_page ${tabs[1]}`);
  c = await windowOf(tabs[0]);
  check(c.urls.length === 2 && c.urls.some(u => u.startsWith(tabs[1])), `C: second new_page opened a tab next to it (window has ${JSON.stringify(c.urls)})`);
  check(c.windowId !== wa && c.windowId !== wb, 'C: its own window');
  const r = await call('C', 'evaluate_script', { function: '() => location.href' });
  check(r.text.includes(tabs[1]), 'C: the new tab is selected');

  const d = await call('D', 'list_pages');
  const startId = Number(d.text.match(/^(\d+):.*\[selected\]/m)?.[1]);
  check(Number.isFinite(startId), 'D: found its selected start page');
  check((await call('D', 'evaluate_script', { function: '() => { document.body.innerHTML = "<main>keep-this-content</main>"; return location.href; }' })).ok, 'D: write content without navigating');
  const protectedUrl = page('D-new');
  check((await call('D', 'new_page', { url: protectedUrl, background: true })).ok, 'D: open another page');
  check((await windowOf(protectedUrl)).urls.length === 2, 'D: new_page preserves the used start page');
  await call('D', 'select_page', { pageId: startId, bringToFront: false });
  check((await call('D', 'evaluate_script', { function: '() => document.body.innerText' })).text.includes('keep-this-content'), 'D: start-page content is intact');

  check((await call('E', 'new_page', { url: page('E') })).ok, 'E: open a page for the blocked-script check');
  const busy = await call('E', 'evaluate_script', { function: '() => { const s = document.createElement("script"); s.textContent = "setTimeout(() => { const end = performance.now() + 12000; while (performance.now() < end) {} }, 1000)"; document.body.appendChild(s); return true; }' });
  check(busy.ok, 'E: installed a delayed busy script in the disposable page');
  await new Promise(r => setTimeout(r, 1200));
  const b = await call('B', 'list_pages');
  await call('B', 'select_page', { pageId: Number(b.text.match(/^(\d+):.*\[selected\]/m)?.[1]), bringToFront: true });
  const blocked = page('E-blocked');
  check(!(await call('E', 'new_page', { url: blocked, background: true })).ok, 'E: blocked tab creation reports an error');
  check((await windowOf(blocked)).windowId === null, 'E: failed creation did not fall back to another session window');
} finally {
  await windowOf(page('E'), true).catch(() => {});
  for (const owner of [...Object.keys(pages), 'C', 'D', 'E']) await cli('reset', server, '--owner', run(owner));
}
if (!failed) fs.rmSync(out, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
