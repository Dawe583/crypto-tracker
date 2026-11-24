// Append-only hash-chained JSONL ledger (ai-hedge-fund pattern): every record
// carries prevHash + sha256 hash so the NAV track record is tamper-evident.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const LEDGER_DIR = join(here, '..', '..', 'data', 'ledger');
mkdirSync(LEDGER_DIR, { recursive: true });

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

function recordHash(prevHash: string, seq: number, type: LedgerRecord['type'], data: unknown) {
  return createHash('sha256').update(`${prevHash}:${seq}:${type}:${JSON.stringify(data)}`).digest('hex');
}

export function ledgerResumeLatestCheckpoint<T>(): LedgerRecord<T> | undefined {
  const files = readdirSync(LEDGER_DIR).filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort().reverse();
  let newer: LedgerRecord | undefined;
  for (const file of files) {
    const contents = readFileSync(join(LEDGER_DIR, file), 'utf8');
    if (contents && !contents.endsWith('\n')) throw new Error(`incomplete paper ledger row in ${file}`);
    const lines = contents.trim().split('\n');
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
      if (newer && (newer.seq !== record.seq + 1 || newer.prevHash !== record.hash)) {
        throw new Error(`broken paper ledger chain after ${file}:${i + 1}`);
      }
      if (!newer) {
        day = file.slice(0, 10);
        path = join(LEDGER_DIR, file);
        seq = record.seq + 1;
        lastHash = record.hash;
      }
      if (record.type === 'fill' || record.type === 'checkpoint') return record;
      if (record.seq === 0) return undefined;
      newer = record;
    }
  }
  if (newer) throw new Error('missing paper ledger chain prefix');
}

export function ledgerAppend<T>(type: LedgerRecord['type'], data: T, ts = Date.now()): LedgerRecord<T> {
  rollDay(ts);
  const hash = recordHash(lastHash, seq, type, data);
  const rec: LedgerRecord<T> = { seq, ts, type, prevHash: lastHash, hash, data };
  appendFileSync(path, JSON.stringify(rec) + '\n');
  seq += 1;
  lastHash = hash;
  return rec;
}

export function ledgerTail(limit: number, type?: LedgerRecord['type']): LedgerRecord[] {
  const files = [day ? path : ''].filter(Boolean);
  const out: LedgerRecord[] = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
    for (const l of lines) {
      const rec = JSON.parse(l) as LedgerRecord;
      if (!type || rec.type === type) out.push(rec);
    }
  }
  return out.slice(-limit);
}

export function ledgerAllToday(type?: LedgerRecord['type']): LedgerRecord[] {
  return ledgerTail(10000, type);
}
