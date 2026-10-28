# mcp-shared-gateway

[中文](README.zh-CN.md)

**One local MCP gateway for all your AI agents.** Every Claude Code / Codex / Cursor session and every sub-agent normally starts its own copy of every MCP server. With this gateway, each server runs once and is shared by everyone; idle servers are stopped automatically.

```
 Claude Code ──┐                                  ┌─ filesystem       shared: 1 process for everybody
 Codex ────────┼─ shim (tiny stdio) ── gateway ───┼─ memory           shared: 1 process for everybody
 sub-agents ───┘   one per session     localhost  └─ chrome-devtools  owner: 1 per session, own window
```

## Why

- **Memory.** N sessions × M servers = N×M processes. Launched with `npx`, each server is really a small process tree (npm wrapper + node + console host), so it adds up quickly.
- **Context.** Clients only see 6 small meta-tools (`list`, `describe`, `call`, `resource`, `status`, `reset`). The agent looks up tools when it needs them, so hundreds of tool schemas no longer sit in every context window.
- **One config.** Add or change a server in one file instead of in every client.

## Measured

Public servers `@modelcontextprotocol/server-filesystem`, `server-memory` and `server-sequential-thinking`, started with `npx -y`. Total working set of all processes involved, gateway mode including every shim and the gateway itself (`node bench/memory.mjs <sessions>`, Windows 11, Node 25):

| Sessions | Direct (each session starts its own) | Through the gateway | Saved |
|---|---|---|---|
| 5 | 75 processes, 3055 MB | 26 processes, 1138 MB | **63%** |
| 10 | 150 processes, 6001 MB | 36 processes, 1494 MB | **75%** |

Savings grow with the number of sessions and servers: direct costs grow with N×M, the gateway with N small shims + M servers.

## Quick start

Requires Node.js 22+.

```bash
git clone https://github.com/2836603852/mcp-shared-gateway.git
cd mcp-shared-gateway
pnpm install            # or npm install
cp config/servers.example.json config/servers.json   # then edit it
```

Mount the shim in each client as an ordinary stdio MCP server named `gateway`. The first call starts the gateway; you never start it by hand.

Claude Code:

```bash
claude mcp add --scope user gateway -- node /path/to/mcp-shared-gateway/src/shim.mjs
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.gateway]
command = "node"
args = ["/path/to/mcp-shared-gateway/src/shim.mjs"]
```

Anything that takes `mcpServers` JSON (Cursor, Claude Desktop, …):

```json
{ "mcpServers": { "gateway": { "command": "node", "args": ["/path/to/mcp-shared-gateway/src/shim.mjs"] } } }
```

## Configuration

`config/servers.json` (see [`servers.example.json`](config/servers.example.json)):

| Key | Meaning |
|---|---|
| `gateway.port` / `host` | Where the gateway listens (default `127.0.0.1:18760`). |
| `gateway.idleMinutes` | Stop a backend after this many idle minutes (default 15). |
| `gateway.proxy` / `noProxy` | Proxy for backends. Set it here: on Windows the gateway does not inherit the client's environment. |
| `gateway.defaultTimeoutSec` / `maxTimeoutSec` / `inlineTextLimit` | Call timeouts (120 / 900 s) and the size above which long text results are written to a file (40 000 chars). |
| `gateway.outputDir` / `workDir` | Where long results are written and the default working directory of backends (default `outputs/` and `work/` in the state directory). Relative paths are relative to the config file. |
| `gateway.instructions` / `instructionsFile` | Replace the built-in instructions shown to agents (a string, an array of lines, or a file relative to the config). Server `hint`s are still appended. |
| `gateway.dropEnv` | Extra environment variable names that backends must not inherit (e.g. `NODE_EXTRA_CA_CERTS`). Variables starting with `CLAUDE`, `CODEX`, `ZCODE` and `CURSOR_TRACE` are always dropped. |
| `gateway.clientAliases` | `{ "<regex>": "<alias>" }`, first match wins (case-insensitive): turns client names such as `codex-mcp-client` into the value of `${CLIENT}`. |
| `browser` | Optional shared Chrome (`executable`, `userDataDir`, `port`, `args`) for servers with `"browser": true`. |
| `servers.<name>.scope` | `"shared"`: one instance for the machine, calls run concurrently. `"owner"`: one instance per session, calls run in order. |
| `servers.<name>.command` / `args` / `env` | A stdio server. |
| `servers.<name>.clientEnv` | Env values filled in per instance: `${CLIENT}` (the calling client, see `clientAliases`) and `${CWD}`. Meant for `owner` servers; a `shared` instance keeps the values of whoever started it. |
| `servers.<name>.url` / `headers` | A remote Streamable HTTP server. |
| `servers.<name>.cwd` | `"key"`: one instance per working directory; `"required"`: callers must pass `cwd`. `cwdArgs` may use `${CWD}`. |
| `servers.<name>.description` / `hint` | Shown to the agent in `list` and in the gateway instructions. |
| `servers.<name>.browser` | Attach to the shared Chrome; each session gets its own window, selected for it (for `chrome-devtools-mcp`; from 1.12 on pass `--no-page-id-routing`, otherwise every page tool requires a `pageId`). |
| `servers.<name>.version` | Shown in `list`. The tool list is cached per server; change `version` when you upgrade a backend so the cache is refreshed. |

