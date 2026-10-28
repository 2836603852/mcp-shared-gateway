// The example config must stay valid: users start by copying it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('servers.example.json is valid and every server has a scope and a transport', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'servers.example.json'), 'utf8'));
  for (const [name, def] of Object.entries(cfg.servers)) {
    assert.ok(['shared', 'owner'].includes(def.scope), `${name}: scope`);
    assert.ok(def.command || def.url, `${name}: command or url`);
  }
});
