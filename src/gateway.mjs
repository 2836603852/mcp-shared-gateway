// The gateway: one MCP server over HTTP on localhost. Backend MCP servers are started on demand,
// shared between sessions according to their scope, and stopped when idle.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  CATALOG_DIR, PID_FILE, VERSION,
  ensureDirs, ensureToken, loadConfig, appendLog, log, cleanEnv, sleep,
} from './common.mjs';
import { META_TOOLS, buildInstructions, CLIENT_CWD_KEY } from './meta.mjs';

const cfg = loadConfig();
const G = cfg.gateway;
const B = cfg.browser || null;
const IDLE_MS = (Number(process.env.GW_IDLE_MINUTES) || G.idleMinutes) * 60_000;
const INSTRUCTIONS = buildInstructions(cfg);
ensureDirs(cfg);
const token = ensureToken();
const startedAt = Date.now();

const instances = new Map(); // key -> instance
const pending = new Map(); // key -> Promise of an instance being created
const catalogPending = new Map();
const sessions = new Map(); // MCP session id -> { transport, mcp, lastSeen }
const rpcOwners = new Map(); // owner calling through /rpc -> lastSeen
const recentErrors = [];

function pushError(where, err) {
  const msg = err instanceof Error ? err.message : String(err);
  recentErrors.push({ t: new Date().toISOString(), where, msg });
  if (recentErrors.length > 20) recentErrors.shift();
  log('error', { where, msg });
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function killTree(pid) {
  if (!pid) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise(resolve => execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => resolve()));
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  return Promise.resolve();
}

const tmpl = (s, vars) => (typeof s === 'string' ? s.replace(/\$\{(CWD|CLIENT)\}/g, (_, k) => vars[k] ?? '') : s);
const firstLine = (s, n = 140) => {
  const line = String(s || '').split('\n').find(l => l.trim()) || '';
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
};

// ---------- caller identity ----------
// The shim and CLI put their identity in clientInfo.name: gw-shim/<client>/<unique id>, gw-cli/cli/<owner>.
function ownerCtx(name = 'anonymous') {
  const parts = name.split('/');
  const client = parts[0].startsWith('gw-') ? (parts[1] || 'unknown') : name;
  return { owner: name, client };
}

// ${CLIENT} in args/cwdArgs/clientEnv: the client name, mapped through gateway.clientAliases
// ({ "<case-insensitive regex>": "<alias>" }, first match wins), e.g. codex-mcp-client -> codex.
const clientAliases = Object.entries(G.clientAliases || {}).map(([re, alias]) => [new RegExp(re, 'i'), alias]);
const clientAlias = client => clientAliases.find(([re]) => re.test(client))?.[1] ?? client;

// ---------- shared browser (optional) ----------
const browser = {
  starting: null,
  async info() {
    if (!B) return null;
    try {
      const r = await fetch(`http://127.0.0.1:${B.port}/json/version`, { signal: AbortSignal.timeout(1500) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  },
  async ensure() {
    if (!B) throw new Error('No "browser" section in the config');
    if (await this.info()) return;
    if (!this.starting) {
      this.starting = (async () => {
        fs.mkdirSync(B.userDataDir, { recursive: true });
        const args = [`--remote-debugging-port=${B.port}`, `--user-data-dir=${B.userDataDir}`, ...(B.args || [])];
        let spawnError = null;
        const p = spawn(B.executable, args, { detached: true, stdio: 'ignore', env: cleanEnv(G) });
        p.on('error', err => { spawnError = err; });
        p.unref();
        log('browser.launch', { pid: p.pid });
        for (let i = 0; i < 60; i++) {
          await sleep(500);
          if (spawnError) throw new Error(`Cannot start the shared browser (${B.executable}): ${spawnError.message}`);
          if (await this.info()) return;
        }
        throw new Error(`Shared browser not ready after 30s${await this.blocker()}`);
      })().finally(() => { this.starting = null; });
    }
    return this.starting;
  },
  // If the profile was opened by a normal shortcut, that Chrome has no debug port and swallows our launch.
  blocker() {
    if (process.platform !== 'win32') return Promise.resolve('');
    const dir = B.userDataDir.replace(/'/g, "''");
    const script = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${dir}*' -and $_.CommandLine -notlike '*--remote-debugging-port*' -and $_.CommandLine -notlike '*--type=*' } | ForEach-Object { $_.ProcessId }`;
    return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15_000 }, (err, stdout) => {
      const pids = String(stdout || '').trim().split(/\s+/).filter(Boolean);
      resolve(pids.length
        ? `: profile ${B.userDataDir} is held by a Chrome without a debug port (pid ${pids.join(', ')}). Close it, then use "mcpx browser" to open the shared browser.`
        : '');
    }));
  },
  async cdp(method, params) {
    const v = await this.info();
    if (!v) throw new Error('Shared browser is not running');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`CDP ${method} timed out`)); }, 10_000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
      ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id !== 1) return;
        clearTimeout(timer);
        ws.close();
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      };
      ws.onerror = e => { clearTimeout(timer); reject(new Error(`CDP connection failed: ${e.message || e.type}`)); };
    });
  },
  async openWindow(marker) {
    const r = await this.cdp('Target.createTarget', { url: `about:blank#${marker}`, newWindow: true });
    return r.targetId;
  },
  async closeTarget(id) {
    try {
      await fetch(`http://127.0.0.1:${B.port}/json/close/${id}`, { signal: AbortSignal.timeout(3000) });
    } catch {}
  },
};

