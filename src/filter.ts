// Fast filter and safety heuristics: market data, honeypot simulation, tax, LP lock, deployer history, explorer verification.
import { createPublicClient, http, webSocket, parseAbi, formatUnits, type Address, type Hash, type PublicClient } from 'viem';
import { base, mainnet } from 'viem/chains';
import { CHAINS, config } from './config.js';
import { logger } from './logger.js';

export type ChainKey = 'base' | 'ethereum';

const erc20 = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

export function makeClient(chain: ChainKey): PublicClient {
  const c = CHAINS[chain];
  const transport = c.wsRpc ? webSocket(c.wsRpc) : http(c.httpRpc);
  return createPublicClient({ chain: chain === 'base' ? base : mainnet, transport });
}

export interface MarketData {
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number | null;
  pairAddress: string;
  dexId: string;
  pairUrl: string;
  dexId2?: string;
}

// DexScreener public API (no key). Picks the pair with the deepest USD liquidity.
export async function getMarket(chain: ChainKey, token: Address): Promise<MarketData | null> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
    if (!r.ok) return null;
    const j: any = await r.json();
    const pairs = (j.pairs ?? []).filter((p: any) => p.chainId === CHAINS[chain].dexscreenerSlug && p.priceUsd);
    if (!pairs.length) return null;
    pairs.sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const p = pairs[0];
    return {
      priceUsd: Number(p.priceUsd),
      liquidityUsd: Number(p.liquidity?.usd ?? 0),
      marketCapUsd: p.marketCap ?? p.fdv ?? null,
      pairAddress: p.pairAddress,
      dexId: p.dexId,
      pairUrl: p.url ?? `https://dexscreener.com/${CHAINS[chain].dexscreenerSlug}/${p.pairAddress}`,
    };
  } catch (err) {
    logger.warn({ err: String(err), token }, 'dexscreener lookup failed');
    return null;
  }
}

export interface HoneypotResult {
  isHoneypot: boolean | null;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  reason?: string;
}

