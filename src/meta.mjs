// The fixed meta-tools and instructions the gateway exposes. The shim answers initialize / tools/list
// locally from this file, so it is the single source of truth.

const BASE = `Local MCP gateway: every MCP server on this machine is reached through it.
- list: no args lists all servers; with server lists that server's tools; with query searches tools across servers.
- describe(server, tool): full description and input schema of one tool. Describe a tool before its first call.
- call(server, tool, arguments): run a tool; arguments is that tool's own argument object.
- resource(server, uri?): list or read a server's resources.
- status: gateway, shared browser and backend instances. reset(server): restart this session's instance of a server.

Conventions:
- Each client session is one owner. Servers with scope "owner" get one instance per session (main agent and sub-agents of that session share it); servers with scope "shared" run one instance for the whole machine, called concurrently, and all sessions see the same backend state.
- Text results longer than the inline limit are written to a file; the reply contains the path and the beginning.
- If a write operation times out or its result is unclear, check the target state before retrying.
- A session's per-session instances (its browser window, selected device, …) are kept until the session ends; shared backends are stopped when idle. Both restart automatically on the next call.`;

const BROWSER = `- Browser servers attach to one shared browser (shared logins). Each session gets its own window, preselected for it; keep all your pages in that one window as tabs. Reuse the current tab (navigate) when the old page is no longer needed; for pages that must stay open side by side use new_page with background: true, which the gateway opens as a tab in your window and selects. Do not open other windows (isolated contexts open one; use them only when a separate login state is required). Switch between your tabs with select_page, never close, navigate or select other sessions' pages, and close the tabs you opened when done.`;

// gateway.instructions / instructionsFile replace the built-in text (e.g. to write it in another language
// or add machine-specific rules); server hints are appended either way.
export function buildInstructions(cfg) {
  const lines = [cfg.gateway.instructions || BASE];
  if (!cfg.gateway.instructions && Object.values(cfg.servers).some(d => d.browser)) lines.push(BROWSER);
  const hints = Object.entries(cfg.servers).filter(([, d]) => d.hint).map(([n, d]) => `- ${n}: ${d.hint}`);
  if (hints.length) lines.push('', 'Server notes:', ...hints);
  return lines.join('\n');
}

const str = description => ({ type: 'string', description });

// MCP tool annotations let clients (e.g. Codex with approvals off) run the read-only meta-tools without asking.
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

export const META_TOOLS = [
  {
    name: 'list',
    title: 'List servers and tools',
    annotations: READ_ONLY,
    description: 'List the servers behind the gateway; with server, list its tools (name and one-line summary); with query, search tools across servers by name and description.',
    inputSchema: {
      type: 'object',
      properties: {
        server: str('Server name.'),
        query: str('Case-insensitive keyword matched against tool names and descriptions.'),
      },
    },
  },
  {
    name: 'describe',
    title: 'Describe a tool',
    annotations: READ_ONLY,
    description: 'Return the full description and input JSON Schema of one backend tool.',
    inputSchema: {
      type: 'object',
      properties: { server: str('Server name.'), tool: str('Tool name.') },
      required: ['server', 'tool'],
    },
  },
  {
    name: 'call',
    title: 'Call a backend tool',
    // What a call does depends on the backend tool; describe shows that tool's own annotations.
    annotations: { readOnlyHint: false, openWorldHint: true },
    description: 'Call a backend tool and return its result unchanged (text, images, resources).',
    inputSchema: {
      type: 'object',
      properties: {
        server: str('Server name.'),
        tool: str('Tool name.'),
        arguments: { type: 'object', description: 'Arguments for the tool, following the schema returned by describe.', additionalProperties: true },
        cwd: str('Working directory (absolute path) for servers keyed by directory. Defaults to the session directory.'),
        timeout_sec: { type: 'number', description: 'Timeout for this call in seconds (gateway default and maximum apply).' },
      },
      required: ['server', 'tool'],
    },
  },
  {
    name: 'resource',
    title: 'List or read resources',
    annotations: READ_ONLY,
    description: 'Without uri, list the resources a server provides; with uri, read that resource.',
    inputSchema: {
      type: 'object',
      properties: { server: str('Server name.'), uri: str('Resource URI.'), cwd: str('Working directory, same rules as call.') },
      required: ['server'],
    },
  },
  {
    name: 'status',
    title: 'Gateway status',
    annotations: READ_ONLY,
    description: 'Gateway process, shared browser, backend instances (server, owner, idle time, pid) and recent errors.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'reset',
    title: 'Restart a backend',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Stop this session\'s instance of a server (for shared servers, the machine-wide instance); it restarts on the next call.',
    inputSchema: {
      type: 'object',
      properties: { server: str('Server name.') },
      required: ['server'],
    },
  },
];

// Session working directory the shim attaches to every call; intentionally not in the public schema.
export const CLIENT_CWD_KEY = '_client_cwd';
