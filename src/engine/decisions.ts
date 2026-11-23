// Pluggable decision engine (jev-trader Model pattern). 'code' = strategies
// evaluate deterministically in-process; 'jev'/'llm' adapter slot for a typed
// decision model over API. Falls back to 'code' when no key is configured.
import { logger } from '../logger.js';
import type { StrategyContext, TradeIntent } from './types.js';

export interface DecisionModel {
  name: string;
  decide(ctx: StrategyContext, question: string): Promise<{ action: 'buy' | 'sell' | 'hold'; confidence: number; reason: string }>;
}

// TypeSafe Jev-style adapter: compact state in, typed decision out.
// Activated only when TYPESAFE_AI_API_KEY is set; never required.
export class JevModel implements DecisionModel {
  name = 'jev';
  constructor(private apiKey: string, private baseUrl = 'https://api.typesafe.ai/v1') {}

  async decide(ctx: StrategyContext, question: string) {
    try {
      const r = await fetch(`${this.baseUrl}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          question,
          state: {
            symbol: ctx.symbol,
            price: ctx.price,
            lastCandles: ctx.candles.slice(-10).map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]),
            positions: ctx.positions.length,
            params: ctx.params,
          },
        }),
      });
      if (!r.ok) throw new Error(`jev ${r.status}`);
      const j: any = await r.json();
      return {
        action: (j.action === 'buy' || j.action === 'sell' ? j.action : 'hold') as 'buy' | 'sell' | 'hold',
        confidence: Number(j.confidence ?? j.probabilities?.[j.action] ?? 0),
        reason: String(j.reason ?? 'jev'),
      };
    } catch (err) {
      logger.warn({ err: String(err) }, 'jev decision failed, holding');
      return { action: 'hold' as const, confidence: 0, reason: 'model unreachable' };
    }
  }
}

export function makeModel(env: { key?: string; url?: string }): DecisionModel | null {
  return env.key ? new JevModel(env.key, env.url) : null;
}
