// Append-only hash-chained JSONL ledger (ai-hedge-fund pattern): every record
// carries prevHash + sha256 hash so the NAV track record is tamper-evident.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const LEDGER_DIR = join(here, '..', '..', 'data', 'ledger');

export interface LedgerRecord<T = unknown> {
  seq: number;
  ts: number;
  type: 'decision' | 'fill' | 'equity' | 'risk' | 'settle' | 'checkpoint';
  prevHash: string;
  hash: string;
  data: T;
}

let seq = 0;
let lastHash = 'GENESIS';
let day = '';
let path = '';

function rollDay(ts: number) {
  const d = new Date(ts).toISOString().slice(0, 10);
  // File order must match append order even when the clock moves backward.
  if (d > day) {
    day = d;
    path = join(LEDGER_DIR, `${d}.jsonl`);
  }
}

export function hashLedgerPayload(prevHash: string, seq: number, type: LedgerRecord['type'], payload: string) {
  return createHash('sha256').update(`${prevHash}:${seq}:${type}:${payload}`).digest('hex');
}

function recordHash(prevHash: string, seq: number, type: LedgerRecord['type'], data: unknown) {
  return hashLedgerPayload(prevHash, seq, type, JSON.stringify(data));
}

function* readLedgerBackwards<T>(file: string): Generator<LedgerRecord<T>> {
  const contents = readFileSync(join(LEDGER_DIR, file), 'utf8');
  if (contents && !contents.endsWith('\n')) throw new Error(`incomplete paper ledger row in ${file}`);
  const lines = contents.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let record: LedgerRecord<T>;
    try {
      record = JSON.parse(lines[i]) as LedgerRecord<T>;
    } catch {
      throw new Error(`invalid paper ledger row in ${file}:${i + 1}`);
    }
    if (!record || !Number.isSafeInteger(record.seq) || record.seq < 0
      || typeof record.prevHash !== 'string' || (record.seq === 0) !== (record.prevHash === 'GENESIS')
      || record.hash !== recordHash(record.prevHash, record.seq, record.type, record.data)) {
      throw new Error(`invalid paper ledger hash in ${file}:${i + 1}`);
    }
    yield record;
  }
}


export function ledgerResumeLatestCheckpoint<T>(): LedgerRecord<T> | undefined {
  if (!existsSync(LEDGER_DIR)) return undefined;
  const files = readdirSync(LEDGER_DIR).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort().reverse();
  const links = new Map<string, Pick<LedgerRecord, 'seq' | 'prevHash'>>();
  let checkpoint: LedgerRecord<T> | undefined;
  let tip: LedgerRecord | undefined;
  let genesisRows = 0;
  for (const file of files) {
    for (const record of readLedgerBackwards<T>(file)) {
      if (links.has(record.hash)) throw new Error(`duplicate paper ledger row in ${file}`);
      links.set(record.hash, { seq: record.seq, prevHash: record.prevHash });
      if (record.seq === 0) genesisRows += 1;
      tip ??= record;
      checkpoint ??= record.type === 'fill' || record.type === 'checkpoint' ? record : undefined;
    }
  }
  if (!links.size) return undefined;
  if (!genesisRows) throw new Error('missing paper ledger chain prefix');
  if (genesisRows > 1) throw new Error('multiple paper ledger chain genesis rows');
  for (const { seq: rowSeq, prevHash } of links.values()) {
    if (rowSeq > 0 && links.get(prevHash)?.seq !== rowSeq - 1) {
      throw new Error('missing paper ledger chain predecessor');
    }
  }
  if (tip) {
    day = files[0].slice(0, 10);
    path = join(LEDGER_DIR, files[0]);
    seq = tip.seq + 1;
    lastHash = tip.hash;
  }
  return checkpoint;
}

export function ledgerAppend<T>(type: LedgerRecord['type'], data: T, ts = Date.now()): LedgerRecord<T> {
  if (!path) mkdirSync(LEDGER_DIR, { recursive: true });
  rollDay(ts);
  const hash = recordHash(lastHash, seq, type, data);
  const rec: LedgerRecord<T> = { seq, ts, type, prevHash: lastHash, hash, data };
  appendFileSync(path, JSON.stringify(rec) + '\n');
  seq += 1;
  lastHash = hash;
  return rec;
}

export function ledgerTail(limit: number, type?: LedgerRecord['type']): LedgerRecord[] {
  if (!existsSync(LEDGER_DIR)) return [];
  const files = readdirSync(LEDGER_DIR).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort().reverse();
  const out: LedgerRecord[] = [];
  outer: for (const file of files) {
    for (const record of readLedgerBackwards(file)) {
      if (!type || record.type === type) {
        out.unshift(record);
        if (out.length >= limit) break outer;
      }
    }
  }
  return out;
}
