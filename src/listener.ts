// Event listener: factory PoolCreated/PairCreated events, watched-wallet Transfer logs (whale buys).
import { parseAbiItem, getAddress, formatUnits, type Address, type Log } from 'viem';
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
const dedupe = (k: string) => { if (seen.has(k)) return false; seen.add(k); if (seen.size > 5000) seen.clear(); return true; };

async function onNewPool(chain: ChainKey, dex: string, kind: 'v2' | 'v3' | 'aero', log: any) {
  const client = makeClient(chain);
  const t0 = getAddress(log.args.token0 as Address);
  const t1 = getAddress(log.args.token1 as Address);
  const pair = getAddress((log.args.pool ?? log.args.pair) as Address);
  if (!dedupe(`${chain}:${pair}`)) return;

  const quotes = QUOTE_TOKENS[CHAINS[chain].id].map((q) => q.toLowerCase());
  const token = quotes.includes(t0.toLowerCase()) ? t1 : t0;
  if (quotes.includes(token.toLowerCase())) return; // quote/quote pair, skip

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

async function onWatchedTransfer(chain: ChainKey, logs: Log[]) {
  const client = makeClient(chain);
  for (const log of logs as any[]) {
    const to = getAddress(log.args.to as Address);
    const wallet = lookupWallet(to);
    if (!wallet || !dedupe(`${chain}:${log.transactionHash}:${log.logIndex}`)) continue;
    const token = getAddress(log.address);
    const [meta, market] = await Promise.all([tokenMeta(client, token), getMarket(chain, token)]);
    if (!market) continue;
    const amount = Number(formatUnits(log.args.value as bigint, meta.decimals));
    const buyUsd = amount * market.priceUsd;
    if (buyUsd < config.whaleMinUsd) continue;
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
  }
}

export function startListener() {
  for (const chain of ['base', 'ethereum'] as ChainKey[]) {
    const client = makeClient(chain);
    for (const f of CHAINS[chain].factories) {
      const ev = f.kind === 'v2' ? EV.pairV2 : f.kind === 'aero' ? EV.poolAero : EV.poolV3;
      client.watchEvent({
        address: getAddress(f.address),
        event: ev as any,
        onLogs: (logs) => logs.forEach((l) => onNewPool(chain, f.name, f.kind, l).catch((e) => logger.error({ err: String(e) }, 'pool handler'))),
        onError: (e) => logger.error({ err: String(e), chain, dex: f.name }, 'pool watcher error'),
      });
      logger.info({ chain, dex: f.name, factory: f.address }, 'watching factory');
    }

    const watched = watchedAddresses(chain);
    if (watched.length) {
      client.watchEvent({
        event: EV.transfer,
        args: { to: watched },
        onLogs: (logs) => onWatchedTransfer(chain, logs).catch((e) => logger.error({ err: String(e) }, 'transfer handler')),
        onError: (e) => logger.error({ err: String(e), chain }, 'transfer watcher error'),
      });
      logger.info({ chain, wallets: watched.length }, 'watching smart-money transfers');
    }
  }
  logger.info({ wallets: WATCHLIST.length }, 'listener started');
}

if (import.meta.url === `file://${process.argv[1]}`) startListener();
