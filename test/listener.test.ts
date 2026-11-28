import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAbiItem, type Log, type PublicClient } from 'viem';
import { isQuoteToken, logTimestampIso, nonQuoteToken, transferBuyUsd, walletPaidForTransfer, watchLogs, watcherCursor } from '../src/listener.js';

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

test('HTTP cursor starts at the saved block and advances only after handling logs', { timeout: 1000 }, async (t) => {
  const ranges: Array<[bigint, bigint]> = [];
  const writes: bigint[] = [];
  let release!: () => void;
  let handlerStarted = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const client = {
    transport: { type: 'http' },
    pollingInterval: 5,
    async getBlockNumber() { return 150n; },
    async getLogs(params: { fromBlock: bigint; toBlock: bigint }) {
      ranges.push([params.fromBlock, params.toBlock]);
      return [{ blockNumber: params.toBlock }];
    },
  } as unknown as PublicClient;
  const cursor = {
    get: () => 120n,
    set: (nextBlock: bigint) => writes.push(nextBlock),
  };
  const stop = watchLogs(client, {}, {
    event: transfer,
    async onLogs() {
      handlerStarted = true;
      await gate;
    },
  }, cursor);
  t.after(stop);
  for (let i = 0; i < 20 && !handlerStarted; ++i) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(handlerStarted, true);
  assert.deepEqual(writes, []);
  release();
  for (let i = 0; i < 20 && !writes.length; ++i) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.deepEqual(ranges[0], [120n, 150n]);
  assert.deepEqual(writes, [151n]);
});

test('watcher cursor state survives a reload and ignores malformed values', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'crypto-tracker-cursor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'watcher_state.json');
  assert.equal(watcherCursor('base:transfers', file).get(), undefined);
  watcherCursor('base:transfers', file).set(123n);
  assert.equal(watcherCursor('base:transfers', file).get(), 123n);
  watcherCursor('base:factory', file).set(99n);
  assert.equal(watcherCursor('base:transfers', file).get(), 123n);
  assert.equal(watcherCursor('base:factory', file).get(), 99n);
});

test('quiet cursor advances are throttled while batches with matching logs persist immediately', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'crypto-tracker-cursor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'watcher_state.json');
  const cursor = watcherCursor('base:transfers', file);
  cursor.set(100n);
  cursor.set(101n);
  assert.equal(watcherCursor('base:transfers', file).get(), 100n);
  cursor.set(102n, true);
  assert.equal(watcherCursor('base:transfers', file).get(), 102n);
});

test('pool token selection requires exactly one recognized quote side', () => {
  const weth = '0x4200000000000000000000000000000000000006';
  const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const usdt = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2';
  const token = '0x00000000000000000000000000000000000000aa';
  const other = '0x00000000000000000000000000000000000000bb';
  assert.equal(nonQuoteToken('base', weth, token), token);
  assert.equal(nonQuoteToken('base', token, usdt), token);
  assert.equal(nonQuoteToken('base', weth, usdc), null);
  assert.equal(nonQuoteToken('base', token, other), null);
});

test('oversized transfer values do not become infinite buy amounts', () => {
  assert.equal(transferBuyUsd(10n ** 350n, 18, 2), null);
  assert.equal(transferBuyUsd(2n * 10n ** 18n, 18, 3), 6);
});

test('quote assets are not treated as directional whale buys', () => {
  assert.equal(isQuoteToken('base', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), true);
  assert.equal(isQuoteToken('base', '0x4200000000000000000000000000000000000006'), true);
  assert.equal(isQuoteToken('ethereum', '0xdAC17F958D2ee523a2206206994597C13D831ec7'), true);
  assert.equal(isQuoteToken('base', '0x000000000000000000000000000000000000dEaD'), false);
});

test('token inflows require native or quote-asset payment evidence', () => {
  const wallet = '0x0000000000000000000000000000000000000001';
  const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const token = '0x000000000000000000000000000000000000dEaD';
  assert.equal(walletPaidForTransfer('base', wallet, [], 1n, wallet), true);
  assert.equal(walletPaidForTransfer('base', wallet, [], 1n, token), false);
  assert.equal(walletPaidForTransfer('base', wallet, [{ address: usdc, args: { from: wallet } }], 0n), true);
  assert.equal(walletPaidForTransfer('base', wallet, [{ address: usdc, args: { from: token } }], 0n), false);
  assert.equal(walletPaidForTransfer('base', wallet, [{ address: token, args: { from: wallet } }], 0n), false);
});

test('signal timestamps come from the event block when available', async () => {
  const client = {
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      assert.equal(blockNumber, 123n);
      return { timestamp: 1_700_000_000n };
    },
  } as unknown as PublicClient;
  assert.equal(await logTimestampIso(client, 123n), '2023-11-14T22:13:20.000Z');
  assert.ok(Number.isFinite(Date.parse(await logTimestampIso(client, null))));
});
