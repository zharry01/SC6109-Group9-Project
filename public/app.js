// Frontend for the cross-rollup intent router. Vanilla JS + Chart.js (served locally).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (x) => (x == null ? '–' : x >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(4)}`);
const sec = (x) => (x == null ? '–' : `${x.toFixed(1)}s`);
const pct = (x) => (x == null ? '–' : `${(x * 100).toFixed(0)}%`);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const gwei = (g) => (g >= 1 ? g.toFixed(2) : g >= 0.1 ? g.toFixed(3) : g.toFixed(4));

const state = { rollups: [], colors: {}, intents: new Map(), currentId: null, charts: {}, simLoaded: false };

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

// ------------------------------------------------------------------ rollup cards

function renderRollups(list) {
  state.rollups = list;
  const chosen = currentRollup();
  const html = list
    .map((r) => {
      const m = r.metrics;
      const est = r.estimate.transfer;
      const halted = m.halted || m.health === 'stalled';
      return `<div class="rollup ${chosen === r.id ? 'chosen' : ''}" style="--c:${r.color}">
        <div class="rollup-head">
          <div><div class="rollup-name">${esc(r.name)}</div><div class="rollup-label">${esc(r.label)} · chain ${r.chainId}</div></div>
          <span class="badge ${m.health}">${m.health}</span>
        </div>
        <div class="metrics">
          <div class="metric"><span>Block</span><b>#${m.blockNumber}</b></div>
          <div class="metric"><span>Block time</span><b>${r.blockTimeSec}s</b></div>
          <div class="metric"><span>L2 gas price</span><b>${gwei(m.baseFeeWei / 1e9 + r.priorityFeeGwei)} gwei</b></div>
          <div class="metric"><span>Est. fee (transfer)</span><b>${usd(est.totalFeeUsd * 1.1)}</b></div>
          <div class="metric"><span>Est. latency</span><b>${sec(est.latencySec)}</b></div>
          <div class="metric"><span>Success prob.</span><b>${pct(r.successProb)}</b></div>
        </div>
        <div class="cong-row"><span>Congestion · ${m.pendingTx} pending tx</span><span>${pct(m.congestion)}</span></div>
        <div class="bar"><i style="width:${Math.max(2, m.congestion * 100)}%;background-position:${m.congestion * 100}% 0"></i></div>
        <div class="settle">${esc(r.settlement)} · DA ${r.l1FeeGweiPerByte} gwei/byte</div>
        <div class="rollup-actions">
          <button class="small" data-act="congest" data-id="${r.id}">🚦 Congest</button>
          ${halted
            ? `<button class="small" data-act="resume" data-id="${r.id}">▶ Resume</button>`
            : `<button class="small danger" data-act="halt" data-id="${r.id}">⏸ Halt sequencer</button>`}
        </div>
      </div>`;
    })
    .join('');
  $('#rollups').innerHTML = html;
}

// pointerdown (not click): the cards are re-rendered every second, which can swallow a click.
$('#rollups').addEventListener('pointerdown', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  b.disabled = true;
  try {
    await api(`/api/rollups/${b.dataset.id}/${b.dataset.act}`, {});
  } catch (err) {
    alert(err.message);
  }
});

function currentRollup() {
  const rec = state.intents.get(state.currentId);
  return rec?.attempts?.at(-1)?.rollupId ?? null;
}

// ------------------------------------------------------------------ form

$$('.seg').forEach((seg) =>
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setSeg(seg.dataset.name, b.dataset.v);
  }),
);

function setSeg(name, value) {
  const seg = $(`.seg[data-name="${name}"]`);
  $$('button', seg).forEach((x) => x.classList.toggle('on', x.dataset.v === value));
  if (name === 'kind') applyKind(value);
}

function applyKind(kind) {
  $$('.only-transfer, .only-payment, .only-swap').forEach((el) => {
    el.classList.toggle('hidden', !el.classList.contains(`only-${kind}`));
  });
  const form = $('#intent-form');
  if (kind === 'payment') form.recipient.value = 'merchant';
  if (kind === 'swap' && form.tokenOut.value === form.token.value) form.tokenOut.value = form.token.value === 'usdc' ? 'weth' : 'usdc';
}

