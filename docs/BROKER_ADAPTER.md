# Broker Adapter — spec pro napojení reálné burzy

Fáze: paper (teď) → testnet → live micro-size. Adapter je jediný bod, kde se paper mění na real.

## Rozhraní

```ts
interface BrokerAdapter {
  name: string;
  getPrice(symbol: string): Promise<number>;
  getBalance(): Promise<{ usd: number; assets: Record<string, number> }>;
  marketBuy(symbol: string, usd: number): Promise<OrderResult>;
  marketSell(symbol: string, qty: number): Promise<OrderResult>;
}
```

`OrderResult`: `{ id, fillPrice, qty, feeUsd, ts }`.

## Kandidáti (priorita pro RPi4)

| Broker | Proč | Testnet |
|---|---|---|
| Binance spot | nejlikvidnější, spot-only klíč bez withdrawals | ano (testnet.binance.vision) |
| Bybit spot | fallback feed už existuje | ano |
| Kraken | jednoduché REST, fungující feed | ano (demo) |
| Coinbase Advanced | fungující feed z cloudu | sandbox |

## Pravidla zapojení

- Engine volá `broker.marketBuy` místo `portfolio.open` jen když `ENGINE_BROKER=1` **a** zároveň `data/PAPER` soubor neexistuje (opětovný opt-in, ne jen env flag).
- API klíče: trade-only scope, IP allowlist, bez withdrawal. Klíče nikdy v repu — `BROKER_API_KEY`, `BROKER_API_SECRET` env.
- Každý reálný fill se stejně hash-ledgeruje (`type: 'fill'`, pole `brokerId`) → auditovatelná shoda s paper ledgerem.
- Kill switch `data/KILL` funguje identicky; při kill se navíc adapter odmítá otevírat, pouze zavírá pozice.
- Začátek live: max pozice $50, max expozice $150, denní loss breaker 3 %.

## Validace před live

1. Min. 3-4 týdny paper na live datech bez fatálních chyb.
2. Testnet min. 1 týden — porovnat fills vs paper model (slippage report).
3. `npm run backtest` musí projít bez chyb a výsledky odpovídat paper statistikám.
