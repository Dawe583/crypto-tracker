// Trading deck: polls the engine API and renders the whole picture.
const $ = (id) => document.getElementById(id);
const fmt$ = (n) => (n == null ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const pct = (n) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);
const cls = (n) => (n >= 0 ? 'pos' : 'neg');
const ago = (ts) => {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${s | 0}s`;
  if (s < 3600) return `${(s / 60) | 0}m`;
  return `${(s / 3600) | 0}h`;
};

let TOKEN = '';
const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {} });
  if (r.status === 401 && !TOKEN) {
    TOKEN = sessionStorage.getItem('apiToken') || prompt('API token (if configured)') || '';
    sessionStorage.setItem('apiToken', TOKEN);
    return api(path, opts);
  }
  return r.ok ? r.json() : null;
};

function drawEquity(curve, start) {
  const c = $('equity');
  const dpr = devicePixelRatio || 1;
  const w = (c.width = c.clientWidth * dpr);
  const h = (c.height = 160 * dpr);
  const x = c.getContext('2d');
  x.clearRect(0, 0, w, h);
  if (!curve || curve.length < 2) {
    x.fillStyle = '#5c6a85';
    x.font = `${12 * dpr}px monospace`;
    x.fillText('waiting for engine data...', 16 * dpr, 80 * dpr);
    return;
  }
  const ys = curve.map((p) => p.equityUsd).concat([start]);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const span = hi - lo || 1;
  const px = (i) => (i / (curve.length - 1)) * (w - 8 * dpr) + 4 * dpr;
  const py = (v) => h - 8 * dpr - ((v - lo) / span) * (h - 16 * dpr);
  // baseline (start equity)
  x.strokeStyle = '#1b2334';
  x.setLineDash([4, 4]);
  x.beginPath(); x.moveTo(0, py(start)); x.lineTo(w, py(start)); x.stroke();
  x.setLineDash([]);
  // curve
  const last = curve[curve.length - 1].equityUsd;
  x.strokeStyle = last >= start ? '#22d97a' : '#ff4d5e';
  x.lineWidth = 1.5 * dpr;
  x.beginPath();
  curve.forEach((p, i) => (i ? x.lineTo(px(i), py(p.equityUsd)) : x.moveTo(px(i), py(p.equityUsd))));
  x.stroke();
  // labels
  x.fillStyle = '#5c6a85';
  x.font = `${9 * dpr}px monospace`;
  x.fillText(fmt$(hi), 4 * dpr, 10 * dpr);
  x.fillText(fmt$(lo), 4 * dpr, h - 2 * dpr);
  x.fillText(`start ${fmt$(start)}`, w - 90 * dpr, py(start) - 4 * dpr);
}

async function refresh() {
  const [snap, strats, decisions, whales, pools, gold] = await Promise.all([
    api('/api/engine/snapshot'),
    api('/api/engine/strategies'),
    api('/api/engine/decisions?limit=80'),
    api('/api/whales?limit=50'),
    api('/api/pools?limit=50'),
    api('/api/gold'),
  ]);
  if (!snap || snap.empty) return;

  $('nav').textContent = fmt$(snap.equityUsd);
  $('nav').className = cls(snap.equityUsd - 10000);
  $('realized').textContent = fmt$(snap.realizedUsd);
  $('realized').className = cls(snap.realizedUsd);
  $('unrealized').textContent = fmt$(snap.unrealizedUsd);
  $('unrealized').className = cls(snap.unrealizedUsd);
  $('openN').textContent = snap.positions.length;
  $('fees').textContent = fmt$(snap.feesUsd);
  $('dayPnl').textContent = fmt$((snap.realizedUsd ?? 0) + (snap.unrealizedUsd ?? 0));
  $('dayPnl').className = cls((snap.realizedUsd ?? 0) + (snap.unrealizedUsd ?? 0));
  $('cycleAt').textContent = `cycle ${snap.cycleAt ? ago(Date.parse(snap.cycleAt)) + ' ago' : ''}`;
  $('kill').classList.toggle('killed', !!snap.killed);
  $('kill').textContent = snap.killed ? 'ENGINE KILLED' : 'KILL SWITCH';

  drawEquity(snap.equityCurve, snap.equityUsd - snap.realizedUsd - snap.unrealizedUsd || 10000);

  $('marketStrip').innerHTML = Object.entries(snap.prices || {})
    .map(([s, p]) => `<div class="mkt"><b>${s}</b> ${fmt$(p)}</div>`)
    .join('');

  $('positions').querySelector('tbody').innerHTML = snap.positions
    .map((p) => {
      const u = p.unrealizedUsd;
      return `<tr><td>${p.strategy}</td><td>${p.symbol}</td><td>${p.qty.toFixed(6)}</td>
        <td>${fmt$(p.entryPrice)}</td><td>${fmt$(p.markPrice)}</td>
        <td class="${cls(u)}">${fmt$(u)}</td><td>${ago(p.entryTs)}</td></tr>`;
    })
    .join('') || '<tr><td colspan="7" class="dim">no open positions</td></tr>';

  $('strategies').querySelector('tbody').innerHTML = (strats || [])
    .map((s) => {
      const st = (snap.stats || {})[s.name] || { pnl: 0, trades: 0, wins: 0 };
      return `<tr><td>${s.name}</td><td>${s.enabled ? 'on' : '<span class="dim">off</span>'}</td>
        <td>${st.trades}</td><td>${st.wins}/${st.trades}</td>
        <td class="${cls(st.pnl)}">${fmt$(st.pnl)}</td></tr>`;
    })
    .join('');

  $('decisions').innerHTML = (decisions || [])
    .map((d) => `<div class="row">
      <span class="t">${new Date(d.ts).toTimeString().slice(0, 8)}</span>
      <b>${d.strategy}</b> ${d.symbol}
      <span class="${d.action === 'buy' ? 'pos' : 'neg'}">${d.action.toUpperCase()}</span>
      ${(d.confidence * 100).toFixed(0)}% — ${d.reason}
      ${d.vetoed ? `<div class="veto">VETO: ${d.vetoed}</div>` : ''}
    </div>`)
    .join('');

  $('whales').textContent = whales?.count ?? 0;
  $('pools').textContent = pools?.count ?? 0;
  $('goldMini').innerHTML = (gold?.assets || [])
    .map((a) => `<div class="mini"><label>${a.symbol} vs spot</label>
      <span class="${cls(a.deviationPct)}">${pct(a.deviationPct)}</span></div>`)
    .join('') || '<div class="mini dim">no gold data yet</div>';
}

$('kill').onclick = async () => {
  if (!confirm('Kill the engine? Blocks all new entries until data/KILL is removed.')) return;
  const r = await api('/api/engine/kill', { method: 'POST' });
  if (r?.killed) refresh();
};

refresh();
setInterval(refresh, 15_000);