function formData() {
  const f = $('#intent-form');
  const seg = (n) => $(`.seg[data-name="${n}"] button.on`).dataset.v;
  return {
    user: f.user.value,
    kind: seg('kind'),
    amount: f.amount.value,
    token: f.token.value,
    tokenOut: f.tokenOut.value,
    recipient: f.recipient.value,
    ref: f.ref.value,
    preference: seg('preference'),
    maxFeeUsd: f.maxFeeUsd.value,
    maxLatencySec: f.maxLatencySec.value,
    slippageBps: f.slippageBps.value,
    simulateOutage: f.simulateOutage.checked,
  };
}

function showError(msg) {
  const el = $('#form-error');
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

$('#btn-quote').addEventListener('click', async () => {
  showError('');
  try {
    const q = await api('/api/quote', formData());
    renderRoutes(q);
  } catch (err) {
    showError(err.message);
  }
});

$('#intent-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const btn = $('#btn-exec');
  btn.disabled = true;
  try {
    const rec = await api('/api/intents', formData());
    state.intents.set(rec.id, rec);
    state.currentId = rec.id;
    renderExec(rec);
    $('#exec-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
  }
});

// Natural-language intent -> form (simple rule-based parser).
$('#nl-parse').addEventListener('click', parseNl);
$('#nl-input').addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), parseNl()));