// honeypot.is public simulation API (no key). Simulates buy+sell to estimate taxes and honeypot status.
export async function checkHoneypot(chain: ChainKey, token: Address): Promise<HoneypotResult> {
  try {
    const r = await fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${token}&chainID=${CHAINS[chain].honeypotChainId}`);
    if (!r.ok) return { isHoneypot: null, buyTaxPct: null, sellTaxPct: null, reason: `http ${r.status}` };
    const j: any = await r.json();
    return {
      isHoneypot: j.honeypotResult?.isHoneypot ?? null,
      buyTaxPct: j.simulationResult?.buyTax ?? null,
      sellTaxPct: j.simulationResult?.sellTax ?? null,
      reason: j.honeypotResult?.honeypotReason,
    };
  } catch (err) {
    return { isHoneypot: null, buyTaxPct: null, sellTaxPct: null, reason: String(err) };
  }
}

// Explorer source verification via Basescan/Etherscan (needs API key; returns null if not configured).
export async function checkVerified(chain: ChainKey, token: Address): Promise<boolean | null> {
  const key = chain === 'base' ? config.basescanKey : config.etherscanKey;
  if (!key) return null;
  const host = chain === 'base' ? 'https://api.basescan.org/api' : 'https://api.etherscan.io/api';
  try {
    const r = await fetch(`${host}?module=contract&action=getsourcecode&address=${token}&apikey=${key}`);
    const j: any = await r.json();
    const src = j.result?.[0]?.SourceCode ?? '';
    return src !== '';
  } catch {
    return null;
  }
}

// Liquidity lock heuristic for Uniswap V2 style LPs: share of LP supply sent to burn/dead addresses.
// V3 positions are NFTs with no fungible LP supply, so this returns 'not_applicable' there.
export async function checkLiquidityLock(client: PublicClient, pair: Address, kind: 'v2' | 'v3' | 'aero'): Promise<{ status: string; burnedPct: number | null }> {
  if (kind !== 'v2') return { status: 'not_applicable', burnedPct: null };
  try {
    const total = await client.readContract({ address: pair, abi: erc20, functionName: 'totalSupply' });
    if (total === 0n) return { status: 'no_supply', burnedPct: 0 };
    const dead = await client.readContract({ address: pair, abi: erc20, functionName: 'balanceOf', args: ['0x000000000000000000000000000000000000dEaD'] });
    const zero = await client.readContract({ address: pair, abi: erc20, functionName: 'balanceOf', args: ['0x0000000000000000000000000000000000000000'] });
    const pct = Number(((dead + zero) * 10000n) / total) / 100;
    return { status: pct >= 95 ? 'burned_or_locked_likely' : 'not_burned', burnedPct: pct };
  } catch (err) {
    return { status: 'error', burnedPct: null };
  }
}

// Deployer history: native balance and number of prior transactions (nonce) as a cheap proxy.
export async function deployerProfile(client: PublicClient, deployer: Address) {
  const [balanceWei, nonce] = await Promise.all([
    client.getBalance({ address: deployer }),
    client.getTransactionCount({ address: deployer }),
  ]);
  return { balanceEth: Number(formatUnits(balanceWei, 18)), txCount: nonce };
}

export async function tokenMeta(client: PublicClient, token: Address) {
  const [symbol, decimals, totalSupply] = await Promise.all([
    client.readContract({ address: token, abi: erc20, functionName: 'symbol' }).catch(() => '?'),
    client.readContract({ address: token, abi: erc20, functionName: 'decimals' }).catch(() => 18),
    client.readContract({ address: token, abi: erc20, functionName: 'totalSupply' }).catch(() => 0n),
  ]);
  return { symbol: String(symbol), decimals: Number(decimals), totalSupply };
}

export interface SafetyVerdict {
  verdict: 'PASS' | 'WARN' | 'REJECT';
  reasons: string[];
  honeypot: HoneypotResult;
  verified: boolean | null;
  lock: { status: string; burnedPct: number | null };
  deployer?: { balanceEth: number; txCount: number };
}

// Combines the checks into a single verdict. Hard fails => REJECT, soft flags => WARN.
export async function evaluateToken(params: {
  chain: ChainKey;
  token: Address;
  pair?: Address;
  pairKind?: 'v2' | 'v3' | 'aero';
  deployer?: Address;
  client: PublicClient;
}): Promise<SafetyVerdict> {
  const { chain, token, pair, pairKind = 'v3', deployer, client } = params;
  const [honeypot, verified, lock, dep] = await Promise.all([
    checkHoneypot(chain, token),
    checkVerified(chain, token),
    pair ? checkLiquidityLock(client, pair, pairKind) : Promise.resolve({ status: 'no_pair', burnedPct: null }),
    deployer ? deployerProfile(client, deployer) : Promise.resolve(undefined),
  ]);

  const reasons: string[] = [];
  let verdict: SafetyVerdict['verdict'] = 'PASS';
  const hard = (msg: string) => { reasons.push(msg); verdict = 'REJECT'; };
  const soft = (msg: string) => { reasons.push(msg); if (verdict === 'PASS') verdict = 'WARN'; };

  if (honeypot.isHoneypot === true) hard(`honeypot: ${honeypot.reason ?? 'sell simulation failed'}`);
  if (honeypot.isHoneypot === null) soft('honeypot check unavailable');
  if (honeypot.buyTaxPct !== null && honeypot.buyTaxPct > config.maxBuyTaxPct) soft(`buy tax ${honeypot.buyTaxPct}% above ${config.maxBuyTaxPct}%`);
  if (honeypot.sellTaxPct !== null && honeypot.sellTaxPct > config.maxSellTaxPct) soft(`sell tax ${honeypot.sellTaxPct}% above ${config.maxSellTaxPct}%`);
  if (verified === false) soft('source code not verified on explorer');
  if (lock.status === 'not_burned') soft(`LP not burned/locked (${lock.burnedPct?.toFixed(1)}% burned)`);
  if (dep && dep.txCount <= 1) soft('deployer has very few prior transactions (possible throwaway wallet)');

  return { verdict, reasons, honeypot, verified, lock, deployer: dep };
}

export function txFrom(client: PublicClient, hash: Hash) {
  return client.getTransaction({ hash }).then((t) => t.from as Address).catch(() => undefined);
}
