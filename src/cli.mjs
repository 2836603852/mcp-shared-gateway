#!/usr/bin/env node
// mcpx: command line for the gateway, for testing and emergencies.
//   mcpx status | list [server] [--query q] | describe <server> <tool>
//   mcpx call <server> <tool> [json | @file] [--cwd dir] [--timeout sec]
//   mcpx resource <server> [uri] [--cwd dir] | reset <server> | stop
//   mcpx browser [url]   open a new window of the shared browser (for logging in to sites by hand)
// Options: --owner <name> (default "cli"; calls with the same owner reuse the same per-session instances), --json
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, gatewayUrl, healthCheck, readToken, ensureDirs } from './common.mjs';
import { connectGateway, ensureGateway } from './client.mjs';
import { CLIENT_CWD_KEY } from './meta.mjs';

const argv = process.argv.slice(2);
const opts = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') opts.json = true;
  else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
  else pos.push(a);
}
const [cmd, ...rest] = pos;

function usage() {
  const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  console.log(lines.filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
  process.exit(cmd ? 2 : 0);
}

async function stop(cfg) {
  if (!(await healthCheck(cfg))) { console.log('Gateway is not running'); return; }
  const res = await fetch(`${gatewayUrl(cfg)}/admin/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${readToken()}` } });
  console.log(res.ok ? 'Gateway asked to exit' : `Stop failed: HTTP ${res.status}`);
}

async function openBrowser(cfg, url) {
  await ensureGateway(cfg);
  const res = await fetch(`${gatewayUrl(cfg)}/admin/browser`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${readToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(url ? { url } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await res.json();
  console.log(res.ok ? `Opened a new window in the shared browser (${j.browser})` : `Failed: ${j.error}`);
  process.exitCode = res.ok ? 0 : 1;
}

function parseJsonArg(s) {
  if (!s) return {};
  const text = s.startsWith('@') ? fs.readFileSync(s.slice(1), 'utf8') : s;
  return JSON.parse(text);
}

function print(result, cfg) {
  if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
  for (const c of result.content || []) {
    if (c.type === 'text') console.log(c.text);
    else if (c.type === 'image') {
      ensureDirs(cfg);
      const ext = (c.mimeType || 'image/png').split('/')[1] || 'png';
      const file = path.join(cfg.gateway.outputDir, `cli-${Date.now()}.${ext}`);
      fs.writeFileSync(file, Buffer.from(c.data, 'base64'));
      console.log(`[image ${c.mimeType} saved to ${file}]`);
    } else console.log(JSON.stringify(c));
  }
}

async function main() {
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') return usage();
  const cfg = loadConfig();
  if (cmd === 'stop') return stop(cfg);
  if (cmd === 'browser') return openBrowser(cfg, rest[0]);
  const toolArgs = { [CLIENT_CWD_KEY]: opts.cwd ? path.resolve(opts.cwd) : process.cwd() };
  let name;
  switch (cmd) {
    case 'status': name = 'status'; break;
    case 'list': name = 'list'; if (rest[0]) toolArgs.server = rest[0]; if (opts.query) toolArgs.query = opts.query; break;
    case 'describe': name = 'describe'; [toolArgs.server, toolArgs.tool] = rest; break;
    case 'call':
      name = 'call';
      [toolArgs.server, toolArgs.tool] = rest;
      toolArgs.arguments = parseJsonArg(rest[2]);
      if (opts.cwd) toolArgs.cwd = path.resolve(opts.cwd);
      if (opts.timeout) toolArgs.timeout_sec = Number(opts.timeout);
      break;
    case 'resource': name = 'resource'; toolArgs.server = rest[0]; if (rest[1]) toolArgs.uri = rest[1]; if (opts.cwd) toolArgs.cwd = path.resolve(opts.cwd); break;
    case 'reset': name = 'reset'; toolArgs.server = rest[0]; break;
    default: return usage();
  }
  const client = await connectGateway(cfg, `gw-cli/cli/${opts.owner || 'cli'}`);
  try {
    const sec = Math.min(Number(opts.timeout) || cfg.gateway.defaultTimeoutSec, cfg.gateway.maxTimeoutSec);
    const result = await client.callTool({ name, arguments: toolArgs }, undefined, { timeout: (sec + 90) * 1000, resetTimeoutOnProgress: true });
    print(result, cfg);
    process.exitCode = result.isError ? 1 : 0;
  } finally {
    await client.close();
  }
}

main().catch(err => { console.error(`mcpx: ${err.message}`); process.exit(1); });
