// Wallet watchlist engine. Loads curated smart-money / VC / insider addresses from data/watchlist.json.
// Entries whose address is not a valid 0x address are skipped, so the seed file ships as a template.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isAddress, getAddress, type Address } from 'viem';
import { logger } from './logger.js';

export type WalletCategory = 'smart_money' | 'vc' | 'insider_cluster' | 'deployer' | 'other';

export interface WatchedWallet {
  address: Address;
  label: string;
  category: WalletCategory;
  chains: Array<'base' | 'ethereum'>;
  notes?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const WATCHLIST_PATH = join(here, '..', 'data', 'watchlist.json');

export function loadWatchlist(): WatchedWallet[] {
  if (!existsSync(WATCHLIST_PATH)) {
    logger.warn({ path: WATCHLIST_PATH }, 'watchlist file missing');
    return [];
  }
  const raw = JSON.parse(readFileSync(WATCHLIST_PATH, 'utf8')) as Array<Record<string, any>>;
  const out: WatchedWallet[] = [];
  for (const e of raw) {
    if (!e.address || !isAddress(e.address)) {
      logger.debug({ label: e.label }, 'skipping watchlist entry without a valid address');
      continue;
    }
    out.push({
      address: getAddress(e.address),
      label: String(e.label ?? 'unlabeled'),
      category: (e.category ?? 'other') as WalletCategory,
      chains: e.chains ?? ['base', 'ethereum'],
      notes: e.notes,
    });
  }
  logger.info({ count: out.length }, 'watchlist loaded');
  return out;
}

export const WATCHLIST = loadWatchlist();
const byAddress = new Map(WATCHLIST.map((w) => [w.address.toLowerCase(), w]));

export function lookupWallet(addr: string): WatchedWallet | undefined {
  return byAddress.get(addr.toLowerCase());
}

export function watchedAddresses(chain: 'base' | 'ethereum'): Address[] {
  return WATCHLIST.filter((w) => w.chains.includes(chain)).map((w) => w.address);
}
