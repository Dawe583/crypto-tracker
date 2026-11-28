import assert from 'node:assert/strict';
import test from 'node:test';
import { JevModel } from '../src/engine/decisions.js';

test('external decision model calls are abortable', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json({ action: 'hold', confidence: 0.2, reason: 'ok' });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const result = await new JevModel('key', 'https://model.test').decide({
    symbol: 'BTCUSDT', candles: [], price: 100, positions: [], params: {},
    signals: { whaleBuys: 0, newPools: 0, goldSpread: {} },
  }, 'hold?');
  assert.equal(result.action, 'hold');
});