function parseNl() {
  const text = $('#nl-input').value.toLowerCase();
  if (!text.trim()) return;
  const f = $('#intent-form');
  const amount = text.match(/(\d+(?:\.\d+)?)/);
  if (amount) f.amount.value = amount[1];
  const tokens = [...text.matchAll(/\b(usdc|weth|eth)\b/g)].map((m) => (m[1] === 'eth' ? 'weth' : m[1]));
  if (tokens[0]) f.token.value = tokens[0];
  const who = ['alice', 'bob', 'carol'].find((n) => new RegExp(`\\b(i am|as|from) ${n}\\b`).test(text));
  if (who) f.user.value = who;
  let kind = 'transfer';
  if (/\b(swap|exchange|convert|buy|sell)\b/.test(text)) kind = 'swap';
  else if (/\b(pay|payment|merchant|coffee|shop|order)\b/.test(text)) kind = 'payment';
  setSeg('kind', kind);
  if (kind === 'swap' && tokens[1]) f.tokenOut.value = tokens[1];
  const to = text.match(/\bto (alice|bob|carol|merchant|the merchant|coffee shop)\b/);
  if (to && kind !== 'swap') f.recipient.value = /merchant|coffee/.test(to[1]) ? 'merchant' : to[1];
  const order = text.match(/order[ -#]*([a-z0-9-]+)/);
  if (order) f.ref.value = `ORDER-${order[1].toUpperCase()}`;
  if (/cheap|low(est)? fee|save/.test(text)) setSeg('preference', 'cheapest');
  else if (/fast|quick|asap|urgent|now/.test(text)) setSeg('preference', 'fastest');
  else setSeg('preference', 'balanced');
  const within = text.match(/within (\d+(?:\.\d+)?) ?(s|sec|seconds)/);
  if (within) f.maxLatencySec.value = within[1];
  const maxFee = text.match(/(?:fee|pay) (?:under|below|less than|at most) \$?(\d+(?:\.\d+)?)/);
  if (maxFee) f.maxFeeUsd.value = maxFee[1];
  $('#btn-quote').click();
}

// ------------------------------------------------------------------ routes

function renderRoutes(q) {
  $('#route-pref').textContent = `${q.preference} · cost ${q.weights.cost} / latency ${q.weights.latency} / risk ${q.weights.risk}`;
  const isSwap = q.request?.kind === 'swap' || q.all.some((c) => c.amountOutHuman != null);
  const outSym = (q.request?.tokenOut ?? '').toUpperCase();
  const byId = Object.fromEntries(q.ranked.map((c, i) => [c.rollupId, { ...c, rank: i + 1 }]));
  const exById = Object.fromEntries(q.excluded.map((c) => [c.rollupId, c]));
  const order = [...q.ranked.map((c) => c.rollupId), ...q.excluded.map((c) => c.rollupId)];
  const maxScore = Math.max(...q.ranked.map((c) => c.score), 1e-9);
  const rows = order
    .map((id) => {
      const c = byId[id] ?? exById[id];
      const color = state.colors[id];
      const ex = !byId[id];
      const tag = ex ? '<span class="tag ex">excluded</span>' : c.rank === 1 ? '<span class="tag best">chosen</span>' : `<span class="tag alt">#${c.rank}</span>`;
      const score = ex
        ? `<div class="reason">${c.reasons.map(esc).join('<br>')}</div>`
        : `<div class="scorebar" title="cost ${c.components.cost.toFixed(3)} · latency ${c.components.latency.toFixed(3)} · risk ${c.components.risk.toFixed(3)}" style="width:${(c.score / maxScore) * 120}px">
            <i class="c" style="flex:${c.components.cost}"></i><i class="l" style="flex:${c.components.latency}"></i><i class="r" style="flex:${c.components.risk}"></i>
          </div><div class="sub">${c.score.toFixed(3)}</div>`;
      return `<tr class="${ex ? 'excluded' : c.rank === 1 ? 'best' : ''}">
        <td><div class="rid" style="--c:${color}"><span class="swatch"></span>${esc(c.name)}</div><div class="sub">${esc(c.label ?? '')}</div></td>
        <td>${usd(c.feeUsd)}<div class="sub">L2 ${usd(c.l2FeeUsd)} + DA ${usd(c.l1FeeUsd)}</div></td>
        <td>${sec(c.latencySec)}<div class="sub">${c.backlogBlocks ? `${c.backlogBlocks} blocks queued` : 'next block'}</div></td>
        <td>${pct(c.successProb)}<div class="sub">${c.health}</div></td>
        ${isSwap ? `<td>${c.amountOutHuman != null ? c.amountOutHuman.toFixed(outSym === 'WETH' ? 5 : 2) : '–'} ${outSym}<div class="sub">impact ${c.priceImpactPct != null ? c.priceImpactPct.toFixed(2) + '%' : '–'}</div></td>` : ''}
        <td>${score}</td>
        <td>${tag}</td>
      </tr>`;
    })
    .join('');
  $('#routes').classList.remove('empty');
  $('#routes').innerHTML = `
    <table class="route-table">
      <thead><tr><th>Rollup</th><th>Fee</th><th>Latency</th><th>Success</th>${isSwap ? '<th>You receive</th>' : ''}<th>Score</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="legend"><span><i style="background:#e8964f"></i>cost</span><span><i style="background:#5b8fd6"></i>latency</span><span><i style="background:#a965d6"></i>risk</span><span>· shorter bar = better</span></div>
    <ol class="explain">${q.explanation.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>`;
}

// ------------------------------------------------------------------ execution

const STEPS = ['RECEIVED', 'ROUTED', 'SIGNED', 'SUBMITTED', 'CONFIRMED'];
const STEP_LABEL = { RECEIVED: 'Received', ROUTED: 'Routed', SIGNED: 'Signed', SUBMITTED: 'Submitted', CONFIRMED: 'Confirmed' };

function renderExec(rec) {
  const types = rec.timeline.map((e) => e.type);
  const lastRoute = types.lastIndexOf('ROUTED');
  const sinceRoute = new Set(types.slice(Math.max(lastRoute, 0)));
  const failed = rec.status === 'FAILED';
  const reached = (s) => (s === 'RECEIVED' ? true : sinceRoute.has(s));
  const firstPending = STEPS.find((s) => !reached(s));
  const stepper = STEPS.map((s, i) => {
    let cls = reached(s) ? 'done' : '';
    if (!reached(s) && s === firstPending) cls = failed ? 'fail' : 'active';
    return `<div class="step ${cls}"><div class="circle">${reached(s) ? '✓' : failed && s === firstPending ? '✕' : i + 1}</div>${STEP_LABEL[s]}</div>`;
  }).join('');
  const t0 = rec.createdAt;
  const log = rec.timeline
    .map((e) => `<li class="${e.type}"><span class="t">+${((e.t - t0) / 1000).toFixed(1)}s</span>${esc(e.message)}</li>`)
    .join('');
  const r = rec.result;
  const att = rec.attempts.at(-1);
  const result = r
    ? `<div class="status-big CONFIRMED">✓ Executed on ${esc(r.rollupName)}</div>
      <dl>
        <dt>Transaction</dt><dd class="mono">${esc(r.txHash)}</dd>
        <dt>Block</dt><dd>#${r.blockNumber} · gas used ${r.gasUsed.toLocaleString()}</dd>
        <dt>Output</dt><dd>${r.amountOut} ${esc(rec.request.tokenOut.toUpperCase())}</dd>
        <dt>Fee charged</dt><dd>${usd(r.feeChargedUsd)} <span class="sub">(relayer cost ${usd(r.actualCostUsd)})</span></dd>
        <dt>Inclusion</dt><dd>${sec(r.inclusionSec)} <span class="sub">(estimated ${sec(r.estimatedLatencySec)})</span></dd>
        <dt>End-to-end</dt><dd>${sec(r.endToEndSec)} · ${r.attempts} attempt${r.attempts > 1 ? 's (re-routed)' : ''}</dd>
      </dl>`
    : failed
      ? `<div class="status-big FAILED">✕ Failed</div><div class="sub">${esc(rec.timeline.at(-1)?.message)}</div>`
      : `<div class="status-big">⏳ ${esc(rec.status)}${att ? ` on ${esc(att.rollupId)}` : ''}…</div>
         ${att?.signature ? `<dl><dt>Signature</dt><dd class="mono">${esc(att.signature.slice(0, 42))}…</dd>${att.txHash ? `<dt>Tx</dt><dd class="mono">${esc(att.txHash)}</dd>` : ''}</dl>` : ''}`;
  $('#exec').classList.remove('empty');
  $('#exec').innerHTML = `
    <div class="sub" style="margin-bottom:10px">Intent <span class="mono">${esc(rec.id)}</span> · ${esc(describe(rec.request))}</div>
    <div class="stepper">${stepper}</div>
    <div class="exec-grid"><ul class="log">${log}</ul><div class="result">${result}</div></div>`;
  if (rec.routing && rec.id === state.currentId) renderRoutes({ ...rec.routing, request: rec.request });
}

function describe(q) {
  const t = q.token.toUpperCase();
  if (q.kind === 'swap') return `${cap(q.user)} swaps ${q.amount} ${t} → ${q.tokenOut.toUpperCase()} (${q.preference})`;
  if (q.kind === 'payment') return `${cap(q.user)} pays ${q.amount} ${t} to ${q.recipientKey} · ${q.ref} (${q.preference})`;
  return `${cap(q.user)} sends ${q.amount} ${t} to ${q.recipientKey} (${q.preference})`;
}

// ------------------------------------------------------------------ tabs

$$('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== `tab-${b.dataset.tab}`));
    if (b.dataset.tab === 'balances') loadBalances();
    if (b.dataset.tab === 'analytics') loadStats();
    if (b.dataset.tab === 'sim') loadSim();
  }),
);

