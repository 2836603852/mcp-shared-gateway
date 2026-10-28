# mcp-shared-gateway

[English](README.md)

**让本机所有 AI agent 共用一套 MCP 的网关。** 平常每开一个 Claude Code / Codex / Cursor 会话、每起一个子代理，都会把配置里的每个 MCP 服务各启动一份。接上这个网关后，每个服务只跑一份，所有会话共用；闲置的服务会自动关掉。

```
 Claude Code ──┐                                  ┌─ filesystem       共享：全机 1 个进程
 Codex ────────┼─ shim（极小 stdio）── 网关 ───────┼─ memory           共享：全机 1 个进程
 子代理 ───────┘   每会话一个          仅本机       └─ chrome-devtools  按会话：每会话 1 个，各用一个窗口
```

## 为什么要用

- **省内存。** N 个会话 × M 个服务，直连就是 N×M 份。用 `npx` 启动时，每份其实是一小串进程（npm 包装进程 + node + 控制台宿主），加起来很快就上 GB。
- **省上下文。** 客户端只看到 6 个元工具：`list`、`describe`、`call`、`resource`、`status`、`reset`。agent 需要哪个工具时再查，不用把几百个工具的说明塞进每个会话的上下文。
- **一处配置。** 增删服务只改一个文件，不用每个客户端各配一遍。

## 实测

测试用的是三个公开服务：`@modelcontextprotocol/server-filesystem`、`server-memory`、`server-sequential-thinking`，都用 `npx -y` 启动。统计的是所有相关进程的内存（working set）总和；走网关那一列已经把每个 shim 和网关本身都算进去了。命令是 `node bench/memory.mjs <会话数>`，环境为 Windows 11、Node 25。

| 会话数 | 直连（每个会话各起一套） | 走网关 | 节省 |
|---|---|---|---|
| 5 | 75 个进程，3055 MB | 26 个进程，1138 MB | **63%** |
| 10 | 150 个进程，6001 MB | 36 个进程，1494 MB | **75%** |

会话和服务越多，省得越多。直连的开销随 N×M 增长；走网关只随 N 个小 shim 加 M 个服务增长。

## 快速开始

需要 Node.js 22 及以上。

```bash
git clone https://github.com/2836603852/mcp-shared-gateway.git
cd mcp-shared-gateway
pnpm install            # 或 npm install
cp config/servers.example.json config/servers.json   # 然后按需修改
```

在每个客户端里，把 shim 当作一个普通的 stdio MCP 挂上，名字叫 `gateway`。第一次调用时网关会自动拉起，不需要手动启动。

Claude Code：

```bash
claude mcp add --scope user gateway -- node /path/to/mcp-shared-gateway/src/shim.mjs
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.gateway]
command = "node"
args = ["/path/to/mcp-shared-gateway/src/shim.mjs"]
```

其他用 `mcpServers` JSON 配置的客户端（Cursor、Claude Desktop 等）：

```json
{ "mcpServers": { "gateway": { "command": "node", "args": ["/path/to/mcp-shared-gateway/src/shim.mjs"] } } }
```

## 配置

配置文件是 `config/servers.json`，可以参考 [`servers.example.json`](config/servers.example.json)。

| 字段 | 含义 |
|---|---|
| `gateway.port` / `host` | 网关监听地址，默认 `127.0.0.1:18760`。 |
| `gateway.idleMinutes` | 后端闲置多少分钟后关闭，默认 15。 |
| `gateway.proxy` / `noProxy` | 后端用的代理。要写在这里：Windows 上网关不会继承客户端的环境变量。 |
| `gateway.defaultTimeoutSec` / `maxTimeoutSec` / `inlineTextLimit` | 调用的默认超时 120 秒、最长 900 秒；文本结果超过 40000 字符就写到文件里。 |
| `gateway.outputDir` / `workDir` | 长结果写到哪里、后端默认的工作目录（默认是状态目录下的 `outputs/` 和 `work/`）。相对路径相对于配置文件所在目录。 |
| `gateway.instructions` / `instructionsFile` | 替换显示给 agent 的内置说明：可以是字符串、字符串数组（每项一行），或相对配置文件的文件路径。各服务的 `hint` 仍会追加在后面。 |
| `gateway.dropEnv` | 额外列出不让后端继承的环境变量名（例如 `NODE_EXTRA_CA_CERTS`）。以 `CLAUDE`、`CODEX`、`ZCODE`、`CURSOR_TRACE` 开头的变量总是会去掉。 |
| `gateway.clientAliases` | `{ "<正则>": "<别名>" }`，不区分大小写，第一个匹配的生效：把 `codex-mcp-client` 这类客户端名换成 `${CLIENT}` 的取值。 |
| `browser` | 可选。共享 Chrome 的设置（`executable`、`userDataDir`、`port`、`args`），给 `"browser": true` 的服务用。 |
| `servers.<名>.scope` | `"shared"`：全机一个实例，调用并发执行。`"owner"`：每个会话一个实例，调用按顺序执行。 |
| `servers.<名>.command` / `args` / `env` | 本地 stdio 服务。 |
| `servers.<名>.clientEnv` | 按实例填值的环境变量，可以用 `${CLIENT}`（调用方客户端，见 `clientAliases`）和 `${CWD}`。适合 `owner` 服务；`shared` 实例保留第一个拉起它的客户端的值。 |
| `servers.<名>.url` / `headers` | 远程 Streamable HTTP 服务。 |
| `servers.<名>.cwd` | `"key"`：每个工作目录一个实例；`"required"`：调用时必须传 `cwd`。`cwdArgs` 里可以用 `${CWD}`。 |
| `servers.<名>.description` / `hint` | 会显示给 agent，出现在 `list` 结果和网关说明里。 |
| `servers.<名>.browser` | 连接共享 Chrome，每个会话一个独立窗口（配合 `chrome-devtools-mcp` 使用）。 |
| `servers.<名>.version` | 显示在 `list` 里。工具清单按服务缓存；升级后端时改一下 `version`，缓存就会刷新。 |

