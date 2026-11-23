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
  }
  $('symTabs').innerHTML = Object.keys(s.prices || {}).map((sym) =>
    `<button class="${sym === STATE.sym ? 'on' : ''}" onclick="STATE.sym='${sym}';refresh()">${sym}</button>`).join('');

  $('cortexList').innerHTML = s.positions.map((p) => {
    const pc = ((p.markPrice - p.entryPrice) / p.entryPrice) * 100;
    return `<div class="crow"><span>${p.strategy}·${p.symbol.replace('USDT', '')}</span>
      <span class="${cls(pc)}">${pc.toFixed(2)}%</span><span>${fmt$(p.unrealizedUsd, 2)}</span></div>`;
  }).join('') || '<div class="dim">no open tickets</div>';

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
  // VWAP
  let pv = 0, vv = 0;
  x.strokeStyle = '#2fd8ff'; x.lineWidth = 1; x.beginPath();
  cs.forEach((c, i) => {
    pv += ((c.h + c.l + c.c) / 3) * c.v; vv += c.v;
    const vw = pv / vv;
    i ? x.lineTo(px(i), py(vw)) : x.moveTo(px(i), py(vw));
  });
  x.stroke();
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

// ---------- synapse (animated agent network) ----------
const AGENTS = [
  { name: 'SPOTTER', color: '#2fd8ff', desc: 'market feed' },
  { name: 'KELLY', color: '#8f6bff', desc: 'sizing' },
  { name: 'PRIOR', color: '#ffc23d', desc: 'context' },
  { name: 'TAKER', color: '#4f8fff', desc: 'executor' },
  { name: 'EDGE', color: '#ff4ff0', desc: 'strategies' },
  { name: 'CLOSER', color: '#ff3860', desc: 'exits' },
];
const dendrites = [];
const sparks = [];
function seedSynapse() {
  dendrites.length = 0;
  const rnd = (a, b) => a + Math.random() * (b - a);
  for (let i = 0; i < 26; i++) {
    const pts = [];
    let x0 = rnd(.1, .9), y0 = rnd(.15, .85);
    let ang = rnd(0, Math.PI * 2);
    for (let s = 0; s < 9; s++) {
      pts.push([x0, y0]);
      ang += rnd(-.9, .9);
      x0 += Math.cos(ang) * rnd(.02, .07);
      y0 += Math.sin(ang) * rnd(.02, .07);
    }
    dendrites.push({ pts, c: ['#8f6bff', '#2fd8ff', '#ff4ff0', '#ffc23d', '#00e8a0', '#ff7a2f'][i % 6], a: rnd(.05, .2), ph: rnd(0, 6) });
  }
}
seedSynapse();

