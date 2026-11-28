import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the browser runtime without bootstrap/network or a graphics environment.
const source = readFileSync(new URL('../deck/app.js', import.meta.url), 'utf8').split('updateMotion();\nwindow.STATE')[0];
function runtime(fetch = async () => ({ ok: true, json: async () => ({}) }), hosted = false) {
  const elements = new Map();
  const element = () => ({ textContent: '', innerHTML: '', children: [], dataset: {},
    style: {},
    replaceChildren(...children) { this.children = children; },
    classList: { toggle() {}, add() {}, remove() {} }, querySelector: () => element(), addEventListener() {}, setAttribute() {}, getAnimations: () => [],
  });
  const body = element();
  const context = vm.createContext({
    console, fetch, AbortSignal, document: { hidden: true, body, createElement: element, addEventListener() {}, querySelectorAll: () => [],
      getElementById: (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, querySelector: element,
    }, window: { DECK_DEMO_FALLBACK: hosted, addEventListener() {} }, sessionStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }), IntersectionObserver: class { observe() {} },
    requestAnimationFrame() {}, setInterval() {}, prompt: () => null,
  });
  vm.runInContext(source, context);
  return { run: (code) => vm.runInContext(code, context), context, elements };
}

test('cancelled token prompt terminates concurrent unauthorized requests without retrying', async () => {
  let requests = 0, prompts = 0;
  const app = runtime(async () => { requests++; return { status: 401, ok: false }; });
  app.context.prompt = () => { prompts++; return null; };
  const results = await app.run('Promise.allSettled([api("/one"), api("/two")])');
  assert.equal(requests, 2);
  assert.equal(prompts, 1);
  assert.ok(results.every((r) => r.status === 'rejected'));
});

test('late market response cannot overwrite the newer selection or its candles', async () => {
  let resolveOld;
  const old = new Promise((resolve) => { resolveOld = resolve; });
  let generation = 'old';
  const app = runtime(async (path) => {
    const data = path.includes('candles') ? { candles: [{ c: generation === 'old' ? 10 : 20 }] }
      : path.includes('snapshot') ? { equityUsd: generation === 'old' ? 100 : 200 }
      : path.includes('strategies') || path.includes('decisions') ? [] : {};
    if (generation === 'old') await old;
    return { ok: true, json: async () => data };
  });
  app.run('renderStatic = () => {};');
  const earlier = app.run('refresh()');
  generation = 'new';
  await app.run('STATE.sym = "ETHUSDT"; refresh()');
  resolveOld(); await earlier;
  assert.equal(app.run('STATE.snap.equityUsd'), 200);
  assert.equal(app.run('STATE.candles.ETHUSDT[0].c'), 20);
  assert.equal(app.run('STATE.candles.BTCUSDT'), undefined);
});

test('hidden and paused frames do not advance visual time', () => {
  const app = runtime();
  app.run('frame(1000)');
  assert.equal(app.run('visualTime'), 0);
  app.run('document.hidden = false; motionPaused = true; frame(1040)');
  assert.equal(app.run('visualTime'), 0);
  app.run('motionPaused = false; frame(1080)');
  assert.equal(app.run('visualTime'), 40);
});

test('connected deck distinguishes unavailable monitors from zero activity', async () => {
  const app = runtime(async (path) => ({ ok: true, json: async () => {
    if (path.startsWith('/api/whales')) return { count: 0, available: false };
    if (path.startsWith('/api/pools')) return { count: 0 };
    if (path.includes('/snapshot')) return { positions: [], equityCurve: [] };
    if (path.includes('/strategies') || path.includes('/decisions')) return [];
    return {};
  } }));
  await app.run('refresh()');
  assert.equal(app.elements.get('connection').textContent, 'CONNECTED');
  assert.match(app.elements.get('wireMsg').textContent, /whale signals unavailable · new pools 0/);
});

test('slow redraw never invokes offscreen chart or book work', () => {
  const app = runtime();
  app.run('document.hidden = false; drawNavChart = drawWeights = drawRotation = drawPricer = drawMembrane = drawTape = drawBook = () => { throw new Error("offscreen drawing"); };');
  assert.doesNotThrow(() => app.run('drawSlow()'));
});

