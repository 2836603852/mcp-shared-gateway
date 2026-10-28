// The example config must stay valid (users start by copying it), and gateway paths/instructions resolve as documented.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('servers.example.json is valid and every server has a scope and a transport', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'servers.example.json'), 'utf8'));
  for (const [name, def] of Object.entries(cfg.servers)) {
    assert.ok(['shared', 'owner'].includes(def.scope), `${name}: scope`);
    assert.ok(def.command || def.url, `${name}: command or url`);
  }
});

// common.mjs fixes its paths at import time, so each case loads it in a fresh process.
function load(config, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-shared-gateway-config-'));
  try {
    fs.writeFileSync(path.join(dir, 'servers.json'), JSON.stringify(config));
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    }
    const script = `const c = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'common.mjs')).href)});
const m = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'meta.mjs')).href)});
const cfg = c.loadConfig();
console.log(JSON.stringify({ gateway: cfg.gateway, servers: cfg.servers, instructions: m.buildInstructions(cfg) }));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, MCP_GATEWAY_CONFIG: path.join(dir, 'servers.json'), MCP_GATEWAY_STATE: path.join(dir, 'state'), CWD: 'env-cwd', GW_TEST_SECRET: 's3' },
      encoding: 'utf8',
    });
    return { dir, ...JSON.parse(out) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('defaults: outputs and work dir under the state dir, built-in instructions plus hints', () => {
  const r = load({ servers: { a: { scope: 'shared', command: 'x', hint: 'note for a' } } });
  assert.equal(r.gateway.outputDir, path.join(r.dir, 'state', 'outputs'));
  assert.equal(r.gateway.workDir, path.join(r.dir, 'state', 'work'));
  assert.match(r.instructions, /^Local MCP gateway/);
  assert.match(r.instructions, /- a: note for a$/);
});

test('outputDir/workDir relative to the config file; instructionsFile replaces the built-in text', () => {
  const r = load({
    gateway: { outputDir: '../tmp/out', workDir: 'work', instructionsFile: 'rules.md' },
    browser: { port: 1 },
    servers: { b: { scope: 'owner', command: 'x', browser: true, hint: 'note for b' } },
  }, { 'rules.md': '本机规则\n第二行\n' });
  assert.equal(r.gateway.outputDir, path.resolve(r.dir, '..', 'tmp', 'out'));
  assert.equal(r.gateway.workDir, path.join(r.dir, 'work'));
  assert.equal(r.instructions, '本机规则\n第二行\n\nServer notes:\n- b: note for b');
});

test('instructions as an array of lines; ${CWD}/${CLIENT} are left for the gateway, other names are substituted', () => {
  const r = load({
    gateway: { instructions: ['line 1', 'line 2'] },
    servers: { c: { scope: 'shared', command: 'x', args: ['${CWD}', '${GW_TEST_SECRET}'], clientEnv: { K: '${CLIENT}' } } },
  });
  assert.equal(r.instructions, 'line 1\nline 2');
  assert.deepEqual(r.servers.c.args, ['${CWD}', 's3']);
  assert.equal(r.servers.c.clientEnv.K, '${CLIENT}');
});

test('${NAME} comes from state/secrets.json before the environment; unknown names stay as they are', () => {
  const r = load({
    servers: { d: { scope: 'shared', url: 'http://x', headers: { A: '${GW_TEST_SECRET}', B: '${FROM_FILE}', C: '${NOT_SET_ANYWHERE}' } } },
  }, { 'state/secrets.json': JSON.stringify({ GW_TEST_SECRET: 'from-file', FROM_FILE: 'f' }) });
  assert.deepEqual(r.servers.d.headers, { A: 'from-file', B: 'f', C: '${NOT_SET_ANYWHERE}' });
});
