// Minimal stdio MCP server used by the tests: report which process answered, sleep (for timeout checks),
// read an env var, return a long text, show its argv, or start a child process (for process-tree cleanup).
import { spawn } from 'node:child_process';
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
    { name: 'argv', description: 'Return the extra command-line arguments as JSON.', inputSchema: { type: 'object', properties: {} } },
    { name: 'spawn_child', description: 'Start a long-running child process and return its pid.', inputSchema: { type: 'object', properties: {} } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async req => {
  const args = req.params.arguments || {};
  if (req.params.name === 'sleep') await new Promise(r => setTimeout(r, Number(args.ms) || 0));
  if (req.params.name === 'env') return { content: [{ type: 'text', text: process.env[args.name] ?? '' }] };
  if (req.params.name === 'big') return { content: [{ type: 'text', text: 'x'.repeat(Number(args.chars) || 0) }] };
  if (req.params.name === 'argv') return { content: [{ type: 'text', text: JSON.stringify(process.argv.slice(2)) }] };
  if (req.params.name === 'spawn_child') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore', windowsHide: true });
    return { content: [{ type: 'text', text: String(child.pid) }] };
  }
  return { content: [{ type: 'text', text: String(process.pid) }] };
});
await server.connect(new StdioServerTransport());
