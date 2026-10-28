// Detect the gateway and start it on demand. Kept free of the MCP SDK so the shim stays small.
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { ROOT, LOG_DIR, CONFIG_FILE, STATE_DIR, cleanEnv, gatewayUrl, healthCheck, log, sleep } from './common.mjs';

const LAUNCHER = path.join(ROOT, 'src', 'launch.mjs');

// Windows: create the bootstrap through WMI. Its parent is the WMI service, so when a client exits and
// kills its whole tree (taskkill /T, kill-on-close job objects) the gateway survives.
function launchViaWmi() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const cmdLine = `"${process.execPath}" "${LAUNCHER}" "${CONFIG_FILE}" "${STATE_DIR}"`.replace(/'/g, "''");
  const script = [
    "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdLine}'; CurrentDirectory = '${ROOT.replace(/'/g, "''")}'; ProcessStartupInformation = $si }`,
    "Write-Output \"$($r.ReturnValue) $($r.ProcessId)\"",
  ].join('; ');
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 }, (err, stdout) => {
      const [code, pid] = String(stdout || '').trim().split(/\s+/);
      resolve(!err && code === '0' ? Number(pid) : null);
    });
  });
}

// Everywhere else (or if WMI fails): a detached child in its own process group.
function launchDetached(cfg) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'gateway.mjs')], {
    cwd: ROOT,
    env: cleanEnv(cfg.gateway, cfg.gateway.proxy ? { NODE_USE_ENV_PROXY: '1' } : {}),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function launchGateway(cfg) {
  const pid = await launchViaWmi();
  if (pid) {
    log('gateway.launch', { by: process.pid, via: 'wmi', bootstrap: pid });
    return;
  }
  log('gateway.launch', { by: process.pid, via: 'detached', child: launchDetached(cfg) });
}

let ensuring = null;

// Concurrent checks/launches within one process collapse into one.
export function ensureGateway(cfg, waitMs = 30_000) {
  if (!ensuring) {
    ensuring = (async () => {
      if (await healthCheck(cfg)) return;
      await launchGateway(cfg);
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await sleep(300);
        if (await healthCheck(cfg)) return;
      }
      throw new Error(`Gateway ${gatewayUrl(cfg)} not ready after ${waitMs / 1000}s; see ${path.join(LOG_DIR, 'gateway.log')}`);
    })().finally(() => { ensuring = null; });
  }
  return ensuring;
}
