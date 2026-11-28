// Event listener: factory PoolCreated/PairCreated events, watched-wallet Transfer logs (whale buys).
import { parseAbiItem, parseEventLogs, getAddress, formatUnits, BaseError, HttpRequestError, RpcRequestError, type Address, type Log, type PublicClient } from 'viem';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CHAINS, QUOTE_TOKENS, config } from './config.js';
import { logger } from './logger.js';
import { WATCHLIST, lookupWallet, watchedAddresses } from './wallets.js';
import { makeClient, getMarket, evaluateToken, tokenMeta, txFrom, type ChainKey } from './filter.js';
import { dispatch, type WhaleSignal } from './notifier.js';

const EV = {
  poolV3: parseAbiItem('event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'),
  pairV2: parseAbiItem('event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'),
  poolAero: parseAbiItem('event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)'),
  transfer: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
};

const seen = new Set<string>();
const dedupe = (k: string) => {
  if (seen.has(k)) return false;
  seen.add(k);
  if (seen.size > 5000) for (const old of [...seen].slice(0, 2500)) seen.delete(old);
  return true;
};

const WATCHER_STATE_PATH = 'data/watcher_state.json';

export type WatcherCursor = { get(): bigint | undefined; set(nextBlock: bigint, immediate?: boolean): void };

