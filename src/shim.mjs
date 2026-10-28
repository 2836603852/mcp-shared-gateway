// The stdio MCP server each AI client mounts. Deliberately tiny and free of the MCP SDK: it answers
// initialize / tools/list locally and forwards tools/call to the gateway over plain HTTP, so every
// extra session costs one small Node process instead of a full set of backend servers.
import crypto from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline';
import { VERSION, loadConfig, gatewayUrl, readToken } from './common.mjs';
import { ensureGateway } from './launcher.mjs';
import { META_TOOLS, buildInstructions, CLIENT_CWD_KEY } from './meta.mjs';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const cfg = loadConfig();
const SHIM_ID = `${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
// owner: unique per shim process, i.e. per client session. Sub-agents of the same session share it.
let owner = `gw-shim/unknown/${SHIM_ID}`;

const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const errorText = text => ({ content: [{ type: 'text', text }], isError: true });

// node:http instead of fetch: fetch gives up after 300 s without response headers, and the gateway
// answers only when the call is done, so long calls (up to maxTimeoutSec) would fail.
function post(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readToken()}`, 'content-type': 'application/json', 'content-length': data.length },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${text}`));
        try { resolve(JSON.parse(text)); } catch (err) { reject(err); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from the gateway within ${timeoutMs / 1000}s`)));
    req.on('error', reject);
    req.end(data);
  });
}

async function forward(name, args) {
  const sec = Math.min(Number(args.timeout_sec) || cfg.gateway.defaultTimeoutSec, cfg.gateway.maxTimeoutSec);
  for (let attempt = 0; ; attempt++) {
    try {
      await ensureGateway(cfg);
      // 90 extra seconds for backend cold start and browser launch.
      return await post(`${gatewayUrl(cfg)}/rpc`, { owner, name, arguments: args }, (sec + 90) * 1000);
    } catch (err) {
      // Retry once only when the request certainly never reached the gateway (it was restarting).
      const code = err?.cause?.code || err?.code;
      if (attempt === 0 && code === 'ECONNREFUSED') continue;
      return errorText(`Gateway call failed: ${err.message}`);
    }
  }
}

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled, …) need no reply
  switch (method) {
    case 'initialize': {
      const client = (params.clientInfo?.name || 'unknown').replace(/[\/|\s]+/g, '_');
      owner = `gw-shim/${client}/${SHIM_ID}`;
      const asked = params.protocolVersion;
      return send({
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'gateway', version: VERSION },
          instructions: buildInstructions(cfg),
        },
      });
    }
    case 'ping':
      return send({ id, result: {} });
    case 'tools/list':
      return send({ id, result: { tools: META_TOOLS } });
    case 'tools/call': {
      const args = { ...(params.arguments || {}) };
      if (!args[CLIENT_CWD_KEY]) args[CLIENT_CWD_KEY] = process.cwd();
      return send({ id, result: await forward(params.name, args) });
    }
    default:
      return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  handle(msg).catch(err => msg.id !== undefined && send({ id: msg.id, error: { code: -32603, message: err.message } }));
});
// The client is gone: let the gateway stop this session's instances right away (best effort, 1 s at most).
rl.on('close', () => {
  post(`${gatewayUrl(cfg)}/session/end`, { owner }, 1000).catch(() => {}).finally(() => process.exit(0));
});
// Warm up without blocking initialize; the gateway is usually ready before the first call.
ensureGateway(cfg).catch(err => process.stderr.write(`[mcp-shared-gateway] ${err.message}\n`));
