import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const loadConfig = (env: Record<string, string>) => JSON.parse(execFileSync(process.execPath, [
  '--import', 'tsx', '--input-type=module', '--eval',
  "const { config } = await import('./src/config.ts'); console.log(JSON.stringify({ gold: config.gold.pollMs, engine: config.engine.pollMs, fee: config.engine.feePct, confidence: config.engine.minConfidence, start: config.engine.startUsd, port: config.api.port, maxOpen: config.engine.maxOpenPositions, symbols: config.engine.symbols }))",
], { cwd: process.cwd(), env: {
    ...process.env,
    GOLD_POLL_MS: '60000', ENGINE_POLL_MS: '30000', ENGINE_FEE_PCT: '0.1', ENGINE_MIN_CONFIDENCE: '0.5', ENGINE_START_USD: '10000', API_PORT: '8787',
    ...env,
  }, encoding: 'utf8' }).trim());

test('zero or negative poll intervals fall back instead of creating tight loops', () => {
  assert.deepEqual(loadConfig({ GOLD_POLL_MS: '0', ENGINE_POLL_MS: '-1' }), { gold: 60_000, engine: 30_000, fee: 0.1, confidence: 0.5, start: 10_000, port: 8787, maxOpen: 8, symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT'] });
  assert.deepEqual(loadConfig({ GOLD_POLL_MS: '5000', ENGINE_POLL_MS: '10000' }), { gold: 5_000, engine: 10_000, fee: 0.1, confidence: 0.5, start: 10_000, port: 8787, maxOpen: 8, symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT'] });
});

test('negative risk parameters and out-of-range confidence fall back', () => {
  assert.deepEqual(loadConfig({ ENGINE_FEE_PCT: '-0.1', ENGINE_MIN_CONFIDENCE: '2', ENGINE_START_USD: '0' }), {
    gold: 60_000, engine: 30_000, fee: 0.1, confidence: 0.5, start: 10_000, port: 8787, maxOpen: 8, symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT'],
  });
});

test('invalid API ports fall back to the documented port', () => {
  assert.equal(loadConfig({ API_PORT: '8787.5' }).port, 8787);
  assert.equal(loadConfig({ API_PORT: '65536' }).port, 8787);
  assert.equal(loadConfig({ API_PORT: '0' }).port, 0);
});

test('position counts are integers and malformed engine symbols fail closed', () => {
  const valid = loadConfig({ ENGINE_MAX_OPEN_POSITIONS: '3', ENGINE_SYMBOLS: 'btcusdt,ETHUSDT,BTCUSDT' });
  assert.equal(valid.maxOpen, 3);
  assert.deepEqual(valid.symbols, ['BTCUSDT', 'ETHUSDT']);
  const invalid = loadConfig({ ENGINE_MAX_OPEN_POSITIONS: '1.5', ENGINE_SYMBOLS: 'BTC/USD,,bad-symbol' });
  assert.equal(invalid.maxOpen, 8);
  assert.deepEqual(invalid.symbols, []);
});
