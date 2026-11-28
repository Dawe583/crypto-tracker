import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LIBRARY } from '../src/strategies/library.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'crypto-tracker-signals-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(new URL('../src', import.meta.url), join(root, 'src'), { recursive: true });
  copyFileSync(new URL('../package.json', import.meta.url), join(root, 'package.json'));
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'junction');
  mkdirSync(join(root, 'data'));
  return root;
}

function run(root: string, script: string, env: Record<string, string> = {}) {
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
    env: { ...process.env, LOG_LEVEL: 'silent', API_ENABLED: 'true', API_HOST: '127.0.0.1', API_PORT: '0', API_TOKEN: '', ...env },
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
    const { Server } = await import('node:http');
    const listen = Server.prototype.listen;
    let server;
    Server.prototype.listen = function (...args) {
      server = this;
      return listen.apply(this, args);
    };
    const fetchLocal = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (new URL(url.url ?? url).hostname !== '127.0.0.1') throw new Error('Offline test');
      return fetchLocal(url, options);
    };
    await import('./src/index.ts');
    if (!server.listening) await once(server, 'listening');
    const get = async (path) => {
      const response = await fetch('http://127.0.0.1:' + server.address().port + path);
      assert.equal(response.status, 200);
      return response.json();
    };
    const whales = await get('/api/whales?limit=200');
    assert.equal(whales.count, 199);
    assert.equal(whales.signals[0].token.symbol, 'TOKEN-202');
    assert.equal(whales.signals.at(-1).token.symbol, 'TOKEN-4');
    const pools = await get('/api/pools');
    assert.equal(pools.count, 1);
    assert.equal(pools.signals[0].token.symbol, 'TOKEN-203');
    process.exit(0);
  `, {
    ENGINE_ENABLED: 'false', BASE_RPC_WS: '', ETH_RPC_WS: '',
    BASE_RPC_HTTP: 'http://127.0.0.1:1', ETH_RPC_HTTP: 'http://127.0.0.1:1',
    GOLD_SPOT_URL: 'http://127.0.0.1:1',
  });
  assert.equal(JSON.parse(readFileSync(join(root, 'data', 'signal_state.json'), 'utf8')).length, 200);
});

test('leaves invalid saved history intact while accepting live signals', (t) => {
  const root = fixture(t);
  const snapshot = join(root, 'data', 'signal_state.json');
  writeFileSync(snapshot, '[null]');
  run(root, `
    store.initSignalHistory();
    assert.equal((await request('/api/pools')).count, 0);
    store.recordSignal(signal(1, 'new_pool'));
    assert.equal((await request('/api/pools')).count, 1);
  `);
  assert.equal(readFileSync(snapshot, 'utf8'), '[null]');
  rmSync(snapshot);
  run(root, `
    store.initSignalHistory();
    store.recordSignal(signal(2, 'new_pool'));
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

test('long Telegram alerts are truncated while webhook failures do not lose signal history', (t) => {
  const root = fixture(t);
  run(root, `
    const { dispatch } = await import('./src/notifier.ts');
    const { config } = await import('./src/config.ts');
    config.telegramToken = 'token';
    config.telegramChatId = 'chat';
    config.webhookUrl = 'https://alerts.test/';
    let telegramLength = 0;
    let webhookCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => {
      if (String(url).startsWith('https://api.telegram.org/')) {
        telegramLength = JSON.parse(init.body).text.length;
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === config.webhookUrl) {
        webhookCalls += 1;
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      return realFetch(url, init);
    };
    await dispatch({ ...signal(4), safety: { verdict: 'CAUTION', reasons: ['x'.repeat(5000)] } });
    assert.equal(telegramLength, 4096);
    assert.equal(webhookCalls, 1);
    assert.equal((await request('/api/whales')).count, 1);
  `);
});

test('alert text strips terminal control characters from token-controlled fields', (t) => {
  const root = fixture(t);
  run(root, `
    const { renderText } = await import('./src/notifier.ts');
    const text = renderText({
      kind: 'whale_buy', chain: 'base',
      token: { address: '0x0000000000000000000000000000000000000001', symbol: 'EVIL\u001b[31mTOKEN' },
      marketCapUsd: null, liquidityUsd: null, contractVerified: null,
      links: { explorerToken: 'https://basescan.org/token/0x0000000000000000000000000000000000000001' },
      createdAt: new Date().toISOString(),
    });
    assert.equal(text.includes('\u001b'), false);
    assert.ok(text.includes('EVIL[31mTOKEN'));
  `);
});

test('restored whales only drive paper entries if the wallet is still watched on that chain', (t) => {
  const root = fixture(t);
  const removed = '0x0000000000000000000000000000000000000010';
  const watched = '0x0000000000000000000000000000000000000020';
  const watchlist = join(root, 'data', 'watchlist.json');
  writeFileSync(watchlist, JSON.stringify([{ address: removed, chains: ['base'] }, { address: watched, chains: ['base', 'ethereum'] }]));
  run(root, `
    store.initSignalHistory();
    store.recordSignal({ ...signal(1), whale: { wallet: '${removed}' } });
    store.recordSignal({ ...signal(2), whale: { wallet: '${watched}' } });
  `);
  writeFileSync(watchlist, JSON.stringify([{ address: watched, chains: ['ethereum'] }]));
  writeFileSync(join(root, 'data', 'strategies.json'), JSON.stringify(Object.fromEntries(
    LIBRARY.map(({ name }) => [name, { enabled: name === 'whale_follow' }]),
  )));
  const engine = `
    const { runEngineCycle } = await import('./src/engine/loop.ts');
    const { engineState } = await import('./src/engine/state.ts');
    globalThis.fetch = async () => Response.json(
      Array.from({ length: 40 }, (_, i) => [Date.now() - (39 - i) * 60_000, 100, 101, 99, 100, 100]),
    );
    await runEngineCycle();
  `;
  const env = {
    ENGINE_SYMBOLS: 'BTCUSDT', ENGINE_INTERVAL: '1m', ENGINE_START_USD: '10000', ENGINE_MAX_POSITION_USD: '500',
    ENGINE_MAX_TOTAL_USD: '1000', ENGINE_MAX_OPEN_POSITIONS: '8', ENGINE_MIN_CONFIDENCE: '0.5', ENGINE_FEE_PCT: '0.1',
  };
  run(root, `
    store.initSignalHistory();
    assert.equal((await request('/api/whales')).count, 2);
    ${engine}
    assert.equal(engineState.snapshot.positions.length, 0);
    store.recordSignal({ ...signal(3), chain: 'ethereum', whale: { wallet: '${watched}' } });
  `, env);
  run(root, `
    store.initSignalHistory();
    ${engine}
    assert.deepEqual(engineState.snapshot.positions.map((p) => p.strategy), ['whale_follow']);
  `, env);
});