// Give an owner its own window and make its chrome-devtools-mcp instance select it (without stealing focus).
async function setupWindow(inst) {
  const marker = `gw-${crypto.randomBytes(4).toString('hex')}`;
  inst.windowTarget = await browser.openWindow(marker);
  for (let i = 0; i < 15; i++) {
    const r = await inst.mcp.callTool({ name: 'list_pages', arguments: {} }, undefined, { timeout: 30_000 });
    const text = (r.content || []).map(c => c.text || '').join('\n');
    const line = text.split('\n').find(l => l.includes(marker));
    const m = line && line.match(/^(\d+):/);
    if (m) {
      await inst.mcp.callTool({ name: 'select_page', arguments: { pageId: Number(m[1]), bringToFront: false } }, undefined, { timeout: 30_000 });
      inst.windowPageId = Number(m[1]);
      return;
    }
    await sleep(300);
  }
  throw new Error('New window did not show up in list_pages');
}

// ---------- backend instances ----------
function resolveCwd(def, args) {
  const raw = args.cwd || args[CLIENT_CWD_KEY] || null;
  if (!raw) {
    if (def.cwd === 'required') throw new Error('This server needs cwd (absolute path of the project root)');
    return null;
  }
  const cwd = path.resolve(raw);
  if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  return cwd;
}

// The key decides sharing: owner-scoped servers include the caller, shared ones use '*' for everybody.
function instanceKey(name, def, ctx, cwd) {
  const who = def.scope === 'owner' ? ctx.owner : '*';
  const where = def.cwd === 'key' || def.cwd === 'required' ? (cwd || '').toLowerCase() : '';
  return `${name}|${who}|${where}`;
}