test('paused depth stays stable across refreshes while real price updates remain visible', () => {
  const app = runtime();
  const rows = Array.from({ length: 18 }, () => ({ children: [{}, {}, { style: {} }] }));
  const mid = {};
  app.elements.set('orderBook', { children: rows, querySelectorAll: () => rows, querySelector: () => mid });
  app.run('motionPaused = true; STATE.candles.BTCUSDT = [{ c: 100 }]; drawBook(1000)');
  const snapshot = JSON.stringify(rows);
  app.run('drawBook(2000)');
  assert.equal(JSON.stringify(rows), snapshot);
  app.run('STATE.candles.BTCUSDT[0].c = 110; drawBook(3000)');
  assert.notEqual(JSON.stringify(rows), snapshot);
  assert.ok(mid.textContent.includes('110'));
});

test('first empty snapshot explains startup and disables stop until the engine reports state', () => {
  const app = runtime();
  app.run('renderStatic()');
  assert.equal(app.elements.get('kill').disabled, true);
  assert.match(app.elements.get('wireMsg').textContent, /first snapshot/i);
  assert.match(app.elements.get('marketRail').innerHTML, /waiting/i);
  assert.match(app.elements.get('cortexList').innerHTML, /waiting/i);
});

test('successful polls label cached candles by market fetch time and clear the warning on recovery', async () => {
  let fetchedAt = Date.now() - 360_000;
  let snapshot, candles;
  const app = runtime(async (path) => ({ ok: true, json: async () =>
    path.includes('snapshot') ? snapshot : path.includes('candles') ? { candles, lastFetch: fetchedAt }
      : path.includes('strategies') || path.includes('decisions') ? [] : {} }));
  app.run('loadDemo(); demoMode = false');
  snapshot = app.run('STATE.snap');
  candles = [{ t: Date.now() - 60_000, o: 100, h: 102, l: 99, c: 101, v: 20 },
    { t: Date.now(), o: 101, h: 103, l: 100, c: 102, v: 22 }];
  await app.run('refresh()');
  assert.match(app.elements.get('bigPriceSub').innerHTML, /CACHED.*last market fetch/);
  assert.match(app.elements.get('wireMsg').textContent, /CACHED QUOTES/);
  assert.equal(app.elements.get('connection').textContent, 'CONNECTED');
  fetchedAt = Date.now() - 120_000;
  await app.run('refresh()');
  assert.doesNotMatch(app.elements.get('bigPriceSub').innerHTML, /CACHED/);
  fetchedAt = Date.now();
  await app.run('refresh()');
  assert.doesNotMatch(app.elements.get('bigPriceSub').innerHTML, /CACHED/);
  assert.match(app.elements.get('bigPriceSub').innerHTML, /last market fetch/);
  assert.doesNotMatch(app.elements.get('wireMsg').textContent, /CACHED QUOTES/);
  const btcFetch = app.run('STATE.marketAt.BTCUSDT');
  fetchedAt = undefined;
  await app.run('STATE.sym = "ETHUSDT"; refresh()');
  assert.match(app.elements.get('bigPriceSub').innerHTML, /FETCH TIME UNKNOWN/);
  assert.equal(app.run('STATE.marketAt.BTCUSDT'), btcFetch);
  app.run('demoMode = true; loadDemo(); renderStatic()');
  assert.equal(app.elements.get('bigPrice').textContent, '—');
  assert.equal(app.run('Object.keys(STATE.candles).length'), 0);
});

test('agent focus toggles off and ignores names not present in the graph', () => {
  const app = runtime();
  app.run('drawBrain = () => {}; selectAgent("SPOTTER")');
  assert.equal(app.run('selectedAgent'), 'SPOTTER');
  app.run('selectAgent("not-an-agent")');
  assert.equal(app.run('selectedAgent'), 'SPOTTER');
  app.run('selectAgent("SPOTTER")');
  assert.equal(app.run('selectedAgent'), null);
});

test('paused simulation tracks new candle inputs but keeps identical inputs stable', () => {
  const app = runtime();
  app.context.devicePixelRatio = 1;
  app.elements.set('pricer', { clientWidth: 400, clientHeight: 150, getContext: () => new Proxy({}, { get: () => () => {} }) });
  app.run('motionPaused = true; STATE.candles.BTCUSDT = [{ c: 100 }, { c: 101 }]; drawPricer(0)');
  const paths = app.run('JSON.stringify(mcPaths)');
  app.run('drawPricer(2000)');
  assert.equal(app.run('JSON.stringify(mcPaths)'), paths);
  app.run('STATE.candles.BTCUSDT.push({ c: 103 }); drawPricer(3000)');
  assert.equal(app.run('mcPaths[0][0]'), 103);
});