配置里任何位置都可以写 `${NAME}`。它先从 `.local/secrets.json` 取值，取不到再读环境变量，这样密钥不用写进配置文件。

**scope 怎么选：** 不保存状态的服务（文档、搜索、文件系统、SSH、数据库、远程 API）用 `shared`，省内存主要靠这一类。会保存每个使用者自己状态的服务（比如当前选中的浏览器页面、已连接的设备、打开的项目）用 `owner`。

可以用环境变量覆盖的设置：`MCP_GATEWAY_CONFIG`（配置文件路径）、`MCP_GATEWAY_STATE`（状态目录，默认 `.local/`）、`GW_IDLE_MINUTES`（闲置分钟数）。

## 命令行

```bash
node src/cli.mjs status                 # 网关状态、各实例、最近的错误
node src/cli.mjs list [server] [--query q]
node src/cli.mjs describe <server> <tool>
node src/cli.mjs call <server> <tool> '{"arg":1}' [--owner name]
node src/cli.mjs reset <server>
node src/cli.mjs browser [url]          # 在共享 Chrome 里开个窗口，用来手动登录网站
node src/cli.mjs stop                   # 停掉网关；下次调用时自动重启并读取新配置
```

Windows 上可以用 `mcpx.cmd` 代替 `node src/cli.mjs`。

## 私有部署

本机专用的内容（配置、用自己语言写的说明、自己的后端）放在单独的私有仓库里，把本仓库当依赖引入，并钉到某个提交：

```bash
pnpm add github:2836603852/mcp-shared-gateway#<commit>
```

在私有仓库里加几个很薄的入口文件，先指定配置和状态目录，再加载真正的入口。`common.mjs` 加载时就会确定路径，所以要先设置环境变量，再用动态 `import()`：

```js
// src/shim.mjs（cli.mjs、launch.mjs、gateway.mjs 写法相同）
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.MCP_GATEWAY_CONFIG ||= path.join(HERE, 'config', 'servers.json');
process.env.MCP_GATEWAY_STATE ||= path.join(HERE, '.local');
await import('mcp-shared-gateway/src/shim.mjs');
```

客户端挂的是私有仓库里的 `src/shim.mjs`。网关本身从依赖包里启动，配置和状态路径通过参数传给它，所以设置要写在 `servers.json` 里，不要依赖客户端的环境变量。

## 原理

- **shim**（`src/shim.mjs`）：每个客户端挂的就是它。它不依赖 MCP SDK，`initialize` 和 `tools/list` 自己直接应答，工具调用通过本机 HTTP 转发给网关。网关没在运行时，shim 会把它拉起来。在 Windows 上是用 WMI 拉起的，所以网关不在客户端的进程树里，客户端退出也不会带走它。
- **网关**（`src/gateway.mjs`）：后端在第一次被用到时才启动。一个实例由三部分确定：服务名、owner（共享服务用 `*`）、工作目录（只有按 `cwd` 区分的服务才算）。网关会缓存各服务的工具清单，所以 `list` 和 `describe` 不会启动后端；后端闲置超时后由网关关掉。
- **会话结束即回收。** 客户端退出时，shim 会通知网关，网关立刻停掉这个会话的 `owner` 实例（并关掉它的浏览器窗口）。闲置的实例仍按 `idleMinutes` 回收。
- **后端卡住能自动恢复。** 调用超时后，后端通常还在执行它；`owner` 实例上的调用又是按顺序执行的，所以一次卡住会让后面的调用跟着超时。连续超时两次后，网关会换掉这个会话的实例，并在报错里告诉 agent 发生了什么。
- **只读元工具带有标注**（MCP tool annotations），关闭了审批的客户端（比如 Codex）调用 `list`、`describe`、`status`、`resource` 时不会再要求确认。`describe` 也会显示后端工具自己的标注。
- 网关只监听 `127.0.0.1`，每个请求都要带 Bearer 令牌。令牌是随机生成的，存在 `.local/token`。

## 限制

- 作者每天在 Windows 11 上使用。CI 会在 Windows、Linux、macOS 上跑测试，但 Linux 和 macOS 的日常使用验证得少一些。
- 共享服务的后端状态对所有会话是同一份。如果这会造成干扰，把这个服务改成 `owner`。
- 客户端被强制结束、没来得及关闭 shim 的 stdin 时，它的 `owner` 实例要等闲置超时才会被关掉。
- 共享实例超时后不会自动重启（其他会话可能正在用），需要时用 `reset`。

## 开发

```bash
pnpm test                      # 在空闲端口起一个网关，用测试桩服务验证
node bench/memory.mjs 5        # 内存基准测试（会用 npx 下载公开服务）
node tests/manual/long-call.mjs # 经 shim 跑一个超过 300 秒的调用（约 5 分钟）
# 下面两个针对你配置里的网关运行（会重启网关 / 打开浏览器窗口）：
node tests/manual/lifecycle.mjs          # 客户端退出后网关仍在；网关重启后 shim 自动重连
node tests/manual/browser-sessions.mjs   # 两个会话在共享浏览器里各用一个窗口
```

欢迎提 Issue 和 PR。请保持 shim 不引入依赖；改动行为时请补上测试。

## 许可证

MIT