function spawnTransport(name, def, ctx, cwd) {
  if (def.url) {
    return new StreamableHTTPClientTransport(new URL(def.url), { requestInit: { headers: def.headers || {} } });
  }
  const vars = { CWD: cwd || '', CLIENT: clientAlias(ctx.client) };
  const args = [...(def.args || []), ...((cwd && def.cwdArgs) || [])].map(a => tmpl(a, vars));
  const env = { ...(def.env || {}) };
  for (const [k, v] of Object.entries(def.clientEnv || {})) env[k] = tmpl(v, vars);
  const transport = new StdioClientTransport({
    command: def.command,
    args,
    env: cleanEnv(G, env),
    cwd: cwd || G.workDir,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', d => appendLog(`${name}.stderr.log`, `[${new Date().toISOString()}] [${ctx.owner}] ${String(d).trimEnd()}`));
  return transport;
}

async function createInstance(name, def, key, ctx, cwd, { catalogOnly = false } = {}) {
  let browserWs = null;
  if (def.browser && !catalogOnly) {
    await browser.ensure();
    browserWs = (await browser.info())?.webSocketDebuggerUrl || null;
  }
  const transport = spawnTransport(name, def, ctx, cwd);
  const mcp = new Client({ name: 'mcp-shared-gateway', version: VERSION }, { capabilities: {} });
  const inst = {
    key, name, owner: ctx.owner, client: ctx.client, cwd, mcp, transport,
    startedAt: Date.now(), lastUsed: Date.now(), busy: 0, chain: Promise.resolve(),
    serial: def.scope === 'owner', closed: false, pid: null, windowTarget: null, browserWs,
  };
  mcp.onclose = () => onClosed(inst, 'backend connection closed');
  try {
    await withTimeout(mcp.connect(transport), (def.startupTimeoutSec || 60) * 1000, `${name} startup timed out`);
  } catch (err) {
    inst.closed = true;
    await killTree(transport.pid);
    try { await mcp.close(); } catch {}
    throw err;
  }
  inst.pid = transport.pid ?? null;
  if (catalogOnly) return inst;
  instances.set(key, inst);
  log('instance.start', { server: name, owner: ctx.owner, cwd, pid: inst.pid });
  if (!readCatalog(name, def)) {
    try { writeCatalog(name, def, await fetchCatalog(mcp)); } catch (err) { pushError(`${name}.catalog`, err); }
  }
  if (def.browser) {
    try { await setupWindow(inst); } catch (err) { pushError(`${name}.window`, err); }
  }
  return inst;
}

function onClosed(inst, reason) {
  if (inst.closed) return;
  inst.closed = true;
  if (instances.get(inst.key) === inst) instances.delete(inst.key);
  if (inst.windowTarget) browser.closeTarget(inst.windowTarget);
  log('instance.closed', { server: inst.name, owner: inst.owner, reason });
}

async function closeInstance(inst, reason) {
  if (inst.closed) return;
  inst.closed = true;
  if (instances.get(inst.key) === inst) instances.delete(inst.key);
  if (inst.windowTarget) await browser.closeTarget(inst.windowTarget);
  await killTree(inst.pid);
  try { await inst.mcp.close(); } catch {}
  log('instance.stop', { server: inst.name, owner: inst.owner, reason });
}

async function getInstance(name, def, ctx, cwd) {
  const key = instanceKey(name, def, ctx, cwd);
  let existing = instances.get(key);
  // If the shared browser was closed and relaunched, the old instance points at a dead browser; replace it.
  if (def.browser && existing && !existing.closed && !pending.has(key)) {
    await browser.ensure();
    const ws = (await browser.info())?.webSocketDebuggerUrl || null;
    if (ws !== existing.browserWs) {
      await closeInstance(existing, 'shared browser restarted');
      existing = null;
    }
  }
  if (existing && !existing.closed) return existing;
  if (pending.has(key)) return pending.get(key);
  const p = createInstance(name, def, key, ctx, cwd).finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

// Calls on owner-scoped instances run in order (keeps selected page, current device etc. consistent);
// shared instances run concurrently.
function runOn(inst, fn) {
  const exec = async () => {
    inst.busy++;
    inst.lastUsed = Date.now();
    try {
      return await fn(inst.mcp);
    } finally {
      inst.busy--;
      inst.lastUsed = Date.now();
    }
  };
  if (!inst.serial) return exec();
  const p = inst.chain.then(exec, exec);
  inst.chain = p.catch(() => {});
  return p;
}

// ---------- tool catalog cache ----------
// list/describe are answered from this cache, so browsing tools does not start any backend.
const catalogFile = name => path.join(CATALOG_DIR, `${name}.json`);
const catalogHash = def => crypto.createHash('sha1')
  .update(JSON.stringify({ c: def.command, a: def.args, u: def.url, v: def.version })).digest('hex').slice(0, 12);

function readCatalog(name, def) {
  try {
    const c = JSON.parse(fs.readFileSync(catalogFile(name), 'utf8'));
    return c.hash === catalogHash(def) ? c : null;
  } catch {
    return null;
  }
}

function writeCatalog(name, def, cat) {
  fs.writeFileSync(catalogFile(name), JSON.stringify({ hash: catalogHash(def), fetchedAt: new Date().toISOString(), ...cat }, null, 1));
}

async function fetchCatalog(mcp) {
  const tools = [];
  let cursor;
  do {
    const r = await mcp.listTools(cursor ? { cursor } : {}, { timeout: 60_000 });
    tools.push(...r.tools);
    cursor = r.nextCursor;
  } while (cursor);
  const instructions = mcp.getInstructions?.() || '';
  return { tools, instructions, hasResources: Boolean(mcp.getServerCapabilities()?.resources) };
}

async function ensureCatalog(name, def) {
  const cached = readCatalog(name, def);
  if (cached) return cached;
  if (catalogPending.has(name)) return catalogPending.get(name);
  const p = (async () => {
    for (const inst of instances.values()) {
      if (inst.name === name && !inst.closed) {
        const cat = await fetchCatalog(inst.mcp);
        writeCatalog(name, def, cat);
        return readCatalog(name, def);
      }
    }
    const inst = await createInstance(name, def, `${name}|__catalog__|`, { owner: '__catalog__', client: 'catalog' }, null, { catalogOnly: true });
    try {
      writeCatalog(name, def, await fetchCatalog(inst.mcp));
      return readCatalog(name, def);
    } finally {
      inst.closed = true;
      await killTree(inst.pid);
      try { await inst.mcp.close(); } catch {}
    }
  })().finally(() => catalogPending.delete(name));
  catalogPending.set(name, p);
  return p;
}

// ---------- results ----------
const safeName = s => String(s).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 60);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

function spillText(full, server, tool) {
  const file = path.join(G.outputDir, `${stamp()}_${crypto.randomBytes(2).toString('hex')}_${safeName(server)}_${safeName(tool)}.txt`);
  fs.writeFileSync(file, full);
  return `${full.slice(0, 4000)}\n\n…[full text, ${full.length} chars, written to ${file}]`;
}

function postProcess(result, server, tool) {
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = content.filter(c => c.type === 'text');
  const total = texts.reduce((n, c) => n + (c.text?.length || 0), 0);
  let out = content;
  if (total > G.inlineTextLimit) {
    const full = texts.map(c => c.text).join('\n');
    out = [{ type: 'text', text: spillText(full, server, tool) }, ...content.filter(c => c.type !== 'text')];
  }
  const res = { content: out };
  if (result.isError) res.isError = true;
  if (result.structuredContent && JSON.stringify(result.structuredContent).length <= G.inlineTextLimit) {
    res.structuredContent = result.structuredContent;
  }
  return res;
}

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

function getDef(server) {
  const def = cfg.servers[server];
  if (!def) throw new Error(`Unknown server: ${server}. Available: ${Object.keys(cfg.servers).join(', ')}`);
  return def;
}

const scopeLabel = def => (def.scope === 'owner' ? 'per session' : 'shared') + (def.cwd === 'required' ? ', needs cwd' : def.cwd === 'key' ? ', per directory' : '');

// ---------- meta-tools ----------
async function handleMeta(name, args, ctx) {
  switch (name) {
    case 'list': {
      if (!args.server && !args.query) {
        const lines = Object.entries(cfg.servers).map(([n, def]) => {
          const cat = readCatalog(n, def);
          const running = [...instances.values()].filter(i => i.name === n).length;
          return `- ${n} (${scopeLabel(def)}${def.version ? `; version ${def.version}` : ''}; tools ${cat ? cat.tools.length : 'not cached'}; running ${running}): ${def.description || ''}`;
        });
        return textResult(`Servers:\n${lines.join('\n')}\n\nUse list(server) for tools and describe(server, tool) for arguments.`);
      }
      const targets = args.server ? [args.server] : Object.keys(cfg.servers);
      const q = (args.query || '').toLowerCase();
      const out = [];
      const failed = [];
      for (const n of targets) {
        const def = getDef(n);
        let cat;
        try { cat = await ensureCatalog(n, def); } catch (err) { failed.push(`${n}: ${err.message}`); continue; }
        for (const t of cat.tools) {
          if (q && !(`${t.name} ${t.description || ''}`.toLowerCase().includes(q))) continue;
          out.push(args.server ? `- ${t.name}: ${firstLine(t.description)}` : `- ${n} / ${t.name}: ${firstLine(t.description)}`);
        }
        if (args.server && cat.hasResources) out.push(`(this server provides resources; see resource(server="${n}"))`);
      }
      const head = args.server ? `Tools of ${args.server}${q ? ` matching "${args.query}"` : ''}:` : `Tools matching "${args.query}":`;
      const shown = out.slice(0, args.server ? 400 : 200);
      return textResult([head, ...(shown.length ? shown : ['(none)']), ...(out.length > shown.length ? [`…${out.length - shown.length} more`] : []), ...(failed.length ? ['', 'Failed:', ...failed] : [])].join('\n'));
    }
    case 'describe': {
      const def = getDef(args.server);
      const cat = await ensureCatalog(args.server, def);
      const t = cat.tools.find(x => x.name === args.tool);
      if (!t) {
        const near = cat.tools.map(x => x.name).filter(x => x.includes(args.tool) || args.tool.includes(x)).slice(0, 10);
        throw new Error(`${args.server} has no tool ${args.tool}${near.length ? `; similar: ${near.join(', ')}` : ''}`);
      }
      return textResult(`# ${args.server} / ${t.name}\n\n${t.description || ''}\n\nInput (JSON Schema):\n${JSON.stringify(t.inputSchema || {}, null, 2)}${t.outputSchema ? `\n\nOutput (JSON Schema):\n${JSON.stringify(t.outputSchema, null, 2)}` : ''}`);
    }
    case 'call': {
      if (!args.server || !args.tool) throw new Error('call needs server and tool');
      const def = getDef(args.server);
      const cwd = resolveCwd(def, args);
      const inst = await getInstance(args.server, def, ctx, cwd);
      const sec = Math.min(Math.max(Number(args.timeout_sec) || G.defaultTimeoutSec, 1), G.maxTimeoutSec);
      const t0 = Date.now();
      try {
        const result = await runOn(inst, mcp => mcp.callTool(
          { name: args.tool, arguments: args.arguments || {} },
          undefined,
          { timeout: sec * 1000, resetTimeoutOnProgress: true, maxTotalTimeout: G.maxTimeoutSec * 1000 },
        ));
        log('call', { owner: ctx.owner, server: args.server, tool: args.tool, ms: Date.now() - t0, isError: Boolean(result.isError) });
        return postProcess(result, args.server, args.tool);
      } catch (err) {
        log('call', { owner: ctx.owner, server: args.server, tool: args.tool, ms: Date.now() - t0, error: err.message });
        throw err;
      }
    }
    case 'resource': {
      const def = getDef(args.server);
      const cwd = resolveCwd(def, args);
      const inst = await getInstance(args.server, def, ctx, cwd);
      if (!args.uri) {
        const [res, tpl] = await runOn(inst, async mcp => [
          await mcp.listResources({}, { timeout: 60_000 }).catch(e => ({ error: e.message })),
          await mcp.listResourceTemplates({}, { timeout: 60_000 }).catch(() => ({ resourceTemplates: [] })),
        ]);
        if (res.error) throw new Error(`${args.server} does not support resources: ${res.error}`);
        const lines = [
          ...(res.resources || []).map(r => `- ${r.uri}${r.name ? ` (${r.name})` : ''}: ${firstLine(r.description)}`),
          ...(tpl.resourceTemplates || []).map(r => `- template ${r.uriTemplate}: ${firstLine(r.description)}`),
        ];
        return textResult(`Resources of ${args.server}:\n${lines.join('\n') || '(none)'}`);
      }
      const r = await runOn(inst, mcp => mcp.readResource({ uri: args.uri }, { timeout: 60_000 }));
      const content = (r.contents || []).map(c => (c.text !== undefined
        ? { type: 'text', text: c.text.length > G.inlineTextLimit ? spillText(c.text, args.server, 'resource') : c.text }
        : { type: 'resource', resource: c }));
      return { content: content.length ? content : [{ type: 'text', text: '(empty)' }] };
    }
    case 'status': {
      const info = await browser.info();
      const now = Date.now();
      const data = {
        gateway: { pid: process.pid, version: VERSION, port: G.port, uptimeMin: Math.round((now - startedAt) / 60_000), sessions: sessions.size + rpcOwners.size, idleMinutes: IDLE_MS / 60_000 },
        caller: ctx.owner,
        browser: B ? { running: Boolean(info), version: info?.Browser || null, port: B.port, userDataDir: B.userDataDir } : null,
        instances: [...instances.values()].map(i => ({
          server: i.name, owner: i.key.split('|')[1] === '*' ? '*' : i.owner, cwd: i.cwd, pid: i.pid, busy: i.busy,
          idleMin: Math.round((now - i.lastUsed) / 6000) / 10, window: i.windowTarget ? `pageId ${i.windowPageId ?? '?'}` : undefined,
        })),
        recentErrors,
      };
      return textResult(JSON.stringify(data, null, 2));
    }
    case 'reset': {
      const def = getDef(args.server);
      const who = def.scope === 'owner' ? ctx.owner : '*';
      const victims = [...instances.values()].filter(i => i.name === args.server && i.key.split('|')[1] === who);
      for (const i of victims) await closeInstance(i, 'reset');
      return textResult(`Stopped ${victims.length} ${args.server} instance(s).`);
    }
    default:
      throw new Error(`Unknown meta-tool: ${name}`);
  }
}

async function runMeta(name, args, ctx) {
  try {
    return await handleMeta(name, args, ctx);
  } catch (err) {
    pushError(`${name}:${args?.server || ''}`, err);
    return textResult(`Gateway error: ${err.message}`, true);
  }
}

// ---------- MCP sessions (HTTP) ----------
function createSessionServer() {
  const mcp = new Server({ name: 'mcp-shared-gateway', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: META_TOOLS }));
  mcp.setRequestHandler(CallToolRequestSchema, async req => runMeta(req.params.name, req.params.arguments || {}, ownerCtx(mcp.getClientVersion()?.name)));
  return mcp;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 64 * 1024 * 1024) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : undefined); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, pid: process.pid, version: VERSION, startedAt });
    }
    if (req.headers.authorization !== `Bearer ${token}`) return sendJson(res, 401, { error: 'unauthorized' });
    if (url.pathname === '/admin/shutdown' && req.method === 'POST') {
      sendJson(res, 200, { ok: true });
      setTimeout(() => shutdown('admin'), 50);
      return;
    }
    // For manual logins: make sure the shared browser runs with its debug port and open a window no session owns.
    if (url.pathname === '/admin/browser' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      await browser.ensure();
      const r = await browser.cdp('Target.createTarget', { url: body.url || 'chrome://newtab/', newWindow: true });
      return sendJson(res, 200, { ok: true, browser: (await browser.info())?.Browser, targetId: r.targetId });
    }
    // Lightweight path used by the shim: one meta-tool call per request, no MCP session or SDK needed.
    if (url.pathname === '/rpc' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      const ctx = ownerCtx(String(body.owner || 'anonymous'));
      rpcOwners.set(ctx.owner, Date.now());
      return sendJson(res, 200, await runMeta(String(body.name), body.arguments || {}, ctx));
    }
    if (url.pathname !== '/mcp') return sendJson(res, 404, { error: 'not found' });

    const sid = req.headers['mcp-session-id'];
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    if (sid) {
      const s = sessions.get(sid);
      if (!s) return sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
      s.lastSeen = Date.now();
      return await s.transport.handleRequest(req, res, body);
    }
    if (req.method === 'POST' && isInitializeRequest(body)) {
      const mcp = createSessionServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: id => sessions.set(id, { transport, mcp, lastSeen: Date.now() }),
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      await mcp.connect(transport);
      return await transport.handleRequest(req, res, body);
    }
    sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session' }, id: null });
  } catch (err) {
    pushError('http', err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  }
});