test('successful stop acknowledgement stays disabled while waiting for a snapshot', async () => {
  const app = runtime(async () => ({ ok: true, json: async () => ({ killed: true }) }));
  app.context.confirm = () => true;
  app.run('STATE.snap = { killed: false }; refresh = async () => {};');
  await app.elements.get('kill').onclick();
  assert.equal(app.elements.get('kill').disabled, true);
  assert.equal(app.elements.get('kill').textContent, 'Engine stopped');
});

test('a fresh running snapshot after restart clears the optimistic stop acknowledgement', async () => {
  const app = runtime(async () => ({ ok: true, json: async () => ({ killed: true }) }));
  app.context.confirm = () => true;
  app.run('STATE.snap = { killed: false }; refresh = async () => { STATE.snap = { killed: false }; };');
  await app.elements.get('kill').onclick();
  assert.equal(app.elements.get('kill').disabled, false);
  assert.equal(app.elements.get('kill').textContent, 'Stop engine');
});

test('market denominations follow the configured symbol suffix', () => {
  const app = runtime();
  assert.equal(app.run('marketQuote("BTCUSD")'), 'USD');
  assert.equal(app.run('marketQuote("ETHUSDT")'), 'USDT');
});

test('hosted fallback is labeled, cannot stop an engine, and fully clears before live state', async () => {
  let offline = true;
  const app = runtime(async (path) => offline ? { ok: false, status: 503 } : { ok: true, json: async () =>
    path.includes('snapshot') ? { empty: true } : path.includes('strategies') || path.includes('decisions') ? [] : {} });
  app.context.window.DECK_DEMO_FALLBACK = true;
  app.run('renderStatic = () => {};');
  await app.run('refresh()');
  assert.equal(app.run('demoMode'), true);
  assert.equal(app.elements.get('demoBanner').hidden, false);
  assert.equal(app.elements.get('connection').textContent, 'DEMO');
  assert.equal(app.run('Object.keys(STATE.candles).length'), 0);
  app.context.confirm = () => { throw new Error('Demo must not open stop confirmation'); };
  await app.elements.get('kill').onclick();
  offline = false;
  await app.run('refresh()');
  assert.equal(app.run('demoMode'), false);
  assert.equal(app.run('STATE.snap'), null);
  assert.equal(app.run('Object.keys(STATE.candles).length'), 0);
  assert.equal(app.elements.get('demoBanner').hidden, true);
});

test('public exchange prices replace generated markets while the portfolio stays demo', async () => {
  const candles = [{ t: Date.now() - 60_000, o: 75000, h: 75100, l: 74900, c: 75000, v: 10 },
    { t: Date.now(), o: 75000, h: 75200, l: 74900, c: 75123.45, v: 12 }];
  let calls = 0;
  const app = runtime(async (path) => {
    if (path !== '/api/market') return { ok: false, status: 503 };
    calls++;
    return { ok: true, json: async () => ({ markets: { BTCUSDT: {
      price: 75123.45, candles, source: 'coinbase', quote: 'USD', lastFetch: Date.now(),
    } } }) };
  }, true);
  await app.run('refresh()');
  assert.equal(app.run('demoMode'), true);
  assert.equal(app.run('marketPrices().BTCUSDT'), 75123.45);
  assert.equal(app.run('STATE.snap.prices.BTCUSDT'), undefined);
  assert.equal(app.run('STATE.candles.BTCUSDT.at(-1).c'), 75123.45);
  assert.match(app.elements.get('demoBanner').textContent, /LIVE MARKET DATA.*DEMO PORTFOLIO & TRADES/);
  assert.match(app.elements.get('bigPriceSub').innerHTML, /COINBASE · USD · 1m/);
  assert.equal(app.elements.get('tapeSym').textContent, 'BTCUSD');
  assert.equal(app.elements.get('kill').disabled, true);
  await app.run('refresh()');
  assert.equal(calls, 1, 'repeated engine failures must not hammer the market endpoint');
  assert.equal(app.run('STATE.candles.BTCUSDT.at(-1).c'), 75123.45);
});

