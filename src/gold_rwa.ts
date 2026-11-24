// Gold RWA module: PAXG and XAUt on-chain/DEX price vs spot gold. Flags premium/discount/depeg and feeds the shared notifier.
import { getAddress, type Address } from 'viem';
import { CHAINS, config } from './config.js';
import { logger } from './logger.js';
import { dispatch, type WhaleSignal } from './notifier.js';
import { setGoldSnapshot } from './store.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Each token represents one troy ounce of gold (PAXG and XAUt are 1 token = 1 fine troy oz).
export const GOLD_ASSETS: Array<{ symbol: string; chain: 'base' | 'ethereum'; address: Address; issuer: string }> = [
  { symbol: 'PAXG', chain: 'ethereum', address: getAddress('0x45804880De22913dAFE09f4980848ECE6EcbAf78'), issuer: 'Paxos' },
  { symbol: 'XAUT', chain: 'ethereum', address: getAddress('0x68749665FF8D2d112Fa859AA293F07A622782F38'), issuer: 'Tether' },
  ...(config.gold.basePaxg ? [{ symbol: 'PAXG', chain: 'base' as const, address: getAddress(config.gold.basePaxg), issuer: 'Paxos' }] : []),
  ...(config.gold.baseXaut ? [{ symbol: 'XAUT', chain: 'base' as const, address: getAddress(config.gold.baseXaut), issuer: 'Tether' }] : []),
];

export interface GoldQuote {
  symbol: string;
  chain: 'base' | 'ethereum';
  dexPriceUsd: number;
  liquidityUsd: number;
  pairUrl: string;
  spotUsd: number;
  spotSource: string;
  deviationPct: number; // + = premium on DEX, - = discount
  level: 'none' | 'alert' | 'major';
  direction: 'premium' | 'discount' | 'in_line';
}

const here = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(here, '..', 'data', 'gold_state.json');
const REQUEST_TIMEOUT_MS = 5_000;

// Spot physical gold reference. Default: gold-api.com XAU price (free, no key), set GOLD_SPOT_URL to override.
// Expected JSON shape: { price: number } (or any top-level numeric "price" field).
export async function fetchSpotGold(): Promise<{ usd: number; source: string } | null> {
  try {
    const r = await fetch(config.gold.spotUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (r.ok) {
      const j: any = await r.json();
      const p = Number(j.price ?? j.usd ?? j.rate);
      if (Number.isFinite(p) && p > 0) return { usd: p, source: config.gold.spotUrl };
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'spot gold feed failed');
  }
  return null;
}

// DexScreener's priceUsd is for the base token.
async function dexQuote(chain: 'base' | 'ethereum', address: Address) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!r.ok) return null;
  const j: { pairs?: unknown } | null = await r.json();
  if (!Array.isArray(j?.pairs)) return null;
  const slug = CHAINS[chain].dexscreenerSlug;
  const token = address.toLowerCase();
  const quotes = j.pairs
    .filter((p) => p?.chainId === slug && typeof p.baseToken?.address === 'string' && p.baseToken.address.toLowerCase() === token)
    .map((p) => ({
      priceUsd: Number(p.priceUsd),
      liquidityUsd: Number(p.liquidity?.usd ?? 0),
      pairUrl: p.url ?? `https://dexscreener.com/${slug}/${p.pairAddress}`,
    }))
    .filter((q) => Number.isFinite(q.priceUsd) && q.priceUsd > 0 && Number.isFinite(q.liquidityUsd) && q.liquidityUsd >= 0)
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  return quotes[0] ?? null;
}

export function classify(deviationPct: number): GoldQuote['level'] {
  const a = Math.abs(deviationPct);
  if (a >= config.gold.majorPct) return 'major';
  if (a >= config.gold.alertPct) return 'alert';
  return 'none';
}

