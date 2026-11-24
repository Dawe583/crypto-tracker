import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the browser runtime without bootstrap/network or a graphics environment.
const source = readFileSync(new URL('../deck/app.js', import.meta.url), 'utf8').split('updateMotion();\nwindow.STATE')[0];
function runtime(fetch = async () => ({ ok: true, json: async () => ({}) })) {
  const elements = new Map();
  const element = () => ({ textContent: '', innerHTML: '', children: [], dataset: {},
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
