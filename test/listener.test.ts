import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAbiItem, type Log, type PublicClient } from 'viem';
import { watchLogs } from '../src/listener.js';

const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const to = ['0x0000000000000000000000000000000000000001'] as const;

test('HTTP retries the failed range and catches up in bounded pages', { timeout: 1000 }, async (t) => {
  const ranges: Array<[bigint, bigint]> = [];
  const received: Array<bigint | null> = [];
  let headReads = 0;
  let filterWatches = 0;
  const client = {
    transport: { type: 'http' },
    pollingInterval: 2,
    watchEvent: () => {
      filterWatches++;
      return () => {};
    },
    async getBlockNumber() {
      if (++headReads === 1) return 100n;
      return 305n;
    },
    async getLogs(params: { event: typeof transfer; args: { to: string[] }; fromBlock: bigint; toBlock: bigint }) {
      const { fromBlock, toBlock } = params;
      ranges.push([fromBlock, toBlock]);
      if (ranges.length === 1) throw new Error('temporary RPC failure');
      assert.deepEqual(params.event, transfer);
      assert.deepEqual(params.args.to, to);
      return fromBlock === 101n ? [] : [{ blockNumber: toBlock }];
    },
  } as unknown as PublicClient;

  let resolveCaughtUp!: () => void;
  const caughtUp = new Promise<void>((resolve) => { resolveCaughtUp = resolve; });
  const stop = watchLogs(client, {}, {
    event: transfer,
    args: { to: [...to] },
    onLogs(logs: Log[]) {
      received.push(...logs.map((log) => log.blockNumber));
      if (received.at(-1) === 305n) resolveCaughtUp();
    },
  });
  t.after(stop);
  assert.equal(filterWatches, 0, 'HTTP must not depend on evictable RPC filters');
  await caughtUp;
  assert.deepEqual(ranges, [[101n, 200n], [101n, 200n], [201n, 300n], [301n, 305n]]);
  assert.deepEqual(received, [300n, 305n]);
});

test('WebSocket keeps using the native event subscription', () => {
  let subscribed = false;
  let unsubscribed = false;
  const client = {
    transport: { type: 'webSocket' },
    watchEvent(params: { event: typeof transfer }) {
      assert.deepEqual(params.event, transfer);
      subscribed = true;
      return () => { unsubscribed = true; };
    },
  } as unknown as PublicClient;
  const stop = watchLogs(client, {}, { event: transfer, onLogs() {} });
  assert.equal(subscribed, true);
  stop();
  assert.equal(unsubscribed, true);
});
