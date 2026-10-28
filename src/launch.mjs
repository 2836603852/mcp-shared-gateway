// Bootstrap used on Windows: started through WMI (Win32_Process.Create), so it lives outside every AI
// client's process tree and job object. WMI does not pass the caller's env, so the config and state paths
// arrive as arguments. It starts the real gateway with a clean env and exits.
import path from 'node:path';
import { spawn } from 'node:child_process';

const [config, state] = process.argv.slice(2);
if (config) process.env.MCP_GATEWAY_CONFIG = config;
if (state) process.env.MCP_GATEWAY_STATE = state;
const { ROOT, loadConfig, cleanEnv, log } = await import('./common.mjs');

const cfg = loadConfig();
const child = spawn(process.execPath, [path.join(ROOT, 'src', 'gateway.mjs')], {
  cwd: ROOT,
  env: cleanEnv(cfg.gateway, cfg.gateway.proxy ? { NODE_USE_ENV_PROXY: '1' } : {}),
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();
log('gateway.bootstrap', { bootstrap: process.pid, gateway: child.pid });
process.exit(0);
