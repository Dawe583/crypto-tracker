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

// Spot physical gold reference. Default: gold-api.com XAU price (free, no key), set GOLD_SPOT_URL to override.
// Expected JSON shape: { price: number } (or any top-level numeric "price" field).
export async function fetchSpotGold(): Promise<{ usd: number; source: string } | null> {
  try {
    const r = await fetch(config.gold.spotUrl, { headers: { accept: 'application/json' } });
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

// DEX price from DexScreener, deepest-liquidity pair for the token on the given chain.
async function dexQuote(chain: 'base' | 'ethereum', address: Address) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
  if (!r.ok) return null;
  const j: any = await r.json();
  const pairs = (j.pairs ?? [])
    .filter((p: any) => p.chainId === CHAINS[chain].dexscreenerSlug && p.priceUsd)
    .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  if (!pairs.length) return null;
  const p = pairs[0];
  return {
    priceUsd: Number(p.priceUsd),
    liquidityUsd: Number(p.liquidity?.usd ?? 0),
    pairUrl: p.url ?? `https://dexscreener.com/${CHAINS[chain].dexscreenerSlug}/${p.pairAddress}`,
  };
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
  const out: GoldQuote[] = [];
  for (const a of GOLD_ASSETS) {
    const q = await dexQuote(a.chain, a.address).catch(() => null);
    if (!q) continue;
    const dev = ((q.priceUsd - spot.usd) / spot.usd) * 100;
    out.push({
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
    });
  }
  return out;
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
  const tick = () => runGoldCycle().catch((e) => logger.error({ err: String(e) }, 'gold cycle failed'));
  tick();
  return setInterval(tick, config.gold.pollMs);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGoldCycle().then((q) => console.log(JSON.stringify(q, null, 2)));
}