test('market outages retain last real prices as cached, never regenerate candles', async () => {
  let offline = false;
  const app = runtime(async (path) => path === '/api/market' && !offline ? {
    ok: true, json: async () => ({ markets: { BTCUSDT: {
      price: 42000, source: 'kraken', quote: 'USD', lastFetch: Date.now(),
      candles: [{ t: Date.now() - 60_000, c: 41900 }, { t: Date.now(), c: 42000 }],
    } } }),
  } : { ok: false, status: 503 }, true);
  await app.run('refresh()');
  offline = true;
  await app.run('marketRequestedAt = 0; refreshPublicMarkets()');
  assert.equal(app.run('marketPrices().BTCUSDT'), 42000);
  assert.match(app.elements.get('demoBanner').textContent, /CACHED MARKET DATA/);
  assert.match(app.elements.get('bigPriceSub').innerHTML, /CACHED.*KRAKEN/);
  offline = false;
  await app.run('marketRequestedAt = 0; refreshPublicMarkets()');
  assert.match(app.elements.get('demoBanner').textContent, /LIVE MARKET DATA/);
  assert.doesNotMatch(app.elements.get('bigPriceSub').innerHTML, /CACHED/);

  const empty = runtime(async () => ({ ok: false, status: 503 }), true);
  await empty.run('refresh()');
  assert.equal(empty.elements.get('bigPrice').textContent, '—');
  assert.equal(empty.run('Object.keys(STATE.candles).length'), 0);
  assert.match(empty.elements.get('demoBanner').textContent, /MARKET DATA UNAVAILABLE/);
});

test('unavailable demo markets clear the prior market directional bias', () => {
  const app = runtime();
  app.run(`demoMode = true;
    STATE.publicMarkets.BTCUSDT = { price: 100, quote: 'USD', source: 'coinbase', lastFetch: Date.now(), failed: false,
      candles: Array.from({ length: 35 }, (_, i) => ({ t: Date.now() - (34 - i) * 60_000, o: 95 + i, h: 96 + i, l: 94 + i, c: 95 + i, v: 10 })) };
    loadDemo(); renderStatic()`);
  assert.match(app.elements.get('biasTxt').textContent, /up.*dn/);
  app.run('STATE.sym = "ADAUSDT"; renderStatic()');
  assert.equal(app.elements.get('biasTxt').textContent, '—');
  assert.equal(app.elements.get('biasUp').style.width, '0%');
  assert.equal(app.elements.get('biasDn').style.width, '0%');
});

test('partial public market responses mark only omitted quotes as cached', async () => {
  let partial = false;
  const candles = [{ t: Date.now() - 60_000, c: 99 }, { t: Date.now(), c: 100 }];
  const feed = (price) => ({ price, quote: 'USDT', source: 'binance', lastFetch: Date.now(), candles });
  const app = runtime(async (path) => path === '/api/market' ? {
    ok: true, json: async () => ({ markets: partial ? { BTCUSDT: feed(100) } : { BTCUSDT: feed(100), ADAUSDT: feed(1) } }),
  } : { ok: false, status: 503 }, true);
  await app.run('refresh()');
  assert.equal(app.run('publicMarketCached("BTCUSDT")'), false);
  assert.equal(app.run('publicMarketCached("ADAUSDT")'), false);
  partial = true;
  await app.run('marketRequestedAt = 0; refreshPublicMarkets()');
  assert.equal(app.run('publicMarketCached("BTCUSDT")'), false);
  assert.equal(app.run('publicMarketCached("ADAUSDT")'), true);
  assert.equal(app.run('STATE.publicMarkets.ADAUSDT.failed'), true);
});

test('hosted mode never hides an authorization failure behind demo data', async () => {
  const app = runtime(async () => ({ ok: false, status: 401 }), true);
  const stop = app.elements.get('kill');
  assert.equal(stop.disabled, true);
  assert.equal(stop.textContent, 'Hosted · read only');
  await app.run('refresh()');
  assert.equal(app.run('demoMode'), false);
  assert.equal(app.run('STATE.snap'), null);
  assert.equal(stop.disabled, true);
  assert.equal(stop.textContent, 'Hosted · read only');
});

test('hosted controls cannot send stop requests even when live state is available', async () => {
  const app = runtime(async () => { throw new Error('Hosted stop must not send a request'); });
  app.context.window.DECK_DEMO_FALLBACK = true;
  app.context.confirm = () => { throw new Error('Hosted stop must not open confirmation'); };
  app.run('STATE.snap = { killed: false };');
  await app.elements.get('kill').onclick();
});

test('warmup after generated data clears every displayed demo balance and count', () => {
  const app = runtime();
  app.run('loadDemo(); STATE.snap = null;');
  const metrics = ['sNav', 'sPnl', 'sWin', 'sOpen', 'bigNav', 'bigPrice', 'stTickets', 'stWin', 'stEdge', 'stDD', 'openTickets'];
  for (const id of metrics) app.elements.set(id, { textContent: '$demo', classList: { remove() {} } });
  app.run('renderStatic()');
  for (const id of metrics) assert.equal(app.elements.get(id).textContent, '—');
  assert.equal(app.elements.get('kill').disabled, true);
});