function drawSynapse(now) {
  const { x, w, h } = ctx2d('synapse');
  x.clearRect(0, 0, w, h);
  const t = now / 1000;
  // dendrite field
  for (const d of dendrites) {
    x.strokeStyle = d.c;
    x.globalAlpha = d.a + Math.sin(t * 1.5 + d.ph) * .06;
    x.lineWidth = .7;
    x.beginPath();
    d.pts.forEach(([px, py], i) => i ? x.lineTo(px * w, py * h) : x.moveTo(px * w, py * h));
    x.stroke();
  }
  x.globalAlpha = 1;
  // agents in a ring
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) * .34;
  const pos = AGENTS.map((a, i) => {
    const ang = (i / AGENTS.length) * Math.PI * 2 - Math.PI / 2 + Math.sin(t * .3 + i) * .05;
    return { ...a, x: cx + Math.cos(ang) * R * 1.15, y: cy + Math.sin(ang) * R * .8 };
  });
  // activity: recent decisions light up EDGE/TAKER/CLOSER
  const recent = STATE.decisions.filter((d) => now - d.ts < 60_000).length;
  pos.forEach((a) => {
    a.hot = a.name === 'EDGE' ? Math.min(1, recent / 6) : a.name === 'TAKER' ? Math.min(1, (STATE.decisions.filter((d) => !d.vetoed && now - d.ts < 60_000).length) / 6) : Math.random() * .3 + .3;
  });
  // edges between consecutive agents + all to center
  for (let i = 0; i < pos.length; i++) {
    const a = pos[i], b = pos[(i + 1) % pos.length];
    x.strokeStyle = a.color; x.globalAlpha = .25;
    x.beginPath(); x.moveTo(a.x, a.y);
    x.quadraticCurveTo(cx, cy, b.x, b.y); x.stroke();
    x.strokeStyle = a.color; x.globalAlpha = .12;
    x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(cx, cy); x.stroke();
  }
  x.globalAlpha = 1;
  // spawn sparks on active edges
  if (Math.random() < .15 + recent * .05 && sparks.length < 40) {
    const i = (Math.random() * pos.length) | 0;
    sparks.push({ from: pos[i], to: pos[(i + 1) % pos.length], p: 0, c: pos[i].color });
  }
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.p += .03;
    if (s.p >= 1) { sparks.splice(i, 1); continue; }
    const mx = (s.from.x + s.to.x) / 2, my = (s.from.y + s.to.y) / 2;
    const qx = mx + (cx - mx) * .7, qy = my + (cy - my) * .7;
    const u = 1 - s.p;
    const sx = u * u * s.from.x + 2 * u * s.p * qx + s.p * s.p * s.to.x;
    const sy = u * u * s.from.y + 2 * u * s.p * qy + s.p * s.p * s.to.y;
    x.fillStyle = s.c;
    x.shadowColor = s.c; x.shadowBlur = 10;
    x.beginPath(); x.arc(sx, sy, 2.2, 0, 7); x.fill();
    x.shadowBlur = 0;
  }
  // central neuron
  const pulse = .85 + Math.sin(t * 2.4) * .15;
  const grd = x.createRadialGradient(cx, cy, 0, cx, cy, 46 * pulse);
  grd.addColorStop(0, 'rgba(255,79,240,.9)'); grd.addColorStop(.5, 'rgba(143,107,255,.35)'); grd.addColorStop(1, 'transparent');
  x.fillStyle = grd; x.beginPath(); x.arc(cx, cy, 46 * pulse, 0, 7); x.fill();
  x.fillStyle = '#e8f4ff'; x.beginPath(); x.arc(cx, cy, 14, 0, 7); x.fill();
  x.fillStyle = '#02040a';
  x.beginPath(); x.ellipse(cx - 4, cy, 2.4, 5, 0, 0, 7); x.fill();
  x.beginPath(); x.ellipse(cx + 4, cy, 2.4, 5, 0, 0, 7); x.fill();
  // agent nodes
  for (const a of pos) {
    const r = 13 + a.hot * 6 + Math.sin(t * 3 + a.x) * 1.5;
    const g2 = x.createRadialGradient(a.x, a.y, 0, a.x, a.y, r * 2.2);
    g2.addColorStop(0, a.color); g2.addColorStop(1, 'transparent');
    x.globalAlpha = .5 + a.hot * .4;
    x.fillStyle = g2; x.beginPath(); x.arc(a.x, a.y, r * 2.2, 0, 7); x.fill();
    x.globalAlpha = 1;
    x.fillStyle = a.color; x.beginPath(); x.arc(a.x, a.y, 7, 0, 7); x.fill();
    x.fillStyle = '#02040a';
    x.beginPath(); x.ellipse(a.x - 2, a.y, 1.2, 2.6, 0, 0, 7); x.fill();
    x.beginPath(); x.ellipse(a.x + 2, a.y, 1.2, 2.6, 0, 0, 7); x.fill();
    x.fillStyle = a.color; x.font = '8px monospace'; x.textAlign = 'center';
    x.fillText(a.name, a.x, a.y + 22);
    x.fillStyle = '#4d5f80'; x.fillText(a.desc, a.x, a.y + 31);
  }
  // pipeline footer
  $('pipeline').innerHTML = pos.map((a) =>
    `<div class="pipe-node" style="color:${a.color}"><b>${a.name}</b><span>${a.desc}</span></div>`).join('');
}