// ---------- idle reaping and cleanup ----------
function sweepOutputs() {
  try {
    const files = fs.readdirSync(G.outputDir).map(f => {
      const p = path.join(G.outputDir, f);
      const st = fs.statSync(p);
      return { p, mtime: st.mtimeMs, size: st.size };
    }).sort((a, b) => b.mtime - a.mtime);
    let total = 0;
    for (const f of files) {
      total += f.size;
      if (Date.now() - f.mtime > 24 * 3600_000 || total > 500 * 1024 * 1024) fs.rmSync(f.p, { force: true });
    }
  } catch (err) {
    pushError('sweepOutputs', err);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const inst of [...instances.values()]) {
    if (inst.busy === 0 && now - inst.lastUsed > IDLE_MS) closeInstance(inst, 'idle').catch(err => pushError('reap', err));
  }
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > 12 * 3600_000) { sessions.delete(id); s.transport.close().catch(() => {}); }
  }
  for (const [owner, seen] of rpcOwners) if (now - seen > 12 * 3600_000) rpcOwners.delete(owner);
}, Math.min(60_000, Math.max(1_000, IDLE_MS / 2))).unref();
setInterval(sweepOutputs, 3600_000).unref();

async function shutdown(reason) {
  log('gateway.stop', { reason });
  await Promise.allSettled([...instances.values()].map(i => closeInstance(i, 'shutdown')));
  try { fs.rmSync(PID_FILE, { force: true }); } catch {}
  httpServer.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', err => pushError('uncaught', err));
process.on('unhandledRejection', err => pushError('unhandled', err));

httpServer.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    log('gateway.exists', { port: G.port });
    process.exit(0);
  }
  pushError('listen', err);
  process.exit(1);
});

httpServer.listen(G.port, G.host, () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  log('gateway.start', { pid: process.pid, port: G.port, version: VERSION, idleMinutes: IDLE_MS / 60_000 });
  sweepOutputs();
});