test('ledger halt overrides running, stop and startup labels, and clears after a healthy restart', async () => {
  let offline = false;
  let snapshot = { empty: true, halted: true };
  const app = runtime(async (path) => offline ? { ok: false, status: 503 } : { ok: true, json: async () => path.includes('snapshot') ? snapshot
    : path.includes('strategies') || path.includes('decisions') ? [] : {} });
  app.context.window.DECK_DEMO_FALLBACK = true;
  await app.run('refresh()');
  assert.equal(app.elements.get('connection').textContent, 'HALTED');
  assert.equal(app.elements.get('running').textContent, 'HALTED');
  assert.match(app.elements.get('wireMsg').textContent, /ledger.*restart/i);
  assert.equal(app.elements.get('kill').disabled, true);
  await app.elements.get('kill').onclick();
  offline = true;
  await app.run('refresh()');
  assert.equal(app.run('demoMode'), false);
  assert.equal(app.run('STATE.halted'), true);
  offline = false;
  app.elements.get('marketRail').dataset.symbols = 'BTCUSDT,ETHUSDT';
  app.run('loadDemo(); STATE.halted = true; STATE.snap.killed = true; renderStatic();');
  assert.equal(app.elements.get('running').textContent, 'HALTED');
  assert.match(app.elements.get('wireMsg').textContent, /HALTED/);
  assert.doesNotMatch(app.elements.get('wireMsg').textContent, /ONLINE|scanning|LIVE WIRE/);
  assert.equal(app.elements.get('marketRail').dataset.symbols, undefined);
  snapshot = { empty: true, halted: false };
  await app.run('refresh()');
  assert.equal(app.elements.get('connection').textContent, 'WARMING UP');
  assert.equal(app.elements.get('running').textContent, 'WARMING UP');
  delete snapshot.halted;
  await app.run('refresh()');
  assert.equal(app.elements.get('connection').textContent, 'WARMING UP');
});

test('halted canvases never present a previous NAV, a false zero or portfolio-derived charts', async () => {
  let snapshot;
  const app = runtime(async (path) => ({ ok: true, json: async () => path.includes('snapshot') ? snapshot
    : path.includes('strategies') || path.includes('decisions') ? [] : {} }));
  app.run('loadDemo()');
  snapshot = { ...app.run('STATE.snap'), halted: true };
  const texts = [];
  const drawing = new Proxy({}, { get: (_, key) => key === 'fillText' ? (s) => texts.push(s)
    : key.startsWith('create') ? () => ({ addColorStop() {} }) : () => {} });
  app.context.document.hidden = false;
  app.context.devicePixelRatio = 1;
  for (const id of ['navChart', 'weights', 'rotation', 'brain']) {
    app.elements.set(id, { clientWidth: 600, clientHeight: 320, getContext: () => drawing });
    app.run(`visibleCanvases.add('${id}')`);
  }
  await app.run('refresh()');
  assert.equal(app.run('STATE.snap'), null);
  assert.equal(texts.filter((s) => s.startsWith('ENGINE HALTED')).length, 3);
  assert.deepEqual(texts.filter((s) => s.startsWith('NAV ')), ['NAV —']);
});

test('engine-controlled text is escaped before insertion into HTML feeds', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const app = runtime();
  app.run(`loadDemo();
    STATE.snap.positions[0].strategy = ${JSON.stringify(payload)};
    STATE.decisions = [{ ...STATE.decisions[0], strategy: ${JSON.stringify(payload)}, reason: ${JSON.stringify(payload)} }];
    STATE.strats = [{ name: ${JSON.stringify(payload)}, enabled: true }];
    renderStatic()`);
  assert.match(app.elements.get('cortexList').innerHTML, /&lt;img/);
  assert.doesNotMatch(app.elements.get('cortexList').innerHTML, /<img/);
  assert.match(app.elements.get('thoughts').children[0].innerHTML, /&lt;img/);
  assert.doesNotMatch(app.elements.get('thoughts').children[0].innerHTML, /<img/);
  assert.match(app.elements.get('trace').children[0].innerHTML, /&lt;img/);
  assert.doesNotMatch(app.elements.get('trace').children[0].innerHTML, /<img/);
  assert.match(app.elements.get('rotLegend').innerHTML, /&lt;img/);
  assert.doesNotMatch(app.elements.get('rotLegend').innerHTML, /<img/);
});