function renderHistory() {
  const list = [...state.intents.values()].sort((a, b) => b.createdAt - a.createdAt);
  if (!list.length) {
    $('#tab-history').innerHTML = '<div class="empty">No intents yet.</div>';
    return;
  }
  $('#tab-history').innerHTML = `<table class="list">
    <thead><tr><th>Time</th><th>ID</th><th>Intent</th><th>Executed on</th><th>Status</th><th>Fee</th><th>Latency</th><th>Attempts</th></tr></thead>
    <tbody>${list
      .map((r) => {
        const st = r.status === 'CONFIRMED' || r.status === 'FAILED' ? r.status : 'other';
        const rid = r.result?.rollupId ?? r.attempts.at(-1)?.rollupId;
        return `<tr class="click" data-id="${r.id}">
          <td>${new Date(r.createdAt).toLocaleTimeString()}</td>
          <td class="mono">${esc(r.id)}</td>
          <td>${esc(describe(r.request))}</td>
          <td>${rid ? `<span class="rid" style="--c:${state.colors[rid]}"><span class="swatch"></span>${rid}</span>` : '–'}</td>
          <td><span class="st ${st}">${esc(r.status)}</span></td>
          <td>${usd(r.result?.feeChargedUsd)}</td>
          <td>${sec(r.result?.endToEndSec)}</td>
          <td>${r.attempts.length}</td>
        </tr>`;
      })
      .join('')}</tbody></table>`;
}

