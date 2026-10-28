// Minimal stdio MCP server used by the tests: report which process answered, or sleep (for timeout checks).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'echo', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'pid', description: 'Return the pid of this server process.', inputSchema: { type: 'object', properties: {} } },
    { name: 'sleep', description: 'Wait ms milliseconds, then return.', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'sleep') await new Promise(r => setTimeout(r, Number(req.params.arguments?.ms) || 0));
  return { content: [{ type: 'text', text: String(process.pid) }] };
});
await server.connect(new StdioServerTransport());
