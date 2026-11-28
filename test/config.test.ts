import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const loadConfig = (env: Record<string, string>) => JSON.parse(execFileSync(process.execPath, [
  '--import', 'tsx', '--input-type=module', '--eval',
  "const { config } = await import('./src/config.ts'); console.log(JSON.stringify({ gold: config.gold.pollMs, engine: config.engine.pollMs, fee: config.engine.feePct, confidence: config.engine.minConfidence, start: config.engine.startUsd }))",
], { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: 'utf8' }).trim());

test('zero or negative poll intervals fall back instead of creating tight loops', () => {
  assert.deepEqual(loadConfig({ GOLD_POLL_MS: '0', ENGINE_POLL_MS: '-1' }), { gold: 60_000, engine: 30_000, fee: 0.1, confidence: 0.5, start: 10_000 });
  assert.deepEqual(loadConfig({ GOLD_POLL_MS: '5000', ENGINE_POLL_MS: '10000' }), { gold: 5_000, engine: 10_000, fee: 0.1, confidence: 0.5, start: 10_000 });
});

test('negative risk parameters and out-of-range confidence fall back', () => {
  assert.deepEqual(loadConfig({ ENGINE_FEE_PCT: '-0.1', ENGINE_MIN_CONFIDENCE: '2', ENGINE_START_USD: '0' }), {
    gold: 60_000, engine: 30_000, fee: 0.1, confidence: 0.5, start: 10_000,
  });
});