$('#tab-history').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  state.currentId = tr.dataset.id;
  renderExec(state.intents.get(tr.dataset.id));
  $('#exec-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

async function loadBalances() {
  const b = await api('/api/balances');
  const ids = state.rollups.map((r) => r.id);
  $('#tab-balances').innerHTML = `<table class="list">
    <thead><tr><th>Account</th>${ids.map((id) => `<th>${id} · USDC</th><th>${id} · WETH</th>`).join('')}</tr></thead>
    <tbody>${Object.entries(b)
      .map(
        ([name, v]) => `<tr><td><b>${cap(name)}</b> <span class="sub mono">${v.address.slice(0, 8)}…</span></td>${ids
          .map((id) => {
            const x = v.rollups[id];
            return x ? `<td>${x.usdc.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td><td>${x.weth.toFixed(4)}</td>` : '<td>–</td><td>–</td>';
          })
          .join('')}</tr>`,
      )
      .join('')}</tbody></table>
    <p class="hint">Same address on every rollup. The router checks the balance on each rollup before routing (insufficient balance ⇒ route excluded).</p>`;
}

// ------------------------------------------------------------------ charts

function chart(id, config) {
  state.charts[id]?.destroy();
  state.charts[id] = new Chart($(`#${id}`), config);
}

async function loadStats() {
  const s = await api('/api/stats');
  $('#stats-kpis').innerHTML = [
    ['Intents', s.total],
    ['Confirmed', s.confirmed],
    ['Re-routed', s.rerouted],
    ['Avg fee', usd(s.avgFeeUsd)],
    ['Avg end-to-end', sec(s.avgEndToEndSec)],
  ]
    .map(([k, v]) => `<div class="kpi"><span>${k}</span><b>${v}</b></div>`)
    .join('');
  const entries = Object.entries(s.comparison).filter(([, v]) => v);
  const labels = entries.map(([k, v]) => (v.infeasible ? `${k} (${v.infeasible} infeasible)` : k));
  chart('ch-compare', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'avg fee (USD)', data: entries.map(([, v]) => v.avgFeeUsd ?? null), backgroundColor: '#e8964f', yAxisID: 'y' },
        { label: 'avg est. latency (s)', data: entries.map(([, v]) => v.avgLatencySec ?? null), backgroundColor: '#5b8fd6', yAxisID: 'y1' },
      ],
    },
    options: { maintainAspectRatio: false, scales: { y: { title: { display: true, text: 'USD' } }, y1: { position: 'right', grid: { display: false }, title: { display: true, text: 'seconds' } } } },
  });
  const ids = Object.keys(s.perRollup);
  chart('ch-share', {
    type: 'doughnut',
    data: { labels: ids.map((id) => `Rollup ${id}`), datasets: [{ data: ids.map((id) => s.perRollup[id].confirmed), backgroundColor: ids.map((id) => state.colors[id]), borderWidth: 0 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'right' } } },
  });
}

const STRAT_STYLE = {
  'always A': { c: '#e8734a', dash: [5, 4] },
  'always B': { c: '#4a90d9', dash: [5, 4] },
  'always C': { c: '#5bb174', dash: [5, 4] },
  'round-robin': { c: '#9aa0ab', dash: [2, 3] },
  'router: cheapest': { c: '#c9a227', dash: [] },
  'router: balanced': { c: '#d9772b', dash: [], w: 3.5 },
};