`${NAME}` anywhere in the config is filled from `.local/secrets.json`, then from the environment, so keys stay out of the config.

**Which scope?** Use `shared` for stateless servers (docs, search, filesystem, SSH, databases, remote APIs) — that is where the memory goes away. Use `owner` when a server keeps per-user state such as a selected browser page, a connected device or an open project.

Environment overrides: `MCP_GATEWAY_CONFIG` (config file), `MCP_GATEWAY_STATE` (state directory, default `.local/`), `GW_IDLE_MINUTES`.

## CLI

```bash
node src/cli.mjs status                 # gateway, instances, recent errors
node src/cli.mjs list [server] [--query q]
node src/cli.mjs describe <server> <tool>
node src/cli.mjs call <server> <tool> '{"arg":1}' [--owner name]
node src/cli.mjs reset <server>
node src/cli.mjs browser [url]          # open a window in the shared Chrome to log in by hand
node src/cli.mjs stop                   # restart picks up config changes on the next call
```

On Windows, `mcpx.cmd` is a shortcut for `node src/cli.mjs`.

## Private deployment

Keep your machine-specific setup (config, instructions in your language, your own backends) in a separate private repository and use this one as a dependency, pinned to a commit:

```bash
pnpm add github:2836603852/mcp-shared-gateway#<commit>
```

In that repository, add thin entry files that point the gateway at your config and state, then load the real one. The paths are fixed when `common.mjs` is loaded, so set them first and use a dynamic `import()`:

```js
// src/shim.mjs (same pattern for cli.mjs, launch.mjs and gateway.mjs)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.MCP_GATEWAY_CONFIG ||= path.join(HERE, 'config', 'servers.json');
process.env.MCP_GATEWAY_STATE ||= path.join(HERE, '.local');
await import('mcp-shared-gateway/src/shim.mjs');
```

Clients mount your `src/shim.mjs`. The gateway itself is started from the package; it receives the config and state paths as arguments, so settings belong in `servers.json`, not in environment variables of the client.

## How it works

- **shim** (`src/shim.mjs`): the stdio server each client mounts. It has no MCP SDK dependency, answers `initialize` and `tools/list` itself, and forwards tool calls to the gateway over localhost HTTP. If the gateway is not running, the shim starts it. On Windows it uses WMI, so the gateway is outside the client's process tree and outlives it.
- **gateway** (`src/gateway.mjs`): starts backends on first use. An instance is identified by server name + owner (or `*` when shared) + directory (when keyed by `cwd`). It caches tool lists, so `list` and `describe` don't start anything, and it stops idle backends.
- **Sessions end cleanly.** When a client exits, its shim tells the gateway, which stops that session's `owner` instances (and closes its browser window) right away. Idle instances are still stopped after `idleMinutes`.
- **Stuck backends recover.** A timed-out call usually keeps running in the backend, and calls on an `owner` instance run in order, so one stuck call makes the next ones time out too. After two timeouts in a row the gateway replaces that session's instance. The error text tells the agent what happened.
- **Read-only meta-tools are marked as such** (MCP tool annotations), so clients with approvals turned off, such as Codex, can run `list`, `describe`, `status` and `resource` without asking. `describe` also shows the backend tool's own annotations.
- Requests need a random Bearer token stored in `.local/token`, and the gateway only listens on `127.0.0.1`.

## Limits

- Used daily on Windows 11. CI runs the tests on Windows, Linux and macOS, but day-to-day use on Linux and macOS is less tested.
- All sessions using a shared server see the same backend state. Switch such servers to `owner` if that matters.
- If a client is killed without closing the shim's stdin, its `owner` instances are only stopped after the idle timeout.
- Shared instances are never restarted automatically after timeouts (other sessions may be using them); use `reset`.

## Development

```bash
pnpm test                      # starts a gateway on a free port with a fixture server
node bench/memory.mjs 5        # memory benchmark (downloads the public servers via npx)
node tests/manual/long-call.mjs # a call longer than 300 s through the shim (takes ~5 min)
# against the gateway of your config (they restart it / open browser windows):
node tests/manual/lifecycle.mjs          # gateway outlives the client; shims reconnect after a restart
node tests/manual/browser-sessions.mjs   # two sessions, two windows in the shared browser
```

Issues and PRs are welcome. Please keep the shim dependency-free and add a test for behavior changes.

## License

MIT