function readWatcherState(path = WATCHER_STATE_PATH): Record<string, string> {
  try {
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch (err) {
    logger.warn({ err: String(err), path }, 'watcher state unreadable');
    return {};
  }
}

export function watcherCursor(key: string, path = WATCHER_STATE_PATH): WatcherCursor {
  let lastWrite = 0;
  return {
    get() {
      const raw = readWatcherState(path)[key];
      if (!raw || !/^\d+$/.test(raw)) return undefined;
      return BigInt(raw);
    },
    set(nextBlock, immediate = false) {
      const now = Date.now();
      if (!immediate && lastWrite && now - lastWrite < 60_000) return;
      lastWrite = now;
      const state = readWatcherState(path);
      state[key] = nextBlock.toString();
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.tmp`;
      writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
      renameSync(temp, path);
    },
  };
}

async function onNewPool(chain: ChainKey, dex: string, kind: 'v2' | 'v3' | 'aero', log: any) {
  const client = makeClient(chain);
  const t0 = getAddress(log.args.token0 as Address);
  const t1 = getAddress(log.args.token1 as Address);
  const pair = getAddress((log.args.pool ?? log.args.pair) as Address);
  if (!dedupe(`${chain}:${pair}`)) return;

  const token = nonQuoteToken(chain, t0, t1);
  if (!token) return; // quote/quote or unknown/unknown pair has no reliable token side

  // Give the DEX indexer a moment to pick up the new pool before the market lookup.
  await new Promise((r) => setTimeout(r, 15_000));
  const [meta, market, deployerTx] = await Promise.all([
    tokenMeta(client, token),
    getMarket(chain, token),
    log.transactionHash ? txFrom(client, log.transactionHash) : Promise.resolve(undefined),
  ]);
  const safety = await evaluateToken({ chain, token, pair, pairKind: kind, deployer: deployerTx, client });
  if (safety.verdict === 'REJECT') {
    logger.info({ token, reasons: safety.reasons }, 'new pool rejected by filter');
    return;
  }
  if (market && market.liquidityUsd < config.minLiquidityUsd) {
    logger.info({ token, liq: market.liquidityUsd }, 'new pool below min liquidity');
    return;
  }
  const signal: WhaleSignal = {
    kind: 'new_pool',
    chain,
    token: { address: token, symbol: meta.symbol },
    marketCapUsd: market?.marketCapUsd ?? null,
    liquidityUsd: market?.liquidityUsd ?? null,
    pool: { dex: dex, pairAddress: pair },
    contractVerified: safety.verified,
    safety: { verdict: safety.verdict, reasons: safety.reasons },
    links: {
      dexscreener: market?.pairUrl,
      explorerToken: `${CHAINS[chain].explorer}/token/${token}`,
      explorerTx: log.transactionHash ? `${CHAINS[chain].explorer}/tx/${log.transactionHash}` : undefined,
    },
    createdAt: new Date().toISOString(),
  };
  await dispatch(signal);
}


export function transferBuyUsd(value: bigint, decimals: number, priceUsd: number): number | null {
  const buyUsd = Number(formatUnits(value, decimals)) * priceUsd;
  return Number.isFinite(buyUsd) ? buyUsd : null;
}

async function onWatchedTransfer(chain: ChainKey, logs: Log[]) {
  const client = makeClient(chain);
  for (const log of logs as any[]) {
    try {
      const to = getAddress(log.args.to as Address);
      const wallet = lookupWallet(to);
      if (!wallet || !dedupe(`${chain}:${log.transactionHash}:${log.logIndex}`)) continue;
      const token = getAddress(log.address);
      // Quote-token inflows are often sale proceeds, not a token buy; they carry no long signal.
      if (isQuoteToken(chain, token)) continue;
      const hash = log.transactionHash;
      const [meta, market, receipt, transaction] = await Promise.all([
        tokenMeta(client, token),
        getMarket(chain, token),
        hash ? client.getTransactionReceipt({ hash }).catch(() => null) : Promise.resolve(null),
        hash ? client.getTransaction({ hash }).catch(() => null) : Promise.resolve(null),
      ]);
      if (!market) continue;
      let transfers: Array<{ address: string; args: { from?: string } }> | null = null;
      if (receipt) {
        try {
          transfers = parseEventLogs({ abi: [EV.transfer], logs: receipt.logs, strict: false })
            .map((event) => ({ address: event.address, args: { from: (event.args as { from?: string }).from } }));
        } catch {
          transfers = null;
        }
      }
      // A received token is only directional buy evidence when the wallet paid native
      // currency or a quote asset in the same transaction. If receipt lookup fails,
      // keep the historical fail-open behavior rather than dropping the signal.
      if (receipt && transaction && transfers && !walletPaidForTransfer(chain, to, transfers, transaction.value, transaction.from)) continue;
      const buyUsd = transferBuyUsd(log.args.value as bigint, meta.decimals, market.priceUsd);
      if (buyUsd === null || buyUsd < config.whaleMinUsd) continue;
      const safety = await evaluateToken({ chain, token, client });
      const signal: WhaleSignal = {
        kind: 'whale_buy',
        chain,
        token: { address: token, symbol: meta.symbol },
        marketCapUsd: market.marketCapUsd,
        liquidityUsd: market.liquidityUsd,
        whale: { label: wallet.label, category: wallet.category, buyUsd, wallet: to },
        contractVerified: safety.verified,
        safety: { verdict: safety.verdict, reasons: safety.reasons },
        links: {
          dexscreener: market.pairUrl,
          explorerToken: `${CHAINS[chain].explorer}/token/${token}`,
          explorerTx: `${CHAINS[chain].explorer}/tx/${log.transactionHash}`,
        },
        createdAt: new Date().toISOString(),
      };
      await dispatch(signal);
    } catch (err) {
      logger.error({ chain, tx: log.transactionHash, err: String(err) }, 'transfer log handler');
    }
  }
}

export function isQuoteToken(chain: ChainKey, token: Address): boolean {
  return QUOTE_TOKENS[CHAINS[chain].id].some((quote) => quote.toLowerCase() === token.toLowerCase());
}

export function walletPaidForTransfer(
  chain: ChainKey,
  wallet: Address,
  transfers: Array<{ address: string; args: { from?: string } }>,
  nativeValue: bigint,
  transactionFrom?: string,
): boolean {
  if (nativeValue > 0n && transactionFrom?.toLowerCase() === wallet.toLowerCase()) return true;
  const source = wallet.toLowerCase();
  return transfers.some((log) => log.args.from?.toLowerCase() === source && isQuoteToken(chain, getAddress(log.address)));
}

export function nonQuoteToken(chain: ChainKey, token0: Address, token1: Address): Address | null {
  const quote0 = isQuoteToken(chain, token0);
  const quote1 = isQuoteToken(chain, token1);
  if (quote0 === quote1) return null;
  return quote0 ? token1 : token0;
}

const MAX_BLOCKS_PER_POLL = 100n;

export function watchLogs(client: PublicClient, ctx: Record<string, unknown>, { onLogs, ...filter }: Parameters<PublicClient['watchEvent']>[0], cursor?: WatcherCursor) {
  const onError = (err: unknown) => {
    const rpcError = err instanceof BaseError ? err.walk((cause) => cause instanceof HttpRequestError || cause instanceof RpcRequestError) : undefined;
    const status = rpcError instanceof HttpRequestError || rpcError instanceof RpcRequestError ? rpcError.status : undefined;
    logger.error({ ...ctx, err: err instanceof BaseError ? err.shortMessage : String(err), status }, 'watcher error');
  };
  if (client.transport.type !== 'http') return client.watchEvent({ ...filter, onLogs, onError });

  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextBlock: bigint | undefined;
  const scan = async () => {
    try {
      const head = await client.getBlockNumber();
      nextBlock ??= cursor?.get() ?? head + 1n;
      if (!active || nextBlock > head) return;
      const end = nextBlock + MAX_BLOCKS_PER_POLL - 1n;
      const toBlock = end < head ? end : head;
      const logs = await client.getLogs({ ...filter, fromBlock: nextBlock, toBlock, blockRange: MAX_BLOCKS_PER_POLL });
      if (!active) return;
      if (logs.length) await onLogs(logs);
      cursor?.set(toBlock + 1n, logs.length > 0);
      nextBlock = toBlock + 1n;
    } catch (err) {
      if (active) onError(err);
    } finally {
      if (active) timer = setTimeout(scan, client.pollingInterval);
    }
  };
  void scan();

  return () => {
    active = false;
    clearTimeout(timer);
  };
}

export function startListener() {
  for (const chain of ['base', 'ethereum'] as ChainKey[]) {
    const client = makeClient(chain);
    for (const f of CHAINS[chain].factories) {
      const ev = f.kind === 'v2' ? EV.pairV2 : f.kind === 'aero' ? EV.poolAero : EV.poolV3;
      watchLogs(client, { chain, dex: f.name }, {
        address: getAddress(f.address),
        event: ev as any,
        onLogs: async (logs) => {
          await Promise.all(logs.map((l) => onNewPool(chain, f.name, f.kind, l).catch((e) => logger.error({ err: String(e) }, 'pool handler'))));
        },
      }, watcherCursor(`${chain}:factory:${getAddress(f.address)}`));
      logger.info({ chain, dex: f.name, factory: f.address }, 'watching factory');
    }

    const watched = watchedAddresses(chain);
    if (watched.length) {
      watchLogs(client, { chain }, {
        event: EV.transfer,
        args: { to: watched },
        onLogs: async (logs) => {
          await onWatchedTransfer(chain, logs).catch((e) => logger.error({ err: String(e) }, 'transfer handler'));
        },
      }, watcherCursor(`${chain}:transfers`));
      logger.info({ chain, wallets: watched.length }, 'watching smart-money transfers');
    }
  }
  logger.info({ wallets: WATCHLIST.length }, 'listener started');
}

if (import.meta.url === `file://${process.argv[1]}`) startListener();