async function loadSim(force = false) {
  if (state.simLoaded && !force) return;
  const sim = await api('/api/sim');
  state.simLoaded = true;
  const ds = (key, scale = 1) =>
    sim.strategies.map((s) => ({
      label: s,
      data: sim.sweep[s].map((r) => (r[key] == null ? null : r[key] * scale)),
      borderColor: STRAT_STYLE[s].c,
      backgroundColor: STRAT_STYLE[s].c,
      borderDash: STRAT_STYLE[s].dash,
      borderWidth: STRAT_STYLE[s].w ?? 2,
      pointRadius: 2,
      tension: 0.25,
    }));
  const lineOpts = (yTitle, extra = {}) => ({
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    scales: { x: { title: { display: true, text: 'offered load λ (intents/s)' } }, y: { title: { display: true, text: yTitle }, ...extra } },
    plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } } },
  });
  const labels = sim.lambdas;
  chart('ch-thr', { type: 'line', data: { labels, datasets: ds('throughput') }, options: lineOpts('confirmed intents/s', { beginAtZero: true }) });
  chart('ch-fail', { type: 'line', data: { labels, datasets: ds('failRate', 100) }, options: lineOpts('% expired', { beginAtZero: true, max: 100 }) });
  chart('ch-lat', { type: 'line', data: { labels, datasets: ds('avgLatency') }, options: lineOpts('seconds', { beginAtZero: true }) });
  chart('ch-fee', { type: 'line', data: { labels, datasets: ds('avgFeeUsd') }, options: lineOpts('USD per intent', { type: 'logarithmic' }) });
  const tl = sim.incident[sim.strategies[0]].timeline.map((b) => `${b.t}s`);
  chart('ch-incident', {
    type: 'line',
    data: {
      labels: tl,
      datasets: sim.strategies.map((s) => ({
        label: `${s} (fail ${(sim.incident[s].failRate * 100).toFixed(0)}%)`,
        data: sim.incident[s].timeline.map((b) => b.avgLatency),
        borderColor: STRAT_STYLE[s].c,
        borderDash: STRAT_STYLE[s].dash,
        borderWidth: STRAT_STYLE[s].w ?? 2,
        pointRadius: 2,
        spanGaps: false,
        tension: 0.2,
      })),
    },
    options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { x: { title: { display: true, text: 'simulation time' } }, y: { beginAtZero: true, title: { display: true, text: 'avg latency (s)' } } }, plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } } } },
  });
  $('#sim-table').innerHTML = `<table class="list"><thead><tr><th>Incident replay</th><th>fail rate</th><th>avg latency</th><th>p95 latency</th><th>avg fee</th><th>executed on</th></tr></thead><tbody>${sim.strategies
    .map((s) => {
      const r = sim.incident[s];
      return `<tr><td>${s}</td><td>${pct(r.failRate)}</td><td>${sec(r.avgLatency)}</td><td>${sec(r.p95Latency)}</td><td>${usd(r.avgFeeUsd)}</td><td>${Object.entries(r.share).map(([k, v]) => `${k}: ${v}`).join(' · ')}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

// ------------------------------------------------------------------ live stream

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => {
    $('#live-dot').classList.add('on');
    $('#live-text').textContent = 'live';
  };
  es.onerror = () => {
    $('#live-dot').classList.remove('on');
    $('#live-text').textContent = 'reconnecting…';
  };
  es.addEventListener('rollups', (e) => renderRollups(JSON.parse(e.data)));
  es.addEventListener('intent', (e) => {
    const rec = JSON.parse(e.data);
    state.intents.set(rec.id, rec);
    if (rec.id === state.currentId) renderExec(rec);
    renderHistory();
    if (rec.status === 'CONFIRMED' || rec.status === 'FAILED') {
      if (!$('#tab-analytics').classList.contains('hidden')) loadStats();
      if (!$('#tab-balances').classList.contains('hidden')) loadBalances();
    }
  });
}

async function init() {
  Chart.defaults.color = '#6b7180';
  Chart.defaults.borderColor = '#e8e5de';
  Chart.defaults.font.family = 'Inter, -apple-system, sans-serif';
  const cfg = await api('/api/config');
  state.colors = Object.fromEntries(cfg.rollups.map((r) => [r.id, r.color]));
  renderRollups(cfg.rollups);
  for (const rec of await api('/api/intents')) state.intents.set(rec.id, rec);
  renderHistory();
  connect();
}

init();