// ---------- cortex mini-network ----------
const cortexNodes = Array.from({ length: 18 }, (_, i) => ({
  u: Math.random(), v: Math.random(), c: STRAT_COLORS[i % STRAT_COLORS.length], ph: Math.random() * 6,
}));
function drawCortex(now) {
  const { x, w, h } = ctx2d('cortex');
  x.clearRect(0, 0, w, h);
  const t = now / 1000;
  const ns = cortexNodes.map((n, i) => ({
    x: (0.15 + n.u * 0.7) * w,
    y: (0.15 + n.v * 0.7) * h + Math.sin(t + n.ph) * 4,
    c: n.c, i,
  }));
  x.lineWidth = .6;
  for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
    const d = Math.hypot(ns[i].x - ns[j].x, ns[i].y - ns[j].y);
    if (d < 55) {
      x.strokeStyle = ns[i].c; x.globalAlpha = .18;
      x.beginPath(); x.moveTo(ns[i].x, ns[i].y); x.lineTo(ns[j].x, ns[j].y); x.stroke();
    }
  }
  x.globalAlpha = 1;
  for (const n of ns) {
    const r = 3 + Math.sin(t * 2 + n.ph) * 1.2;
    x.fillStyle = n.c; x.shadowColor = n.c; x.shadowBlur = 6;
    x.beginPath(); x.arc(n.x, n.y, Math.max(1.5, r), 0, 7); x.fill();
    x.shadowBlur = 0;
  }
}

// ---------- calcium imaging (per-symbol momentum dots) ----------
function drawCalcium(now) {
  const { x, w, h } = ctx2d('calcium');
  x.clearRect(0, 0, w, h);
  const syms = Object.keys(STATE.snap?.prices || {});
  const cols = 14;
  syms.forEach((sym, r) => {
    const cd = STATE.candles[sym] || [];
    const chg = cd.length > 2 ? ((cd[cd.length - 1].c - cd[0].c) / cd[0].c) * 100 : 0;
    for (let i = 0; i < cols; i++) {
      const px = 10 + i * ((w - 20) / cols);
      const py = 14 + r * 18;
      const glow = .2 + Math.abs(chg) * .4 + Math.sin(now / 700 + i + r) * .15;
      x.fillStyle = chg >= 0 ? `rgba(0,232,160,${Math.min(.9, glow)})` : `rgba(255,56,96,${Math.min(.9, glow)})`;
      x.beginPath(); x.arc(px, py, 4, 0, 7); x.fill();
    }
    x.fillStyle = '#4d5f80'; x.font = '8px monospace';
    x.fillText(sym.replace('USDT', ''), w - 34, 17 + r * 18);
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

// ---------- signal rotation ----------
function drawRotation() {
  const { x, w, h } = ctx2d('rotation');
  x.clearRect(0, 0, w, h);
  const strats = STATE.strats;
  if (!strats.length) return;
  const rowH = h / strats.length;
  const maxAct = 12;
  strats.forEach((s, i) => {
    const y = i * rowH + 2;
    const st = STATE.snap?.stats?.[s.name] || { pnl: 0, trades: 0 };
    const act = STATE.decisions.filter((d) => d.strategy === s.name).length;
    const c = STRAT_COLORS[i % STRAT_COLORS.length];
    // activity bar
    x.fillStyle = c; x.globalAlpha = s.enabled ? .8 : .2;
    const bw = Math.min(1, act / maxAct) * (w * .45);
    x.fillRect(4, y + 2, bw, rowH - 5);
    x.globalAlpha = 1;
    // pnl pip on the right
    x.fillStyle = st.pnl >= 0 ? '#00e8a0' : '#ff3860';
    x.font = '9px monospace'; x.textAlign = 'right';
    x.fillText(fmt$(st.pnl, 0), w - 6, y + rowH - 4);
    x.textAlign = 'left';
    x.fillStyle = '#cfe0f5';
    x.fillText(s.name, 8, y + rowH - 4);
  });
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
function frame(now) {
  drawSynapse(now);
  drawCortex(now);
  drawCalcium(now);
  drawBook(now);
  requestAnimationFrame(frame);
}

function drawSlow() {
  drawNavChart(); drawTape(); drawWeights(); drawRotation(); drawPricer(performance.now());
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
