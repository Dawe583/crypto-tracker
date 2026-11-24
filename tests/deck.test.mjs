import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the browser runtime without bootstrap/network or a graphics environment.
const source = readFileSync(new URL('../deck/app.js', import.meta.url), 'utf8').split('updateMotion();\nwindow.STATE')[0];
function runtime(fetch = async () => ({ ok: true, json: async () => ({}) })) {
  const elements = new Map();
  const element = () => ({ textContent: '', innerHTML: '', children: [], dataset: {},
    style: {},
    classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, setAttribute() {}, getAnimations: () => [],
  });
  const body = element();
  const context = vm.createContext({
    console, fetch, document: { hidden: true, body, addEventListener() {}, querySelectorAll: () => [],
      getElementById: (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, querySelector: element,
    }, window: { addEventListener() {} }, sessionStorage: { getItem: () => null, setItem() {} },
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
  assert.equal(app.run('STATE.candles.BTCUSDT.length'), 120);
  app.context.confirm = () => { throw new Error('Demo must not open stop confirmation'); };
  await app.elements.get('kill').onclick();
  offline = false;
  await app.run('refresh()');
  assert.equal(app.run('demoMode'), false);
  assert.equal(app.run('STATE.snap'), null);
  assert.equal(app.run('Object.keys(STATE.candles).length'), 0);
  assert.equal(app.elements.get('demoBanner').hidden, true);
});

test('hosted mode never hides an authorization failure behind demo data', async () => {
  const app = runtime(async () => ({ ok: false, status: 401 }));
  app.context.window.DECK_DEMO_FALLBACK = true;
  await app.run('refresh()');
  assert.equal(app.run('demoMode'), false);
  assert.equal(app.run('STATE.snap'), null);
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
  let snapshot = { empty: true, halted: true };
  const app = runtime(async (path) => ({ ok: true, json: async () => path.includes('snapshot') ? snapshot
    : path.includes('strategies') || path.includes('decisions') ? [] : {} }));
  await app.run('refresh()');
  assert.equal(app.elements.get('connection').textContent, 'HALTED');
  assert.equal(app.elements.get('running').textContent, 'HALTED');
  assert.match(app.elements.get('wireMsg').textContent, /ledger.*restart/i);
  assert.equal(app.elements.get('kill').disabled, true);
  app.run('loadDemo(); STATE.halted = true; STATE.snap.killed = true; renderStatic();');
  assert.equal(app.elements.get('running').textContent, 'HALTED');
  assert.match(app.elements.get('wireMsg').textContent, /HALTED/);
  assert.doesNotMatch(app.elements.get('wireMsg').textContent, /ONLINE|scanning|LIVE WIRE/);
  snapshot = { empty: true, halted: false };
  await app.run('refresh()');
  assert.equal(app.elements.get('connection').textContent, 'WARMING UP');
  assert.equal(app.elements.get('running').textContent, 'WARMING UP');
  delete snapshot.halted;
  await app.run('refresh()');
  assert.equal(app.elements.get('connection').textContent, 'WARMING UP');
});
