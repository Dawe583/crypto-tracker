// Minimal technical indicators over closes/highs/lows. No external deps.
import type { Candle } from './types.js';

const validPeriod = (n: number) => Number.isSafeInteger(n) && n > 0;

export const closes = (cs: Candle[]) => cs.map((c) => c.c);
export const highs = (cs: Candle[]) => cs.map((c) => c.h);
export const lows = (cs: Candle[]) => cs.map((c) => c.l);
export const vols = (cs: Candle[]) => cs.map((c) => c.v);

export function sma(xs: number[], n: number): number | null {
  if (!validPeriod(n) || xs.length < n) return null;
  let s = 0;
  for (let i = xs.length - n; i < xs.length; i++) s += xs[i];
  return s / n;
}

export function emaSeries(xs: number[], n: number): number[] {
  if (!validPeriod(n) || xs.length < n) return [];
  const k = 2 / (n + 1);
  let e = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const out = [e];
  for (let i = n; i < xs.length; i++) {
    e = xs[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

export const ema = (xs: number[], n: number): number | null => {
  const s = emaSeries(xs, n);
  return s.length ? s[s.length - 1] : null;
};

export function rsi(xs: number[], n = 14): number | null {
  if (!validPeriod(n) || xs.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = xs.length - n; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  if (loss === 0) return gain === 0 ? null : 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

export function atr(cs: Candle[], n = 14): number | null {
  if (!validPeriod(n) || cs.length < n + 1) return null;
  let s = 0;
  for (let i = cs.length - n; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    s += tr;
  }
  return s / n;
}

export function macd(xs: number[], fast = 12, slow = 26, sig = 9): { line: number; histogram: number } | null {
  if (![fast, slow, sig].every(validPeriod)) return null;
  const ef = emaSeries(xs, fast);
  const es = emaSeries(xs, slow);
  if (fast >= slow || !es.length) return null;
  const macdLine = es.map((v, i) => ef[i + slow - fast] - v);
  const signal = emaSeries(macdLine, sig);
  if (!signal.length) return null;
  const line = macdLine[macdLine.length - 1];
  return { line, histogram: line - signal[signal.length - 1] };
}

export function macdHist(xs: number[], fast = 12, slow = 26, sig = 9): number | null {
  return macd(xs, fast, slow, sig)?.histogram ?? null;
}

export function bollinger(xs: number[], n = 20, mult = 2): { mid: number; up: number; lo: number } | null {
  if (!validPeriod(n) || !Number.isFinite(mult) || mult <= 0) return null;
  const mid = sma(xs, n);
  if (mid === null) return null;
  const w = xs.slice(-n);
  const varr = w.reduce((a, b) => a + (b - mid) ** 2, 0) / n;
  const sd = Math.sqrt(varr);
  return { mid, up: mid + mult * sd, lo: mid - mult * sd };
}

export function zscore(xs: number[], n = 50): number | null {
  if (!validPeriod(n)) return null;
  const mid = sma(xs, n);
  if (mid === null) return null;
  const w = xs.slice(-n);
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - mid) ** 2, 0) / n);
  if (sd === 0) return null;
  return (xs[xs.length - 1] - mid) / sd;
}

export function pctChange(xs: number[], n: number): number | null {
  if (!validPeriod(n) || xs.length < n + 1) return null;
  const prev = xs[xs.length - 1 - n];
  if (prev === 0) return null;
  return ((xs[xs.length - 1] - prev) / prev) * 100;
}
