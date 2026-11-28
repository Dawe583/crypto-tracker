import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const loadConfig = (env: Record<string, string>) => JSON.parse(execFileSync(process.execPath, [
  '--import', 'tsx', '--input-type=module', '--eval',
  "const { config } = await import('./src/config.ts'); console.log(JSON.stringify({ gold: config.gold.pollMs, engine: config.engine.pollMs }))",
], { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: 'utf8' }).trim());

test('zero or negative poll intervals fall back instead of creating tight loops', () => {
  assert.deepEqual(loadConfig({ GOLD_POLL_MS: '0', ENGINE_POLL_MS: '-1' }), { gold: 60_000, engine: 30_000 });
  assert.deepEqual(loadConfig({ GOLD_POLL_MS: '5000', ENGINE_POLL_MS: '10000' }), { gold: 5_000, engine: 10_000 });
});
