// Central configuration loaded from environment (.env via dotenv).
import 'dotenv/config';

const num = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v: string | undefined, d = ''): string => (v && v.trim() !== '' ? v.trim() : d);

export const CHAINS = {
  base: {
    id: 8453,
    key: 'base' as const,
    name: 'Base',
    httpRpc: str(process.env.BASE_RPC_HTTP, 'https://mainnet.base.org'),
    wsRpc: str(process.env.BASE_RPC_WS),
    explorer: 'https://basescan.org',
    dexscreenerSlug: 'base',
    honeypotChainId: 8453,
    // Verify these addresses on basescan.org before relying on them.
    factories: [
      { name: 'UniswapV3', kind: 'v3' as const, address: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' },
      { name: 'Aerodrome', kind: 'aero' as const, address: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' }, // Aerodrome V2 PoolFactory; verify on basescan before use
    ],
  },
  ethereum: {
    id: 1,
    key: 'ethereum' as const,
    name: 'Ethereum',
    httpRpc: str(process.env.ETH_RPC_HTTP, 'https://eth.llamarpc.com'),
    wsRpc: str(process.env.ETH_RPC_WS),
    explorer: 'https://etherscan.io',
    dexscreenerSlug: 'ethereum',
    honeypotChainId: 1,
    factories: [
      { name: 'UniswapV3', kind: 'v3' as const, address: '0x1F98431c8aD98523631AE4a59f267346ea31F984' },
      { name: 'UniswapV2', kind: 'v2' as const, address: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f' },
    ],
  },
};

// Quote tokens used to decide which side of a new pool is the "new" token.
export const QUOTE_TOKENS: Record<number, string[]> = {
  8453: [
    '0x4200000000000000000000000000000000000006', // WETH
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
  ],
  1: [
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  ],
};

export const config = {
  whaleMinUsd: num(process.env.WHALE_MIN_USD, 50_000),
  minLiquidityUsd: num(process.env.MIN_LIQUIDITY_USD, 20_000),
  maxBuyTaxPct: num(process.env.MAX_BUY_TAX_PCT, 10),
  maxSellTaxPct: num(process.env.MAX_SELL_TAX_PCT, 10),
  basescanKey: str(process.env.BASESCAN_API_KEY),
  etherscanKey: str(process.env.ETHERSCAN_API_KEY),
  telegramToken: str(process.env.TELEGRAM_BOT_TOKEN),
  telegramChatId: str(process.env.TELEGRAM_CHAT_ID),
  webhookUrl: str(process.env.ALERT_WEBHOOK_URL),
  api: {
    enabled: str(process.env.API_ENABLED, 'true').toLowerCase() !== 'false',
    host: str(process.env.API_HOST, '0.0.0.0'),
    port: num(process.env.API_PORT, 8787),
    token: str(process.env.API_TOKEN),
    corsOrigins: str(process.env.API_CORS_ORIGINS)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  },
  gold: {
    spotUrl: str(process.env.GOLD_SPOT_URL, 'https://api.gold-api.com/price/XAU'),
    pollMs: num(process.env.GOLD_POLL_MS, 60_000),
    alertPct: num(process.env.GOLD_ALERT_PCT, 0.5),
    majorPct: num(process.env.GOLD_MAJOR_PCT, 1.5),
    basePaxg: str(process.env.BASE_PAXG_ADDRESS),
    baseXaut: str(process.env.BASE_XAUT_ADDRESS),
  },
};
