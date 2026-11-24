import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'crypto-tracker-signals-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(new URL('../src', import.meta.url), join(root, 'src'), { recursive: true });
  copyFileSync(new URL('../package.json', import.meta.url), join(root, 'package.json'));
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'junction');
  mkdirSync(join(root, 'data'));
  return root;
}

function run(root: string, script: string) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { once } from 'node:events';
    import * as store from './src/store.ts';
    const { startApi } = await import('./src/api.ts');
    const signal = (i, kind = 'whale_buy') => ({
      kind, chain: 'base', token: { address: '0x1', symbol: 'TOKEN-' + i },
      marketCapUsd: null, liquidityUsd: 100, contractVerified: null,
      links: { explorerToken: 'https://basescan.org/token/0x1' }, createdAt: new Date().toISOString(),
    });
    const request = async (path) => {
      const server = startApi();
      await once(server, 'listening');
      try {
        const response = await fetch('http://127.0.0.1:' + server.address().port + path);
        assert.equal(response.status, 200);
        return await response.json();
      } finally {
        server.close();
      }
    };
    ${script}
  `], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, LOG_LEVEL: 'silent', API_ENABLED: 'true', API_HOST: '127.0.0.1', API_PORT: '0', API_TOKEN: '' },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

test('restores only the newest 200 signals and serves the same history via HTTP after restart', (t) => {
  const root = fixture(t);
  run(root, `
    store.initSignalHistory();
    for (let i = 0; i < 203; ++i) store.recordSignal(signal(i));
    store.recordSignal(signal(203, 'new_pool'));
    assert.equal((await request('/api/whales?limit=200')).count, 199);
  `);
  run(root, `
    store.initSignalHistory();
    const whales = await request('/api/whales?limit=200');
    assert.equal(whales.count, 199);
    assert.equal(whales.signals[0].token.symbol, 'TOKEN-202');
    assert.equal(whales.signals.at(-1).token.symbol, 'TOKEN-4');
    const pools = await request('/api/pools');
    assert.equal(pools.count, 1);
    assert.equal(pools.signals[0].token.symbol, 'TOKEN-203');
  `);
  assert.equal(JSON.parse(readFileSync(join(root, 'data', 'signal_state.json'), 'utf8')).length, 200);
});

test('recovers from invalid saved history without dropping live signals', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, 'data', 'signal_state.json'), JSON.stringify([null]));
  run(root, `
    store.initSignalHistory();
    assert.equal((await request('/api/pools')).count, 0);
    store.recordSignal(signal(1, 'new_pool'));
    assert.equal((await request('/api/pools')).count, 1);
  `);
  run(root, `
    store.initSignalHistory();
    assert.equal((await request('/api/pools')).count, 1);
  `);
});

test('keeps the last snapshot and live alerts when the history file cannot be written', (t) => {
  const root = fixture(t);
  run(root, `
    store.initSignalHistory();
    store.recordSignal(signal(1));
  `);
  mkdirSync(join(root, 'data', 'signal_state.json.tmp'));
  run(root, `
    store.initSignalHistory();
    const { dispatch } = await import('./src/notifier.ts');
    const { config } = await import('./src/config.ts');
    const realFetch = globalThis.fetch;
    config.telegramToken = '';
    config.webhookUrl = 'https://alerts.test/';
    let delivered = false;
    globalThis.fetch = (url, init) => {
      if (url !== config.webhookUrl) return realFetch(url, init);
      assert.equal(init.method, 'POST');
      delivered = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    await dispatch(signal(2));
    assert.equal(delivered, true);
    assert.deepEqual((await request('/api/whales')).signals.map((s) => s.token.symbol), ['TOKEN-2', 'TOKEN-1']);
  `);
  run(root, `
    store.initSignalHistory();
    assert.deepEqual((await request('/api/whales')).signals.map((s) => s.token.symbol), ['TOKEN-1']);
  `);
});
