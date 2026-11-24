import { config } from '../config.js';
import { hashLedgerPayload, type LedgerRecord } from './ledger.js';
import { createPaperEngine, type EngineCheckpoint } from './loop.js';
import { fetchSymbol, type Feed } from './market.js';
import type { EngineSnapshot } from './state.js';
import type { DecisionRecord } from './types.js';

type PersistedRecord = Omit<LedgerRecord, 'data'> & { payload: string };
type DeckState = { snapshot: EngineSnapshot; decisions: DecisionRecord[] };
type Head = {
  slot: number;
  seq: number;
  hash: string;
  checkpoint: EngineCheckpoint | null;
  deck: Partial<DeckState>;
};
type Commit = {
  p_slot: number;
  p_seq: number;
  p_hash: string;
  p_checkpoint: EngineCheckpoint;
  p_deck: DeckState & { candles: Record<string, Feed> };
  p_records: PersistedRecord[];
};

export function createHostedStore(env: NodeJS.ProcessEnv = process.env) {
  const url = env.SUPABASE_URL;
  const secret = env.SUPABASE_SECRET_KEY;
  if (!url || !secret) return null;
  const origin = new URL(url);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('SUPABASE_URL must be an HTTPS origin');
  }
  const headers = { apikey: secret, 'content-type': 'application/json' };

  async function rpc<T>(name: string, args: object): Promise<T> {
    const response = await fetch(new URL('/rest/v1/rpc/' + name, origin), {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Paper engine storage ${name} failed (${response.status})`);
    return response.json() as Promise<T>;
  }

  return {
    load: () => rpc<Head>('paper_engine_load', {}),
    commit: (cycle: Commit) => rpc<boolean>('paper_engine_commit', cycle),
    read: (key: 'snapshot' | 'decisions' | 'candles', symbol: string | null = null) =>
      rpc<EngineSnapshot | DecisionRecord[] | Feed | null>('paper_engine_read', { p_key: key, p_symbol: symbol }),
  };
}

export async function runHostedCycle(
  store: Pick<NonNullable<ReturnType<typeof createHostedStore>>, 'load' | 'commit'>,
  slot = Math.floor(Date.now() / 60_000),
  refresh = fetchSymbol,
  strategies?: Parameters<typeof createPaperEngine>[0]['strategies'],
) {
  const head = await store.load();
  if (head.slot >= slot) return false;
  if ((head.seq === -1) !== (head.checkpoint === null)) throw new Error('Paper engine checkpoint missing');

  const state = { snapshot: head.deck.snapshot ?? null, decisions: [...(head.deck.decisions ?? [])], halted: false };
  let seq = head.seq;
  let hash = head.hash;
  const records: PersistedRecord[] = [];
  const append = (type: LedgerRecord['type'], data: unknown) => {
    const payload = JSON.stringify(data);
    const prevHash = hash;
    hash = hashLedgerPayload(prevHash, ++seq, type, payload);
    records.push({ seq, ts: Date.now(), type, prevHash, hash, payload });
  };
  const engine = createPaperEngine({
    state,
    refresh,
    strategies,
    append,
    signals: () => ({ whaleBuys: 0, newPools: 0, goldSpread: {} }),
  });
  if (head.checkpoint) engine.restore(head.checkpoint);
  const feeds = await engine.cycle();
  if (!feeds.size || !state.snapshot) throw new Error('No paper engine market feed available');
  const checkpoint = engine.checkpoint();
  if (records.at(-1)?.type !== 'equity') append('checkpoint', { checkpoint });

  return store.commit({
    p_slot: slot,
    p_seq: head.seq,
    p_hash: head.hash,
    p_checkpoint: checkpoint,
    p_deck: { snapshot: state.snapshot, decisions: state.decisions, candles: Object.fromEntries(feeds) },
    p_records: records,
  });
}

export const hostedEngineEnabled = () => config.engine.enabled && process.env.VERCEL_ENV === 'production';
