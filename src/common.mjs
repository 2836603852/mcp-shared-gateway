// Paths, config, token, logging and child-process env shared by the gateway, shim and CLI.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = path.resolve(process.env.MCP_GATEWAY_CONFIG || path.join(ROOT, 'config', 'servers.json'));
export const STATE_DIR = path.resolve(process.env.MCP_GATEWAY_STATE || path.join(ROOT, '.local'));
export const LOG_DIR = path.join(STATE_DIR, 'logs');
export const CATALOG_DIR = path.join(STATE_DIR, 'catalog');
export const TOKEN_FILE = path.join(STATE_DIR, 'token');
export const PID_FILE = path.join(STATE_DIR, 'gateway.pid');
export const SECRETS_FILE = path.join(STATE_DIR, 'secrets.json');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const GATEWAY_DEFAULTS = {
  host: '127.0.0.1',
  port: 18760,
  idleMinutes: 15,
  inlineTextLimit: 40000,
  defaultTimeoutSec: 120,
  maxTimeoutSec: 900,
};

export function ensureDirs(cfg) {
  for (const d of [STATE_DIR, LOG_DIR, CATALOG_DIR, cfg.gateway.outputDir, cfg.gateway.workDir]) fs.mkdirSync(d, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// ${NAME} is resolved from secrets.json, then from the environment; unresolved names are left as-is
// so the backend's error shows which one is missing. ${CWD} and ${CLIENT} are filled in per instance.
const PER_INSTANCE = new Set(['CWD', 'CLIENT']);
function substitute(value, secrets) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (m, name) => (PER_INSTANCE.has(name) ? m : secrets[name] ?? process.env[name] ?? m));
  }
  if (Array.isArray(value)) return value.map(v => substitute(v, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, secrets)]));
  }
  return value;
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`Config not found: ${CONFIG_FILE}. Copy config/servers.example.json to config/servers.json and edit it.`);
  }
  const raw = readJson(CONFIG_FILE);
  const cfg = substitute(raw, readJson(SECRETS_FILE, {}));
  const G = cfg.gateway = { ...GATEWAY_DEFAULTS, ...(cfg.gateway || {}) };
  cfg.servers = cfg.servers || {};
  // Relative paths in the gateway section are relative to the config file.
  const here = p => path.resolve(path.dirname(CONFIG_FILE), p);
  G.outputDir = G.outputDir ? here(G.outputDir) : path.join(STATE_DIR, 'outputs');
  G.workDir = G.workDir ? here(G.workDir) : path.join(STATE_DIR, 'work');
  if (G.instructionsFile) G.instructions = fs.readFileSync(here(G.instructionsFile), 'utf8').trim();
  else if (Array.isArray(G.instructions)) G.instructions = G.instructions.join('\n');
  return cfg;
}

export function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return null;
  }
}

export function ensureToken() {
  const existing = readToken();
  if (existing) return existing;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const token = crypto.randomBytes(24).toString('hex');
  try {
    fs.writeFileSync(TOKEN_FILE, token, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') return readToken();
    throw err;
  }
  return token;
}

// 50 MiB per file, 3 files kept (current + .1 + .2).
const LOG_MAX = 50 * 1024 * 1024;
const LOG_KEEP = 3;

export function appendLog(name, line) {
  const file = path.join(LOG_DIR, name);
  try {
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st && st.size > LOG_MAX) {
      for (let i = LOG_KEEP - 1; i >= 1; i--) {
        const from = i === 1 ? file : `${file}.${i - 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i}`);
      }
    }
    fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n');
  } catch {
    // logging must never break the main flow
  }
}

export function log(event, fields = {}) {
  appendLog('gateway.log', JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];

// Env for child processes. Variables injected by AI clients (CLAUDE*, CODEX*, ...) are dropped so that a
// backend shared by several clients does not inherit one client's session settings. When `gateway.proxy`
// is set, it replaces whatever proxy the launching client had. `gateway.dropEnv` lists more names to drop
// (e.g. NODE_EXTRA_CA_CERTS that a client's own MITM proxy needs).
export function cleanEnv(gatewayCfg, extra = {}) {
  const env = {};
  const overrideProxy = Boolean(gatewayCfg?.proxy || gatewayCfg?.noProxy);
  const drop = new Set((gatewayCfg?.dropEnv || []).map(k => k.toUpperCase()));
  for (const [k, v] of Object.entries(process.env)) {
    const up = k.toUpperCase();
    if (/^(CLAUDE|CODEX|ZCODE|CURSOR_TRACE)/.test(up) || drop.has(up)) continue;
    if (overrideProxy && (PROXY_KEYS.includes(up) || up === 'NODE_USE_ENV_PROXY')) continue;
    env[k] = v;
  }
  if (gatewayCfg?.proxy) {
    env.HTTP_PROXY = env.HTTPS_PROXY = env.http_proxy = env.https_proxy = gatewayCfg.proxy;
  }
  if (gatewayCfg?.noProxy) env.NO_PROXY = env.no_proxy = gatewayCfg.noProxy;
  for (const [k, v] of Object.entries(extra)) {
    if (PROXY_KEYS.includes(k.toUpperCase())) env[k.toLowerCase()] = v;
    env[k] = v;
  }
  return env;
}

export function gatewayUrl(cfg) {
  return `http://${cfg.gateway.host}:${cfg.gateway.port}`;
}

export async function healthCheck(cfg, timeoutMs = 1500) {
  try {
    const res = await fetch(`${gatewayUrl(cfg)}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
