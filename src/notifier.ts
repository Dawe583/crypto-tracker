// Signal alert dispatcher: structured payload -> Telegram and/or generic webhook, always logged.
import { CHAINS, config } from './config.js';
import { logger } from './logger.js';
import type { SafetyVerdict } from './filter.js';

export interface WhaleSignal {
  kind: 'whale_buy' | 'new_pool' | 'gold_rwa';
  chain: 'base' | 'ethereum';
  token: { address: string; symbol: string };
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  whale?: { label: string; category: string; buyUsd: number; wallet: string };
  pool?: { dex: string; pairAddress: string };
  contractVerified: boolean | null;
  safety?: Pick<SafetyVerdict, 'verdict' | 'reasons'>;
  links: { dexscreener?: string; explorerToken: string; explorerTx?: string };
  createdAt: string;
  text?: string; // pre-rendered body for non-token alerts (e.g. Gold RWA)
}

const fmtUsd = (n: number | null | undefined) =>
  n === null || n === undefined ? 'n/a' : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;

export function renderText(s: WhaleSignal): string {
  if (s.text) return s.text;
  const lines = [
    `🐋 ${s.kind === 'whale_buy' ? 'WHALE BUY' : 'NEW POOL'} on ${CHAINS[s.chain].name}`,
    `Token: ${s.token.symbol} (${s.token.address})`,
    `Market Cap: ${fmtUsd(s.marketCapUsd)}`,
    `Liquidity: ${fmtUsd(s.liquidityUsd)}`,
  ];
  if (s.whale) lines.push(`Whale: ${s.whale.label} [${s.whale.category}] bought ${fmtUsd(s.whale.buyUsd)}`);
  if (s.pool) lines.push(`Pool: ${s.pool.dex} ${s.pool.pairAddress}`);
  lines.push(`Contract verified: ${s.contractVerified === null ? 'unknown' : s.contractVerified ? 'yes' : 'NO'}`);
  if (s.safety) {
    lines.push(`Safety: ${s.safety.verdict}${s.safety.reasons.length ? ' - ' + s.safety.reasons.join('; ') : ''}`);
  }
  if (s.links.dexscreener) lines.push(`DexScreener: ${s.links.dexscreener}`);
  lines.push(`Explorer: ${s.links.explorerToken}`);
  if (s.links.explorerTx) lines.push(`Tx: ${s.links.explorerTx}`);
  return lines.join('\n');
}

export async function dispatch(s: WhaleSignal): Promise<void> {
  const text = renderText(s);
  logger.info({ signal: s.kind, token: s.token.symbol, chain: s.chain }, 'signal');
  console.log(`\n${text}\n`);

  if (config.telegramToken && config.telegramChatId) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: config.telegramChatId, text, disable_web_page_preview: true }),
      });
      if (!r.ok) logger.warn({ status: r.status }, 'telegram send failed');
    } catch (err) {
      logger.warn({ err: String(err) }, 'telegram error');
    }
  }

  if (config.webhookUrl) {
    try {
      await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, signal: s }),
      });
    } catch (err) {
      logger.warn({ err: String(err) }, 'webhook error');
    }
  }
}
