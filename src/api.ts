// Lightweight JSON HTTP API (node:http, no extra dependencies) for OpenTerminal or any client to poll.
// Endpoints (GET):
//   /api/health   service status, uptime, last gold scan, signal counts (never requires auth)
//   /api/gold     latest PAXG/XAUt DEX price vs spot gold snapshot
//   /api/whales   latest whale buy signals      (?limit=1..200, default 50)
//   /api/pools    latest new-pool signals with safety verdicts (?limit=1..200, default 50)
// Auth: if API_TOKEN is set, every /api/* route except /api/health needs "Authorization: Bearer <API_TOKEN>".
// CORS: allows https://openterminal-ashen.vercel.app, any http://localhost or http://127.0.0.1 origin, and API_CORS_ORIGINS.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './logger.js';
import { WATCHLIST } from './wallets.js';
import { countSignals, getGoldSnapshot, listSignals, startedAt } from './store.js';
import { engineState } from './engine/state.js';
import { ledgerTail } from './engine/ledger.js';
import { loadStrategies } from './strategies/registry.js';
import { KILL_FILE } from './engine/risk.js';

const here = dirname(fileURLToPath(import.meta.url));
const DECK_DIR = join(here, '..', 'deck');
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const API_VERSION = '1';
const DEFAULT_CORS_ORIGINS = ['https://openterminal-ashen.vercel.app'];
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const ALLOWED_ORIGINS = new Set([...DEFAULT_CORS_ORIGINS, ...config.api.corsOrigins]);

function corsHeaders(origin: string | undefined): Record<string, string> {
  const h: Record<string, string> = { vary: 'Origin' };
  if (origin && (ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin))) {
    h['access-control-allow-origin'] = origin;
  }
  return h;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage): boolean {
  if (!config.api.token) return true;
  return req.headers.authorization === `Bearer ${config.api.token}`;
}

function parseLimit(raw: string | null): number {
  const n = Number(raw ?? 50);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(Math.floor(n), 1), 200);
}

function health() {
  const gold = getGoldSnapshot();
  return {
    status: 'ok',
    service: 'crypto-tracker',
    apiVersion: API_VERSION,
    startedAt,
    now: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    chains: ['base', 'ethereum'],
    watchedWallets: WATCHLIST.length,
    authRequired: Boolean(config.api.token),
    gold: {
      attemptedAt: gold.attemptedAt,
      updatedAt: gold.updatedAt,
      assets: gold.quotes.length,
      pollMs: config.gold.pollMs,
    },
    signals: countSignals(),
  };
}

function goldPayload() {
  const gold = getGoldSnapshot();
  const ageMs = gold.updatedAt ? Date.now() - Date.parse(gold.updatedAt) : null;
  return {
    attemptedAt: gold.attemptedAt,
    updatedAt: gold.updatedAt,
    stale: ageMs === null || ageMs > config.gold.pollMs * 3,
    thresholds: { alertPct: config.gold.alertPct, majorPct: config.gold.majorPct },
    assets: gold.quotes,
  };
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const cors = corsHeaders(req.headers.origin);
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...cors,
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '600',
    });
    return res.end();
  }
  if (req.method === 'POST' && url.pathname === '/api/engine/kill') {
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' }, cors);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(KILL_FILE, `killed ${new Date().toISOString()}\n`);
    logger.warn('KILL file written via API, engine will block all entries');
    return send(res, 200, { killed: true }, cors);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { error: 'method not allowed' }, { ...cors, allow: 'GET, POST, OPTIONS' });
  }
  if (url.pathname === '/api/health') return send(res, 200, health(), cors);

  // Trading deck static files: /deck and /deck/* from ./deck
  if (url.pathname === '/deck' || url.pathname.startsWith('/deck/')) {
    const rel = url.pathname === '/deck' || url.pathname === '/deck/' ? 'index.html' : url.pathname.slice('/deck/'.length);
    const file = join(DECK_DIR, rel.split('?')[0]);
    if (!file.startsWith(DECK_DIR) || !existsSync(file)) return send(res, 404, { error: 'not found' }, cors);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': `${MIME[ext] ?? 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-store', ...cors });
    return res.end(await readFile(file));
  }

  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' }, cors);
  if (!authorized(req)) return send(res, 401, { error: 'unauthorized' }, cors);

  switch (url.pathname) {
    case '/api/gold':
      return send(res, 200, goldPayload(), cors);
    case '/api/whales': {
      const signals = listSignals('whale_buy', parseLimit(url.searchParams.get('limit')));
      return send(res, 200, { count: signals.length, signals }, cors);
    }
    case '/api/pools': {
      const signals = listSignals('new_pool', parseLimit(url.searchParams.get('limit')));
      return send(res, 200, { count: signals.length, signals }, cors);
    }
    case '/api/engine/snapshot':
      return send(res, 200, engineState.snapshot ?? { empty: true }, cors);
    case '/api/engine/strategies':
      return send(res, 200, loadStrategies().map(({ strategy, params, enabled }) => ({ name: strategy.name, description: strategy.description, params, enabled })), cors);
    case '/api/engine/decisions': {
      const n = parseLimit(url.searchParams.get('limit'));
      return send(res, 200, engineState.decisions.slice(0, n), cors);
    }
    case '/api/engine/ledger':
      return send(res, 200, ledgerTail(parseLimit(url.searchParams.get('limit'))), cors);
    case '/api/engine/candles': {
      const sym = (url.searchParams.get('symbol') ?? 'BTCUSDT').toUpperCase();
      const { getFeed } = await import('./engine/market.js');
      const feed = getFeed(sym);
      return send(res, 200, feed ? { symbol: sym, source: feed.source, lastFetch: feed.lastFetch, candles: feed.candles } : { symbol: sym, candles: [] }, cors);
    }
    default:
      return send(res, 404, { error: 'not found' }, cors);
  }
}

export function startApi(): Server | null {
  if (!config.api.enabled) {
    logger.info('API disabled (API_ENABLED=false)');
    return null;
  }
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error({ err: String(err) }, 'api request failed');
      if (!res.headersSent) send(res, 500, { error: 'internal error' }, {});
    });
  });
  server.on('error', (err) => logger.error({ err: String(err) }, 'api server error'));
  server.listen(config.api.port, config.api.host, () => {
    logger.info({ host: config.api.host, port: config.api.port, auth: Boolean(config.api.token) }, 'API listening');
  });
  return server;
}
