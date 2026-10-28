// Used by the CLI: an authenticated MCP connection to the gateway.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { VERSION, gatewayUrl, readToken, sleep } from './common.mjs';
import { ensureGateway } from './launcher.mjs';

export { ensureGateway };

export async function connectGateway(cfg, clientName) {
  await ensureGateway(cfg);
  let token = readToken();
  for (let i = 0; !token && i < 20; i++) { await sleep(100); token = readToken(); }
  if (!token) throw new Error('Gateway token not found');
  const client = new Client({ name: clientName, version: VERSION }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${gatewayUrl(cfg)}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}
