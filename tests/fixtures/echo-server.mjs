// Minimal stdio MCP server used by the tests: report which process answered, sleep (for timeout checks),
// read an env var, or return a long text.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'echo', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'pid', description: 'Return the pid of this server process.', inputSchema: { type: 'object', properties: {} } },
    { name: 'sleep', description: 'Wait ms milliseconds, then return.', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
    { name: 'env', description: 'Return an environment variable (empty if unset).', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
    { name: 'big', description: 'Return chars characters of text.', inputSchema: { type: 'object', properties: { chars: { type: 'number' } } } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async req => {
  const args = req.params.arguments || {};
  if (req.params.name === 'sleep') await new Promise(r => setTimeout(r, Number(args.ms) || 0));
  if (req.params.name === 'env') return { content: [{ type: 'text', text: process.env[args.name] ?? '' }] };
  if (req.params.name === 'big') return { content: [{ type: 'text', text: 'x'.repeat(Number(args.chars) || 0) }] };
  return { content: [{ type: 'text', text: String(process.pid) }] };
});
await server.connect(new StdioServerTransport());
