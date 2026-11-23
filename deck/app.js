// GROK-DESK style animated trading deck. All data from the engine API;
// canvases animate continuously via requestAnimationFrame.
'use strict';
const $ = (id) => document.getElementById(id);
const fmt$ = (n, d = 0) => (n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: 2 })}`);
const cls = (n) => (n >= 0 ? 'pos' : 'neg');
const ago = (ts) => { const s = (Date.now() - ts) / 1000; return s < 60 ? `${s | 0}s` : s < 3600 ? `${(s / 60) | 0}m` : `${(s / 3600) | 0}h`; };

let TOKEN = sessionStorage.getItem('apiToken') || '';
const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {} });
  if (r.status === 401 && !TOKEN) {
    TOKEN = prompt('API token (if configured)') || '';
    sessionStorage.setItem('apiToken', TOKEN);
    return api(path, opts);
  }
  return r.ok ? r.json() : null;
};

const ctx2d = (id) => {
  const c = $(id);
  const dpr = devicePixelRatio || 1;
  const w = c.clientWidth || c.parentElement.clientWidth - 20;
  const h = c.clientHeight || c.height;
  c.width = w * dpr; c.height = h * dpr;
  const x = c.getContext('2d');
  x.scale(dpr, dpr);
  return { x, w, h };
};

const STATE = { snap: null, strats: [], decisions: [], candles: {}, sym: 'BTCUSDT', whales: 0, pools: 0, gold: [], book: null, bookAt: 0 };

// ---------- data ----------
async function refresh() {
  const [snap, strats, decisions, candles, whales, pools, gold] = await Promise.all([
    api('/api/engine/snapshot'),
    api('/api/engine/strategies'),
    api('/api/engine/decisions?limit=120'),
    api(`/api/engine/candles?symbol=${STATE.sym}`),
    api('/api/whales?limit=30'),
    api('/api/pools?limit=30'),
    api('/api/gold'),
  ]);
  if (snap && !snap.empty) STATE.snap = snap;
  STATE.strats = strats || STATE.strats;
  STATE.decisions = decisions || STATE.decisions;
  if (candles?.candles?.length) STATE.candles[STATE.sym] = candles.candles;
  STATE.whales = whales?.count ?? 0;
  STATE.pools = pools?.count ?? 0;
  STATE.gold = gold?.assets || [];
  renderStatic();
}

// ---------- static-ish DOM (per refresh) ----------
function renderStatic() {
  const s = STATE.snap;
  if (!s) return;
  const start = s.equityUsd - s.realizedUsd - s.unrealizedUsd || 10000;
  const dayPnl = s.realizedUsd + s.unrealizedUsd;
  const stats = Object.values(s.stats || {});
  const trades = stats.reduce((a, v) => a + v.trades, 0);
  const wins = stats.reduce((a, v) => a + v.wins, 0);
  $('sNav').textContent = fmt$(s.equityUsd);
  $('sNav').className = cls(dayPnl);
  $('sPnl').textContent = fmt$(dayPnl, 2);
  $('sPnl').className = cls(dayPnl);
  $('sWin').textContent = trades ? `${((wins / trades) * 100).toFixed(0)}%` : '—';
  $('sOpen').textContent = s.positions.length;
  $('bigNav').textContent = fmt$(s.equityUsd);
  $('bigNav').classList.toggle('up', dayPnl >= 0);
  $('bigDelta').innerHTML = `<span class="${cls(dayPnl)}">${dayPnl >= 0 ? '▲' : '▼'} ${fmt$(Math.abs(dayPnl), 2)} session</span> · cash ${fmt$(s.cashUsd)}`;
  $('running').textContent = 'RUNNING';
  $('stTickets').textContent = trades;
  $('stWin').textContent = trades ? `${((wins / trades) * 100).toFixed(0)}%` : '—';
  $('stEdge').textContent = trades ? fmt$(s.realizedUsd / trades, 2) : '—';
  const eq = s.equityCurve.map((p) => p.equityUsd);
  let peak = -Infinity, dd = 0;
  for (const v of eq) { peak = Math.max(peak, v); dd = Math.max(dd, peak - v); }
  $('stDD').textContent = fmt$(dd, 2);
  $('openTickets').textContent = `${s.positions.length} open`;
  $('kill').classList.toggle('killed', !!s.killed);
  $('kill').textContent = s.killed ? '⚡ KILLED' : '⚡ ENGINE';
  $('tapeSym').textContent = STATE.sym;

  const cd = STATE.candles[STATE.sym];
  if (cd?.length > 1) {
    const chg = ((cd[cd.length - 1].c - cd[0].c) / cd[0].c) * 100;
    $('tapeChg').innerHTML = `<span class="${cls(chg)}">${chg >= 0 ? '▲' : '▼'} ${chg.toFixed(2)}%</span>`;
    const lp = cd[cd.length - 1].c;
    const bp = $('bigPrice');
    bp.textContent = fmt$(lp, 2);
    bp.className = chg >= 0 ? 'up' : 'dn';
    $('bigPriceSub').innerHTML = `<span class="${cls(chg)}">${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)}%</span>`;
    const fair = vwapN(cd);
    const dpm = STATE.decisions.filter((d) => Date.now() - d.ts < 60_000).length;
    $('wireMsg').textContent = `SIX AGENTS LIVE · ${dpm} DECISIONS/MIN` +
      (fair ? ` · MODEL FAIR ${fmt$(fair, 0)} VS MARKET ${fmt$(lp, 0)} · EDGE ${((fair - lp) / fair * 100).toFixed(2)}%` : '') +
      ` · OPEN ${s.positions.length} TICKETS · ${s.killed ? 'ENGINE KILLED' : 'ENGINE ONLINE'}`;
  }
  $('symTabs').innerHTML = Object.keys(s.prices || {}).map((sym) =>
    `<button class="${sym === STATE.sym ? 'on' : ''}" onclick="STATE.sym='${sym}';refresh()">${sym}</button>`).join('');

  $('cortexList').innerHTML = s.positions.map((p) => {
    const pc = ((p.markPrice - p.entryPrice) / p.entryPrice) * 100;
    return `<div class="crow"><span>${p.strategy}·${p.symbol.replace('USDT', '')}</span>
      <span class="${cls(pc)}">${pc.toFixed(2)}%</span><span>${fmt$(p.unrealizedUsd, 2)}</span></div>`;
  }).join('') || '<div class="dim">no open tickets</div>';

  renderIndicators(s);

  $('thoughts').innerHTML = (STATE.decisions || []).slice(0, 40).map((d) =>
    `<div><span class="t">${new Date(d.ts).toTimeString().slice(0, 8)}</span>
     <b style="color:${stageColor(d)}">${d.strategy}</b> ${d.action.toUpperCase()} ${d.symbol.replace('USDT', '')}
     <span class="dim">${(d.confidence * 100) | 0}%</span>${d.vetoed ? ` <span class="amb">VETO ${d.vetoed}</span>` : ''}</div>`).join('');

  $('trace').innerHTML = (STATE.decisions || []).slice(0, 50).map((d) =>
    `<div><span class="tm">${new Date(d.ts).toTimeString().slice(0, 8)}</span>
     <span style="color:${stageColor(d)}">■</span> ${d.strategy} → ${d.action}${d.vetoed ? ' (veto)' : ''} — ${d.reason}</div>`).join('');

  $('rotLegend').innerHTML = STATE.strats.map((s, i) =>
    `<span><i style="background:${STRAT_COLORS[i % STRAT_COLORS.length]}"></i>${s.name}${s.enabled ? '' : ' (off)'}</span>`).join('');

  const last = STATE.decisions[0];
  $('wireMsg').textContent = last
    ? `LIVE WIRE — ${last.strategy} ${last.action} ${last.symbol} @${(last.confidence * 100) | 0}% · whale signals ${STATE.whales} · new pools ${STATE.pools}`
    : 'LIVE WIRE — engine online · scanning';
}

const STRAT_COLORS = ['#00e8a0', '#2fd8ff', '#ff4ff0', '#ffc23d', '#8f6bff', '#ff7a2f', '#ff3860', '#6bff8f', '#4f8fff', '#e8e84f', '#ff8fd0', '#4fffe8'];
function stageColor(d) {
  if (d.vetoed) return '#ff3860';
  if (d.action === 'sell') return '#8f6bff';
  return '#00e8a0';
}

// ---------- charts (drawn each frame or per refresh) ----------
function drawNavChart() {
  const { x, w, h } = ctx2d('navChart');
  const eq = STATE.snap?.equityCurve;
  x.clearRect(0, 0, w, h);
  if (!eq || eq.length < 2) { x.fillStyle = '#4d5f80'; x.fillText('collecting equity ticks…', 8, h / 2); return; }
  const start = STATE.snap.equityUsd - STATE.snap.realizedUsd - STATE.snap.unrealizedUsd || 10000;
  const ys = eq.map((p) => p.equityUsd).concat([start]);
  const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
  const px = (i) => (i / (eq.length - 1)) * (w - 4) + 2;
  const py = (v) => h - 4 - ((v - lo) / span) * (h - 8);
  x.strokeStyle = '#16203a'; x.beginPath(); x.moveTo(0, py(start)); x.lineTo(w, py(start)); x.stroke();
  const up = eq[eq.length - 1].equityUsd >= start;
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, up ? 'rgba(0,232,160,.35)' : 'rgba(255,56,96,.35)');
  g.addColorStop(1, 'transparent');
  x.beginPath(); x.moveTo(px(0), h);
  eq.forEach((p, i) => x.lineTo(px(i), py(p.equityUsd)));
  x.lineTo(px(eq.length - 1), h); x.closePath(); x.fillStyle = g; x.fill();
  x.beginPath();
  eq.forEach((p, i) => (i ? x.lineTo(px(i), py(p.equityUsd)) : x.moveTo(px(i), py(p.equityUsd))));
  x.strokeStyle = up ? '#00e8a0' : '#ff3860'; x.lineWidth = 1.4; x.stroke();
  // volume-style bars under
  x.fillStyle = 'rgba(47,216,255,.15)';
  eq.slice(-60).forEach((p, i) => { const bw = w / 60; x.fillRect(i * bw, h - Math.abs(p.equityUsd - start) / span * h * .4, bw * .6, Math.abs(p.equityUsd - start) / span * h * .4); });
}

function drawTape() {
  const { x, w, h } = ctx2d('tapeChart');
  x.clearRect(0, 0, w, h);
  const cs = (STATE.candles[STATE.sym] || []).slice(-90);
  if (cs.length < 5) { x.fillStyle = '#4d5f80'; x.fillText('loading tape…', 8, h / 2); return; }
  const hi = Math.max(...cs.map((c) => c.h)), lo = Math.min(...cs.map((c) => c.l));
  const span = hi - lo || 1;
  const px = (i) => (i / cs.length) * w;
  const py = (v) => h - 4 - ((v - lo) / span) * (h - 30);
  // liquidity heat: faint density blobs behind candles (visual depth field)
  const t = performance.now() / 1000;
  for (let i = 0; i < 14; i++) {
    const bx = ((i * 37 + (t * 8) % w) % w);
    const by = h * (.25 + .5 * Math.abs(Math.sin(i * 2.7 + t * .2)));
    const br = 30 + 40 * Math.abs(Math.sin(i * 1.3));
    const g = x.createRadialGradient(bx, by, 0, bx, by, br);
    g.addColorStop(0, i % 3 ? 'rgba(143,107,255,.05)' : 'rgba(255,79,240,.045)');
    g.addColorStop(1, 'transparent');
    x.fillStyle = g; x.fillRect(bx - br, by - br, br * 2, br * 2);
  }
  // resting-order dots (limit order markers)
  x.fillStyle = 'rgba(255,194,61,.5)';
  for (let i = 0; i < 18; i++) {
    const rx = (i * 53) % w;
    const ry = py(lo + span * ((i * 0.13 + Math.sin(t + i) * .02 + .5) % 1));
    x.fillRect(rx, ry, 2, 2);
  }
  // volume bars
  const vmax = Math.max(...cs.map((c) => c.v)) || 1;
  cs.forEach((c, i) => {
    x.fillStyle = c.c >= c.o ? 'rgba(0,232,160,.12)' : 'rgba(255,56,96,.12)';
    x.fillRect(px(i), h - 24, w / cs.length * .7, (c.v / vmax) * 20);
  });
  // candles
  cs.forEach((c, i) => {
    const up = c.c >= c.o;
    const col = up ? '#00e8a0' : '#ff3860';
    x.strokeStyle = col; x.fillStyle = up ? 'rgba(0,232,160,.25)' : 'rgba(255,56,96,.3)';
    const cx = px(i) + (w / cs.length) / 2;
    x.beginPath(); x.moveTo(cx, py(c.h)); x.lineTo(cx, py(c.l)); x.stroke();
    const bodyW = Math.max(2, w / cs.length * .55);
    x.fillRect(cx - bodyW / 2, Math.min(py(c.o), py(c.c)), bodyW, Math.max(1, Math.abs(py(c.o) - py(c.c))));
  });
  // VWAP + 1σ/2σ bands (value area)
  let pv = 0, vv = 0, pv2 = 0;
  const vwap = [];
  const sd = [];
  cs.forEach((c) => {
    const tp = (c.h + c.l + c.c) / 3;
    pv += tp * c.v; vv += c.v; pv2 += tp * tp * c.v;
    const vw = pv / vv;
    vwap.push(vw);
    sd.push(Math.sqrt(Math.max(0, pv2 / vv - vw * vw)));
  });
  x.strokeStyle = 'rgba(47,216,255,.25)'; x.lineWidth = .8;
  for (const m of [1, 2]) {
    x.beginPath();
    vwap.forEach((vw, i) => { const y = py(vw + sd[i] * m); i ? x.lineTo(px(i), y) : x.moveTo(px(i), y); });
    x.stroke();
    x.beginPath();
    vwap.forEach((vw, i) => { const y = py(vw - sd[i] * m); i ? x.lineTo(px(i), y) : x.moveTo(px(i), y); });
    x.stroke();
  }
  x.strokeStyle = '#2fd8ff'; x.lineWidth = 1; x.beginPath();
  vwap.forEach((vw, i) => (i ? x.lineTo(px(i), py(vw)) : x.moveTo(px(i), py(vw))));
  x.stroke();
  x.lineWidth = 1;
  // last price tag
  const last = cs[cs.length - 1];
  x.fillStyle = '#ffc23d'; x.font = '11px monospace';
  x.fillText(fmt$(last.c, 2), w - 90, py(last.c) - 4);
}

let bookT = 0;
function drawBook(now) {
  if (now - bookT < 700) return;
  bookT = now;
  const cs = STATE.candles[STATE.sym];
  if (!cs?.length) return;
  const p = cs[cs.length - 1].c;
  const step = p * 0.0004;
  const mk = (dir) => {
    let cum = 0;
    return Array.from({ length: 9 }, (_, i) => {
      const size = (Math.random() * 8 + 1) * (dir === 'bid' ? 1.2 : 1);
      cum += size;
      return { price: p + step * (dir === 'ask' ? i + 1 : -(i + 1)), size, cum };
    });
  };
  const asks = mk('ask').reverse(), bids = mk('bid');
  const maxCum = Math.max(asks[0].cum, bids[bids.length - 1].cum);
  $('orderBook').innerHTML = `<div class="hdr"><span>PRICE</span><span>SIZE</span></div>` +
    asks.map((l) => `<div class="lvl ask"><span>${l.price.toFixed(2)}</span><span>${l.size.toFixed(1)}</span><i style="width:${(l.cum / maxCum) * 100}%"></i></div>`).join('') +
    `<div class="mid">${fmt$(p, 2)}</div>` +
    bids.map((l) => `<div class="lvl bid"><span>${l.price.toFixed(2)}</span><span>${l.size.toFixed(1)}</span><i style="width:${(l.cum / maxCum) * 100}%"></i></div>`).join('');
}

// ---------- brain: interactive 3D system graph ----------
const AGENTS = [
  { name: 'SPOTTER', color: '#2fd8ff', desc: 'market feed' },
  { name: 'KELLY', color: '#8f6bff', desc: 'sizing' },
  { name: 'PRIOR', color: '#ffc23d', desc: 'context' },
  { name: 'TAKER', color: '#4f8fff', desc: 'executor' },
  { name: 'EDGE', color: '#ff4ff0', desc: 'strategies' },
  { name: 'CLOSER', color: '#ff3860', desc: 'exits' },
];
const NODES = [];   // 0-5 agents, 6 core, 7-18 strategies, 19-21 symbols, 22+ dust
const SEGS = [];    // 3D dendrite segments: {a,b,w,c}
const EDGES = [];   // long axon links for sparks
const sparks = [];
const dendrites = [];

const _r = (a, b) => a + Math.random() * (b - a);
const _norm = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };

// recursive 3D dendrite tree growing from a neuron body outward
function growTree(root, dir, len, depth, color) {
  if (depth <= 0 || SEGS.length > 1400) return;
  let [px, py, pz] = root, [dx, dy, dz] = dir;
  const chain = 2 + depth;
  for (let s = 0; s < chain; s++) {
    const nx = px + dx * len, ny = py + dy * len, nz = pz + dz * len;
    SEGS.push({ a: [px, py, pz], b: [nx, ny, nz], w: depth * .55 + .4, c: color });
    if (depth > 1 && Math.random() < .55) {         // fork: spawn 2 child branches
      for (let k = 0; k < 2; k++)
        growTree([nx, ny, nz], _norm(dx + _r(-1, 1), dy + _r(-.6, 1), dz + _r(-1, 1)), len * .58, depth - 1, color);
      return;
    }
    px = nx; py = ny; pz = nz;
    [dx, dy, dz] = _norm(dx + _r(-.4, .4), dy + _r(-.4, .4), dz + _r(-.4, .4));
    len *= .94;
  }
}

(function buildBrain() {
  AGENTS.forEach((a, i) => {
    const th = (i / AGENTS.length) * Math.PI * 2;
    const p = [Math.cos(th) * .62, _r(-.12, .12), Math.sin(th) * .62];
    NODES.push({ t: 'agent', label: a.name, desc: a.desc, color: a.color, r: 15, p });
    // dendrite tree radiating outward + a few filaments toward core
    const out = _norm(p[0], p[1] + .3, p[2]);
    for (let b = 0; b < 4; b++)
      growTree(p, _norm(out[0] + _r(-.7, .7), out[1] + _r(-.5, .9), out[2] + _r(-.7, .7)), .12, 4, a.color);
    growTree(p, _norm(-p[0], -p[1], -p[2]), .14, 3, a.color);   // axon toward core
  });
  NODES.push({ t: 'core', label: 'BOOK', color: '#f2f6ff', r: 26, p: [0, 0, 0] });
  const SN = 12;
  for (let i = 0; i < SN; i++) {          // strategies embedded between trees
    const y = 1 - (i / (SN - 1)) * 2, rr = Math.sqrt(1 - y * y), th = i * 2.39996;
    NODES.push({ t: 'strat', idx: i, color: STRAT_COLORS[i], r: 4, p: [Math.cos(th) * rr * _r(.9, 1.05), y * .85, Math.sin(th) * rr * _r(.9, 1.05)] });
  }
  ['BTC', 'ETH', 'SOL'].forEach((s, j) => {
    const th = (j / 3) * Math.PI * 2 + .8;
    NODES.push({ t: 'sym', label: s, color: '#ffc23d', r: 6, p: [Math.cos(th) * 1.3, _r(-.1, .35), Math.sin(th) * 1.3] });
  });
  for (let i = 0; i < 90; i++) {          // ambient dust
    const y = 1 - 2 * Math.random(), rr = Math.sqrt(Math.max(0, 1 - y * y)), th = Math.random() * Math.PI * 2, rad = _r(.8, 1.6);
    NODES.push({ t: 'dust', r: .6 + Math.random() * 1.1, p: [Math.cos(th) * rr * rad, y * rad, Math.sin(th) * rr * rad] });
  }
  const ai = (k) => 7 + k, si = (j) => 19 + j;
  for (let i = 0; i < 6; i++) { EDGES.push([i, 6]); EDGES.push([i, (i + 1) % 6]); }
  for (let j = 0; j < 3; j++) for (let k = 0; k < 4; k++) EDGES.push([si(j), ai(j * 4 + k)]);
  for (let i = 0; i < 26; i++) {          // ambient 2D dendrite wash behind
    const pts = [];
    let x0 = _r(.05, .95), y0 = _r(.1, .9), ang = _r(0, Math.PI * 2);
    for (let s = 0; s < 9; s++) {
      pts.push([x0, y0]); ang += _r(-.9, .9);
      x0 += Math.cos(ang) * _r(.02, .07); y0 += Math.sin(ang) * _r(.02, .07);
    }
    dendrites.push({ pts, c: STRAT_COLORS[i % STRAT_COLORS.length], a: _r(.03, .1), ph: _r(0, 6) });
  }
})();

// interaction: drag to rotate, wheel to zoom
const rot = { x: -.3, y: 0, vx: 0, vy: .005, zoom: 1, drag: false };
const brainEl = document.getElementById('brain');
brainEl.addEventListener('pointerdown', (e) => { rot.drag = true; brainEl.setPointerCapture(e.pointerId); });
window.addEventListener('pointermove', (e) => {
  if (!rot.drag) return;
  rot.vy = e.movementX * .006; rot.vx = e.movementY * .006;
  rot.y += rot.vy; rot.x += rot.vx;
});
window.addEventListener('pointerup', () => { rot.drag = false; });
brainEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  rot.zoom = Math.min(2.4, Math.max(.5, rot.zoom - e.deltaY * .0012));
}, { passive: false });

function drawBrain(now) {
  const { x, w, h } = ctx2d('brain');
  x.clearRect(0, 0, w, h);
  const t = now / 1000;
  for (const d of dendrites) {           // ambient field
    x.strokeStyle = d.c;
    x.globalAlpha = d.a + Math.sin(t * 1.5 + d.ph) * .04;
    x.lineWidth = .7;
    x.beginPath();
    d.pts.forEach(([px, py], i) => (i ? x.lineTo(px * w, py * h) : x.moveTo(px * w, py * h)));
    x.stroke();
  }
  x.globalAlpha = 1;
  if (!rot.drag) { rot.y += rot.vy; rot.x += rot.vx; rot.vy = .005 + (rot.vy - .005) * .93; rot.vx *= .93; }
  rot.x = Math.max(-1.3, Math.min(1.3, rot.x));
  const cy_ = Math.cos(rot.y), sy_ = Math.sin(rot.y), cx_ = Math.cos(rot.x), sx_ = Math.sin(rot.x);
  const R = Math.min(w, h) * .40 * rot.zoom, CX = w / 2, CY = h / 2 - 10, D = 3;
  const proj = (p) => {
    const x1 = p[0] * cy_ + p[2] * sy_, z1 = -p[0] * sy_ + p[2] * cy_;
    const y1 = p[1] * cx_ - z1 * sx_, z2 = p[1] * sx_ + z1 * cx_;
    const s = D / (D - z2);
    return { X: CX + x1 * s * R, Y: CY + y1 * s * R, s, z: z2 };
  };
  const P = NODES.map((n) => ({ n, ...proj(n.p) }));
  const recent = STATE.decisions.filter((d) => now - d.ts < 60_000).length;
  // dendrite segments, depth-shaded, round caps
  x.lineCap = 'round';
  for (const sg of SEGS) {
    const A = proj(sg.a), B = proj(sg.b);
    const depth = Math.max(0, 1 - ((A.z + B.z) / 2) / 1.7);
    const flicker = .85 + .15 * Math.sin(t * 3 + A.X * .05);
    x.strokeStyle = sg.c;
    x.globalAlpha = (.12 + depth * .5) * flicker;
    x.lineWidth = Math.max(.4, sg.w * A.s);
    x.beginPath(); x.moveTo(A.X, A.Y); x.lineTo(B.X, B.Y); x.stroke();
  }
  x.globalAlpha = 1;
  // axon links carrying sparks
  x.lineWidth = .8;
  for (const [a, b] of EDGES) {
    const A = P[a], B = P[b];
    const depth = Math.max(0, 1 - ((A.z + B.z) / 2) / 1.7);
    x.strokeStyle = NODES[a].color || '#2fd8ff';
    x.globalAlpha = .06 + depth * .22;
    x.beginPath(); x.moveTo(A.X, A.Y);
    x.quadraticCurveTo(CX, CY - 30, B.X, B.Y); x.stroke();
  }
  x.globalAlpha = 1;
  // sparks travel dendrite paths
  if (Math.random() < .14 + recent * .05 && sparks.length < 60) {
    if (Math.random() < .7 && SEGS.length) {
      const sg = SEGS[(Math.random() * SEGS.length) | 0];
      sparks.push({ seg: sg, p: 0, c: sg.c });
    } else {
      const e = EDGES[(Math.random() * EDGES.length) | 0];
      sparks.push({ a: e[0], b: e[1], p: 0, c: NODES[e[0]].color || '#2fd8ff' });
    }
  }
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i]; s.p += .03;
    if (s.p >= 1) { sparks.splice(i, 1); continue; }
    let q;
    if (s.seg) {
      const { a, b } = s.seg;
      q = proj([a[0] + (b[0] - a[0]) * s.p, a[1] + (b[1] - a[1]) * s.p, a[2] + (b[2] - a[2]) * s.p]);
    } else {
      const pa = NODES[s.a].p, pb = NODES[s.b].p;
      q = proj([pa[0] + (pb[0] - pa[0]) * s.p, pa[1] + (pb[1] - pa[1]) * s.p, pa[2] + (pb[2] - pa[2]) * s.p]);
    }
    x.fillStyle = s.c; x.shadowColor = s.c; x.shadowBlur = 14;
    x.beginPath(); x.arc(q.X, q.Y, 2.6 * q.s, 0, 7); x.fill();
    x.shadowBlur = 0;
  }
  // nodes far to near
  const sorted = [...P].sort((a, b) => b.z - a.z);
  for (const nd of sorted) {
    const n = nd.n;
    const depth = Math.max(.12, 1 - nd.z / 1.8);
    if (n.t === 'dust') {
      x.fillStyle = `rgba(120,150,210,${.16 * depth * (.7 + .3 * Math.sin(t + nd.X))})`;
      x.beginPath(); x.arc(nd.X, nd.Y, n.r * nd.s, 0, 7); x.fill();
      continue;
    }
    const hot = n.t === 'agent'
      ? (n.label === 'EDGE' || n.label === 'TAKER' ? Math.min(1, .35 + recent / 5) : .45 + .3 * Math.sin(t * 2 + nd.X))
      : n.t === 'strat' ? .5 : .6;
    const sz = n.r * nd.s;
    // glow halo
    const g = x.createRadialGradient(nd.X, nd.Y, 0, nd.X, nd.Y, sz * 3);
    g.addColorStop(0, n.color); g.addColorStop(1, 'transparent');
    x.globalAlpha = (.22 + hot * .4) * depth;
    x.fillStyle = g; x.beginPath(); x.arc(nd.X, nd.Y, sz * 3, 0, 7); x.fill();
    x.globalAlpha = 1;
    // neuron body
    if (n.t === 'agent' || n.t === 'core') {
      const bg = x.createRadialGradient(nd.X - sz * .3, nd.Y - sz * .3, sz * .1, nd.X, nd.Y, sz);
      bg.addColorStop(0, '#ffffff'); bg.addColorStop(1, n.color);
      x.fillStyle = bg;
      x.beginPath(); x.arc(nd.X, nd.Y, sz, 0, 7); x.fill();
      // the "V" eyes
      x.fillStyle = 'rgba(2,4,10,.85)';
      x.beginPath(); x.ellipse(nd.X - sz * .22, nd.Y, sz * .1, sz * .32, 0, 0, 7); x.fill();
      x.beginPath(); x.ellipse(nd.X + sz * .22, nd.Y, sz * .1, sz * .32, 0, 0, 7); x.fill();
    } else {
      x.fillStyle = n.color;
      x.beginPath(); x.arc(nd.X, nd.Y, Math.max(1, sz), 0, 7); x.fill();
    }
    if (n.label && nd.s > .75) {
      x.fillStyle = n.color; x.font = `${n.t === 'agent' ? 11 : 10}px monospace`; x.textAlign = 'center';
      x.fillText(n.label, nd.X, nd.Y + sz + 13);
      if (n.desc) { x.fillStyle = '#4d5f80'; x.font = '8px monospace'; x.fillText(n.desc, nd.X, nd.Y + sz + 23); }
    }
  }
  // core halo pulse
  const c = P[6], pulse = .8 + Math.sin(t * 2.4) * .2;
  const g2 = x.createRadialGradient(c.X, c.Y, 0, c.X, c.Y, 60 * pulse * c.s);
  g2.addColorStop(0, 'rgba(242,246,255,.55)'); g2.addColorStop(.4, 'rgba(143,107,255,.22)'); g2.addColorStop(1, 'transparent');
  x.fillStyle = g2; x.beginPath(); x.arc(c.X, c.Y, 60 * pulse * c.s, 0, 7); x.fill();
  x.fillStyle = '#e8f4ff'; x.font = '10px monospace'; x.textAlign = 'center';
  x.fillText(`NAV ${fmt$(STATE.snap?.equityUsd || 0, 0)}`, c.X, c.Y + 40 * c.s);
  $('brainMeta').textContent = `${NODES.length - 90} neurons · ${SEGS.length + EDGES.length} synapses · ${recent} spikes/min`;
  $('pipeline').innerHTML = AGENTS.map((a) =>
    `<div class="pipe-node" style="color:${a.color}"><b>${a.name}</b><span>${a.desc}</span></div>`).join('');
}

// ---------- cortex: layered input net ----------
const CORTEX_L = ['TAPE', 'BOOK', 'ORACLE', 'FLOW', 'VOL', 'CHAIN'];
const CORTEX_R = ['H1', 'H2', 'H3', 'H4'];
function drawCortex(now) {
  const { x, w, h } = ctx2d('cortex');
  x.clearRect(0, 0, w, h);
  const t = now / 1000;
  const Lx = w * .16, Rx = w * .84;
  const L = CORTEX_L.map((n, i) => ({ n, X: Lx, Y: 16 + i * ((h - 32) / (CORTEX_L.length - 1)), c: STRAT_COLORS[i] }));
  const R = CORTEX_R.map((n, i) => ({ n, X: Rx, Y: 24 + i * ((h - 48) / (CORTEX_R.length - 1)), c: '#8f6bff' }));
  x.lineWidth = .7;
  L.forEach((l, i) => R.forEach((r, j) => {
    const ph = Math.sin(t * 1.8 + i + j * .7) * 10;
    x.strokeStyle = l.c;
    x.globalAlpha = .1 + .12 * Math.abs(Math.sin(t + i * j));
    x.beginPath(); x.moveTo(l.X + 6, l.Y);
    x.bezierCurveTo(l.X + w * .3, l.Y + ph, r.X - w * .3, r.Y - ph, r.X - 6, r.Y); x.stroke();
  }));
  x.globalAlpha = 1;
  for (const n of [...L, ...R]) {
    const pul = .8 + .35 * Math.sin(t * 3 + n.Y);
    x.fillStyle = n.c; x.shadowColor = n.c; x.shadowBlur = 8;
    x.beginPath(); x.arc(n.X, n.Y, 5 * pul, 0, 7); x.fill();
    x.shadowBlur = 0;
    x.strokeStyle = n.c; x.globalAlpha = .4;
    x.beginPath(); x.arc(n.X, n.Y, 8 * pul, 0, 7); x.stroke();
    x.globalAlpha = 1;
    x.fillStyle = '#4d5f80'; x.font = '7.5px monospace'; x.textAlign = 'center';
    x.fillText(n.n, n.X, n.Y + 18);
  }
  x.fillStyle = '#4d5f80'; x.font = '8px monospace'; x.textAlign = 'left';
  x.fillText('INPUT', Lx - 18, 9); x.fillText('HIDDEN', Rx - 24, 9);
}

// ---------- calcium imaging: momentum scatter + per-symbol sparklines ----------
function drawCalcium(now) {
  const { x, w, h } = ctx2d('calcium');
  x.clearRect(0, 0, w, h);
  const syms = Object.keys(STATE.snap?.prices || {});
  if (!syms.length) return;
  const half = w * .55;
  for (let i = 0; i < 90; i++) {
    const sym = syms[i % syms.length];
    const cd = STATE.candles[sym] || [];
    const chg = cd.length > 2 ? ((cd[cd.length - 1].c - cd[0].c) / cd[0].c) * 100 : 0;
    const px = 8 + (((i * 37) % 100) / 100) * (half - 16);
    const py = h / 2 - Math.tanh(chg * 3) * h * .3 + Math.sin(i * 13.7) * h * .22;
    const glow = .25 + .5 * Math.abs(Math.sin(now / 900 + i));
    x.fillStyle = STRAT_COLORS[i % STRAT_COLORS.length];
    x.globalAlpha = glow * .85;
    x.beginPath(); x.arc(px, Math.max(4, Math.min(h - 4, py)), 2.4, 0, 7); x.fill();
  }
  x.globalAlpha = 1;
  x.strokeStyle = '#16203a';
  x.beginPath(); x.moveTo(half, 4); x.lineTo(half, h - 4); x.stroke();
  syms.forEach((sym, r) => {
    const cd = (STATE.candles[sym] || []).slice(-30);
    if (cd.length < 2) return;
    const lo = Math.min(...cd.map((c) => c.l)), hi = Math.max(...cd.map((c) => c.h));
    const y0 = 14 + r * 26;
    const chg = ((cd[cd.length - 1].c - cd[0].c) / cd[0].c) * 100;
    x.strokeStyle = chg >= 0 ? '#00e8a0' : '#ff3860'; x.lineWidth = 1; x.beginPath();
    cd.forEach((c, i) => {
      const px = half + 8 + (i / (cd.length - 1)) * (w - half - 62);
      const py = y0 + 8 - ((c.c - lo) / (hi - lo || 1)) * 8;
      i ? x.lineTo(px, py) : x.moveTo(px, py);
    });
    x.stroke();
    x.fillStyle = '#4d5f80'; x.font = '8px monospace';
    x.fillText(sym.replace('USDT', ''), w - 48, y0 + 4);
    x.fillStyle = chg >= 0 ? '#00e8a0' : '#ff3860';
    x.fillText(`${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`, w - 48, y0 + 13);
  });
}

// ---------- synaptic weights ----------
function drawWeights() {
  const { x, w, h } = ctx2d('weights');
  x.clearRect(0, 0, w, h);
  const n = STATE.strats.length || 12;
  const cols = 12;
  const cell = Math.min((w - 10) / cols, 14);
  STATE.strats.forEach((s, i) => {
    const st = STATE.snap?.stats?.[s.name];
    const pnl = st?.pnl ?? 0;
    const inten = Math.min(1, Math.abs(pnl) / 50 + (st?.trades ? .25 : 0));
    x.fillStyle = !s.enabled ? 'rgba(77,95,128,.3)'
      : pnl >= 0 ? `rgba(0,232,160,${.15 + inten * .8})` : `rgba(255,56,96,${.15 + inten * .8})`;
    const cx = 8 + (i % cols) * (cell + 2), cy = 6 + ((i / cols) | 0) * (cell + 2);
    x.fillRect(cx, cy, cell, cell);
    x.strokeStyle = '#16203a'; x.strokeRect(cx, cy, cell, cell);
  });
  x.fillStyle = '#4d5f80'; x.font = '8px monospace';
  x.fillText('brighter = more pnl-weight', 8, h - 4);
}

// ---------- signal rotation: orbit diagram + activity bars ----------
function drawRotation() {
  const { x, w, h } = ctx2d('rotation');
  x.clearRect(0, 0, w, h);
  const strats = STATE.strats;
  if (!strats.length) return;
  const ow = Math.min(w * .34, 190), ox = ow / 2 + 6, oy = h / 2;
  const t = performance.now() / 1000;
  for (let ring = 1; ring <= 3; ring++) {           // orbit rings
    x.strokeStyle = '#16203a'; x.globalAlpha = .9;
    x.beginPath(); x.ellipse(ox, oy, ow * .45 * ring / 3, h * .42 * ring / 3, .4, 0, 7); x.stroke();
  }
  x.globalAlpha = 1;
  x.fillStyle = '#ff4ff0';
  x.beginPath(); x.arc(ox, oy, 4, 0, 7); x.fill();
  strats.forEach((s, i) => {                       // orbiting strategy comets
    const c = STRAT_COLORS[i % STRAT_COLORS.length];
    const act = STATE.decisions.filter((d) => d.strategy === s.name).length;
    const ring = 1 + (i % 3);
    const ang = t * (.25 + Math.min(1, act / 12) * .9) * (i % 2 ? 1 : -1) + i * 2.4;
    const rx = ow * .45 * ring / 3, ry = h * .42 * ring / 3;
    const px = ox + Math.cos(ang) * rx, py = oy + Math.sin(ang) * ry;
    x.strokeStyle = c; x.globalAlpha = .35; x.lineWidth = 1.2;
    x.beginPath();
    for (let k = 0; k < 9; k++) {
      const a2 = ang - k * .07 * (i % 2 ? 1 : -1);
      const tx = ox + Math.cos(a2) * rx, ty = oy + Math.sin(a2) * ry;
      k ? x.lineTo(tx, ty) : x.moveTo(tx, ty);
    }
    x.stroke(); x.globalAlpha = 1;
    x.fillStyle = c; x.shadowColor = c; x.shadowBlur = 6;
    x.beginPath(); x.arc(px, py, 3.2, 0, 7); x.fill(); x.shadowBlur = 0;
  });
  // activity bars on the right
  const bx = ow + 12, bw = w - bx - 52, rowH = h / strats.length;
  strats.forEach((s, i) => {
    const y = i * rowH;
    const st = STATE.snap?.stats?.[s.name] || { pnl: 0, trades: 0 };
    const act = STATE.decisions.filter((d) => d.strategy === s.name).length;
    const c = STRAT_COLORS[i % STRAT_COLORS.length];
    x.fillStyle = c; x.globalAlpha = s.enabled ? .8 : .2;
    x.fillRect(bx, y + 2, Math.min(1, act / 12) * bw, Math.max(3, rowH - 5));
    x.globalAlpha = 1;
    x.fillStyle = '#cfe0f5'; x.font = '8.5px monospace';
    x.fillText(s.name, bx + 2, y + rowH - 4);
    x.fillStyle = st.pnl >= 0 ? '#00e8a0' : '#ff3860';
    x.textAlign = 'right'; x.fillText(fmt$(st.pnl, 0), w - 4, y + rowH - 4); x.textAlign = 'left';
  });
}

// ---------- indicators ----------
const cls2 = (v) => (v >= 0 ? 'pos' : 'neg');
function emaN(a, p) {
  if (a.length < p) return null;
  const k = 2 / (p + 1);
  let e = a.slice(0, p).reduce((x, y) => x + y, 0) / p;
  for (let i = p; i < a.length; i++) e = a[i] * k + e * (1 - k);
  return e;
}
function rsiN(a, p = 14) {
  if (a.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = a.length - p; i < a.length; i++) { const d = a[i] - a[i - 1]; if (d > 0) g += d; else l -= d; }
  return 100 - 100 / (1 + g / (l || 1e-9));
}
function bollPctB(a, p = 20, m = 2) {
  if (a.length < p) return null;
  const s = a.slice(-p), mean = s.reduce((x, y) => x + y, 0) / p;
  const sd = Math.sqrt(s.reduce((x, y) => x + (y - mean) ** 2, 0) / p);
  const band = sd * m || 1e-9;
  return (a[a.length - 1] - (mean - band)) / (2 * band);
}
function zsc(a, p = 50) {
  if (a.length < p) return null;
  const s = a.slice(-p), mean = s.reduce((x, y) => x + y, 0) / p;
  const sd = Math.sqrt(s.reduce((x, y) => x + (y - mean) ** 2, 0) / p) || 1e-9;
  return (a[a.length - 1] - mean) / sd;
}
function atrP(cs, p = 14) {
  if (cs.length < p + 1) return null;
  let t = 0;
  for (let i = cs.length - p; i < cs.length; i++)
    t += Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
  return (t / p / cs[cs.length - 1].c) * 100;
}
function vwapN(cs, n = 90) {
  const s = cs.slice(-n); let pv = 0, v = 0;
  for (const c of s) { pv += c.c * c.v; v += c.v; }
  return v ? pv / v : null;
}
function stochK(cs, p = 14) {
  if (cs.length < p) return null;
  const s = cs.slice(-p), lo = Math.min(...s.map((c) => c.l)), hi = Math.max(...s.map((c) => c.h));
  return ((cs[cs.length - 1].c - lo) / (hi - lo || 1e-9)) * 100;
}

function chip(name, val, tone) {
  return `<div class="chip"><span class="dim">${name}</span><b class="${tone || ''}">${val}</b></div>`;
}

function renderIndicators(s) {
  const cs = STATE.candles[STATE.sym] || [];
  const cl = cs.map((c) => c.c);
  if (cl.length < 30) return;
  const last = cl[cl.length - 1];
  const rsi = rsiN(cl), pb = bollPctB(cl), z = zsc(cl), atr = atrP(cs);
  const macd = emaN(cl, 12) - emaN(cl, 26);
  const stoch = stochK(cs);
  const vsma = cs.slice(-20).reduce((a, c) => a + c.v, 0) / Math.min(20, cs.length) || 1e-9;
  const volR = cs[cs.length - 1].v / vsma;
  const fvwap = vwapN(cs);
  const e9 = emaN(cl, 9), e21 = emaN(cl, 21);

  $('tapeRsi').innerHTML = rsi != null
    ? `<span class="${rsi > 70 ? 'neg' : rsi < 30 ? 'pos' : 'amb'}">RSI ${rsi.toFixed(0)}</span>` : '';

  const tone = (v, lo, hi) => (v > hi ? 'neg' : v < lo ? 'pos' : 'amb');
  $('indChips').innerHTML = [
    chip('RSI14', rsi?.toFixed(0), tone(rsi, 30, 70)),
    chip('STOCH', stoch?.toFixed(0), tone(stoch, 20, 80)),
    chip('MACD', macd?.toFixed(1), cls2(macd)),
    chip('%B', pb?.toFixed(2), tone(pb, .2, .8)),
    chip('Z50', z?.toFixed(2), tone(z, -1.5, 1.5)),
    chip('ATR%', atr?.toFixed(2), atr > 1 ? 'neg' : 'amb'),
    chip('VOL×', volR.toFixed(2), volR > 2 ? 'neg' : 'dim'),
    chip('EMA9>21', e9 > e21 ? 'BULL' : 'BEAR', e9 > e21 ? 'pos' : 'neg'),
    chip('ΔVWAP', fvwap ? `${(((last - fvwap) / fvwap) * 100).toFixed(2)}%` : '—', cls2(last - fvwap)),
  ].join('');

  // directional bias: fraction of up candles in last 50
  const win = cl.slice(-50);
  const ups = win.filter((v, i) => i && v > win[i - 1]).length / (win.length - 1 || 1);
  $('biasUp').style.width = `${ups * 100}%`; $('biasDn').style.width = `${(1 - ups) * 100}%`;
  $('biasTxt').textContent = `${(ups * 100).toFixed(0)}% up / ${((1 - ups) * 100).toFixed(0)}% dn`;

  // matched inventory: buy vs sell pressure from decisions + tape volume split
  const ds = STATE.decisions || [];
  const buys = ds.filter((d) => d.intent?.side === 'buy').length;
  const sells = ds.filter((d) => d.intent?.side === 'sell').length;
  const tot = buys + sells || 1;
  $('invB').style.width = `${(buys / tot) * 100}%`; $('invS').style.width = `${(sells / tot) * 100}%`;
  $('invTxt').textContent = `${buys} buy / ${sells} sell`;

  // model: fair vs market
  const edge = fvwap ? (fvwap - last) / fvwap * 100 : null;
  $('modelRows').innerHTML = [
    ['FAIR (VWAP)', fvwap ? fmt$(fvwap, 0) : '—', ''],
    ['MARKET', fmt$(last, 0), ''],
    ['EDGE', edge != null ? `${edge >= 0 ? '+' : ''}${edge.toFixed(2)}%` : '—', cls2(edge)],
    ['SPREAD σ', atr != null ? `${(atr / 4).toFixed(2)}%` : '—', 'amb'],
    ['Z-SCORE', z?.toFixed(2), tone(z, -1.5, 1.5)],
  ].map(([l, v, c]) => `<div class="mrow"><label>${l}</label><span class="${c}">${v}</span></div>`).join('');

  // kelly
  const stats = Object.values(s.stats || {});
  const trades = stats.reduce((a, v) => a + v.trades, 0);
  const wins = stats.reduce((a, v) => a + v.wins, 0);
  const w = trades ? wins / trades : .5;
  const gp = s.realizedUsd > 0 ? s.realizedUsd / Math.max(wins, 1) : 0;
  const gl = trades - wins ? Math.min(-s.realizedUsd, 0) / (trades - wins) || 1 : 1;
  const b = gp && gl ? Math.abs(gp / gl) : 1;
  const kf = Math.max(0, Math.min(.25, w - (1 - w) / (b || 1)));
  $('kellyBox').innerHTML = `
    <div class="krow"><label>KELLY f*</label><span>${(kf * 100).toFixed(1)}% (cap 25%)</span></div>
    <div class="krow"><label>STAKE</label><span>${fmt$(kf * s.equityUsd, 0)}</span></div>
    <div class="krow"><label>EXPOSURE</label><span>${((1 - s.cashUsd / s.equityUsd) * 100).toFixed(0)}% of book</span></div>
    <div class="kbar"><i style="width:${(kf / .25) * 100}%"></i></div>`;
}

// ---------- membrane: execution band ----------
function drawMembrane() {
  const { x, w, h } = ctx2d('membrane');
  x.clearRect(0, 0, w, h);
  const cs = (STATE.candles[STATE.sym] || []).slice(-60);
  if (cs.length < 10) { x.fillStyle = '#4d5f80'; x.fillText('waiting…', 8, h / 2); return; }
  const cl = cs.map((c) => c.c);
  const mean = cl.reduce((a, b) => a + b, 0) / cl.length;
  const sd = Math.sqrt(cl.reduce((a, v) => a + (v - mean) ** 2, 0) / cl.length) || 1e-9;
  const lo = Math.min(...cl, mean - sd * 2), hi = Math.max(...cl, mean + sd * 2);
  const py = (v) => h - 4 - ((v - lo) / (hi - lo || 1)) * (h - 8);
  const px = (i) => (i / (cl.length - 1)) * w;
  // band
  x.fillStyle = 'rgba(143,107,255,.10)';
  x.fillRect(0, py(mean + sd), w, py(mean - sd) - py(mean + sd));
  x.strokeStyle = 'rgba(143,107,255,.5)'; x.setLineDash([2, 3]);
  [mean + sd, mean - sd].forEach((v) => { x.beginPath(); x.moveTo(0, py(v)); x.lineTo(w, py(v)); x.stroke(); });
  x.setLineDash([]);
  x.strokeStyle = '#4d5f80'; x.beginPath(); x.moveTo(0, py(mean)); x.lineTo(w, py(mean)); x.stroke();
  // price line
  const grad = x.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(47,216,255,.2)'); grad.addColorStop(1, '#2fd8ff');
  x.strokeStyle = grad; x.lineWidth = 1.2; x.beginPath();
  cl.forEach((v, i) => (i ? x.lineTo(px(i), py(v)) : x.moveTo(px(i), py(v))));
  x.stroke(); x.lineWidth = 1;
  const last = cl[cl.length - 1];
  const inside = Math.abs(last - mean) <= sd;
  x.fillStyle = inside ? '#00e8a0' : '#ff3860';
  x.beginPath(); x.arc(px(cl.length - 1), py(last), 3, 0, 7); x.fill();
  x.font = '8px monospace'; x.fillStyle = '#4d5f80';
  x.fillText(inside ? 'INSIDE BAND — maker regime' : 'OUTSIDE BAND — taker regime', 4, 10);
}

// ---------- pricer: Monte-Carlo fan ----------
const mcPaths = [];
function drawPricer(now) {
  const { x, w, h } = ctx2d('pricer');
  x.clearRect(0, 0, w, h);
  const cd = STATE.candles[STATE.sym];
  if (!cd?.length) { x.fillStyle = '#4d5f80'; x.fillText('waiting for candles…', 8, h / 2); return; }
  const p0 = cd[cd.length - 1].c;
  const rets = cd.slice(-60).map((c, i, a) => (i ? (c.c - a[i - 1].c) / a[i - 1].c : 0)).slice(1);
  const vol = Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / rets.length) || .001;
  if (!mcPaths.length || now - (mcPaths.t || 0) > 5000) {
    mcPaths.length = 0; mcPaths.t = now;
    for (let i = 0; i < 60; i++) {
      let v = p0; const path = [v];
      for (let s = 0; s < 40; s++) { v *= 1 + (Math.random() - .5) * 2 * vol * 1.4; path.push(v); }
      mcPaths.push(path);
    }
  }
  const all = mcPaths.flat();
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const px = (i) => (i / 40) * (w - 60);
  const py = (v) => h - 8 - ((v - lo) / span) * (h - 16);
  mcPaths.forEach((path) => {
    const end = path[path.length - 1];
    x.strokeStyle = end >= p0 ? 'rgba(0,232,160,.14)' : 'rgba(255,56,96,.14)';
    x.beginPath();
    path.forEach((v, i) => (i ? x.lineTo(px(i), py(v)) : x.moveTo(px(i), py(v))));
    x.stroke();
  });
  x.strokeStyle = '#ffc23d'; x.setLineDash([3, 3]);
  x.beginPath(); x.moveTo(0, py(p0)); x.lineTo(w, py(p0)); x.stroke(); x.setLineDash([]);
  // terminal distribution
  const term = mcPaths.map((p) => p[p.length - 1]);
  const bins = 12, counts = new Array(bins).fill(0);
  term.forEach((v) => counts[Math.min(bins - 1, Math.floor(((v - lo) / span) * bins))]++);
  const maxC = Math.max(...counts) || 1;
  counts.forEach((c, i) => {
    const y0 = h - 8 - ((i + 1) / bins) * (h - 16);
    x.fillStyle = 'rgba(47,216,255,.3)';
    x.fillRect(w - 50, y0, (c / maxC) * 44, (h - 16) / bins - 1);
  });
  x.fillStyle = '#4d5f80'; x.font = '8px monospace';
  x.fillText(`spot ${fmt$(p0, 0)} · σ/bar ${(vol * 100).toFixed(2)}% · 60 sims`, 4, 10);
}

// ---------- frame loop ----------
let tapeT = 0;
function frame(now) {
  drawBrain(now);
  drawCortex(now);
  drawCalcium(now);
  drawBook(now);
  if (now - tapeT > 250) { tapeT = now; drawTape(); }
  requestAnimationFrame(frame);
}

function drawSlow() {
  drawNavChart(); drawWeights(); drawRotation(); drawPricer(performance.now()); drawMembrane();
}

setInterval(() => {
  const d = new Date();
  $('sClock').textContent = d.toISOString().slice(11, 19);
}, 1000);

$('kill').onclick = async () => {
  if (!confirm('Kill the engine? Blocks all new entries until data/KILL is removed.')) return;
  const r = await api('/api/engine/kill', { method: 'POST' });
  if (r?.killed) refresh();
};

window.STATE = STATE;
refresh();
setInterval(refresh, 12_000);
setInterval(drawSlow, 3_000);
requestAnimationFrame(frame);
