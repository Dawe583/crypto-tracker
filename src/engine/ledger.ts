// Append-only hash-chained JSONL ledger (ai-hedge-fund pattern): every record
// carries prevHash + sha256 hash so the NAV track record is tamper-evident.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

const here = dirname(fileURLToPath(import.meta.url));
export const LEDGER_DIR = join(here, '..', '..', 'data', 'ledger');
mkdirSync(LEDGER_DIR, { recursive: true });

export interface LedgerRecord<T = unknown> {
  seq: number;
  ts: number;
  type: 'decision' | 'fill' | 'equity' | 'risk' | 'settle';
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
  if (d !== day) {
    day = d;
    path = join(LEDGER_DIR, `${d}.jsonl`);
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length) {
        const last = JSON.parse(lines[lines.length - 1]) as LedgerRecord;
        seq = last.seq + 1;
        lastHash = last.hash;
      }
    }
  }
}

const h = (s: string) => createHash('sha256').update(s).digest('hex');

export function ledgerAppend<T>(type: LedgerRecord['type'], data: T, ts = Date.now()): LedgerRecord<T> {
  rollDay(ts);
  const body = JSON.stringify(data);
  const hash = h(`${lastHash}:${seq}:${type}:${body}`);
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