export async function scanGold(): Promise<GoldQuote[]> {
  const spot = await fetchSpotGold();
  if (!spot) {
    logger.warn('no spot gold reference available this cycle');
    return [];
  }
  const quotes = await Promise.all(GOLD_ASSETS.map(async (a): Promise<GoldQuote | null> => {
    const q = await dexQuote(a.chain, a.address).catch(() => null);
    if (!q) return null;
    const dev = ((q.priceUsd - spot.usd) / spot.usd) * 100;
    if (!Number.isFinite(dev)) return null;
    return {
      symbol: a.symbol,
      chain: a.chain,
      dexPriceUsd: q.priceUsd,
      liquidityUsd: q.liquidityUsd,
      pairUrl: q.pairUrl,
      spotUsd: spot.usd,
      spotSource: spot.source,
      deviationPct: dev,
      level: classify(dev),
      direction: Math.abs(dev) < config.gold.alertPct ? 'in_line' : dev > 0 ? 'premium' : 'discount',
    };
  }));
  return quotes.filter((q) => q !== null);
}

export function renderGoldAlert(q: GoldQuote): string {
  const tag = q.level === 'major' ? 'MAJOR DEVIATION' : 'GOLD RWA SPREAD';
  const depeg = q.level === 'major' && Math.abs(q.deviationPct) >= config.gold.majorPct ? 'possible depeg / arb' : 'arb watch';
  return [
    `🟡 ${tag}: ${q.symbol} on ${CHAINS[q.chain].name}`,
    `DEX price: $${q.dexPriceUsd.toFixed(2)} per troy oz`,
    `Spot gold: $${q.spotUsd.toFixed(2)} per troy oz (${q.spotSource})`,
    `Spread: ${q.deviationPct >= 0 ? '+' : ''}${q.deviationPct.toFixed(2)}% (${q.direction.replace('_', ' ')})`,
    `DEX liquidity: $${Math.round(q.liquidityUsd).toLocaleString('en-US')}`,
    `Status: ${depeg}`,
    `Thresholds: alert at ${config.gold.alertPct}%, major at ${config.gold.majorPct}%`,
    `Chart: ${q.pairUrl}`,
    `Note: spread is DEX vs spot reference. Redemption/mint fees and slippage are not netted out.`,
  ].join('\n');
}

// Alert only on level change per asset (no repeat spam).
function loadState(): Record<string, string> {
  if (!existsSync(STATE_PATH)) return {};
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveState(s: Record<string, string>) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

export async function runGoldCycle(): Promise<GoldQuote[]> {
  const quotes = await scanGold();
  setGoldSnapshot(quotes);
  if (!quotes.length) return quotes;
  const state = loadState();
  for (const q of quotes) {
    const key = `${q.chain}:${q.symbol}`;
    const prev = state[key] ?? 'none';
    if (q.level !== 'none' && q.level !== prev) {
      const addr = GOLD_ASSETS.find((a) => a.symbol === q.symbol && a.chain === q.chain)!.address;
      const signal: WhaleSignal = {
        kind: 'gold_rwa',
        chain: q.chain,
        token: { address: addr, symbol: q.symbol },
        marketCapUsd: null,
        liquidityUsd: q.liquidityUsd,
        contractVerified: null,
        links: { dexscreener: q.pairUrl, explorerToken: `${CHAINS[q.chain].explorer}/token/${addr}` },
        createdAt: new Date().toISOString(),
        text: renderGoldAlert(q),
      };
      await dispatch(signal);
    }
    state[key] = q.level;
    logger.info({ asset: key, dex: q.dexPriceUsd, spot: q.spotUsd, devPct: Number(q.deviationPct.toFixed(3)), level: q.level }, 'gold scan');
  }
  saveState(state);
  return quotes;
}

export function startGoldLoop() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runGoldCycle();
    } catch (err) {
      logger.error({ err: String(err) }, 'gold cycle failed');
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, config.gold.pollMs);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGoldCycle().then((q) => console.log(JSON.stringify(q, null, 2)));
}
