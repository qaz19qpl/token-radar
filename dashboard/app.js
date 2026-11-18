/* Token Radar — the page's whole behaviour. Data arrives as window.RADAR (data.js, written by
   main.ts from the same board as board.json); nothing is fetched and nothing leaves the page. */

'use strict';

const R = window.RADAR;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** $1.23B / $456M / $7.89K / $950 — compact dollars for tables. */
function money(v) {
  if (v === null || v === undefined) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}
const moneyFull = (v) => (v === null || v === undefined ? '—' : `$${Math.round(v).toLocaleString('en-US')}`);
const pct = (v) => {
  if (v === null || v === undefined) return '<span class="flat">—</span>';
  const cls = v > 0.05 ? 'up' : v < -0.05 ? 'down' : 'flat';
  return `<span class="${cls}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
};
const ageText = (days) => {
  if (days === null || days === undefined) return '—';
  if (days >= 730) return `${(days / 365.25).toFixed(1)} yrs`;
  if (days >= 60) return `${Math.round(days / 30.4)} mo`;
  return `${days} d`;
};
const chainText = (chains) => (chains.length === 0 ? '—' : chains.length <= 2 ? esc(chains.join(', ')) : `${esc(chains.slice(0, 2).join(', '))} +${chains.length - 2}`);

/* ------------------------------------------------------------- state and hash */

const state = { view: 'board', q: '', cat: '', chain: '', tier: '', status: '', sort: 'rank', dir: 1, detail: '' };

function readHash() {
  // The hash is the whole state: a parameter it omits falls back to its default, so a link
  // that names only a filter never inherits a detail panel or a search from an earlier view.
  const h = new URLSearchParams(location.hash.replace(/^#\/?/, ''));
  const fresh = { view: 'board', q: '', cat: '', chain: '', tier: '', status: '', sort: 'rank', dir: 1, detail: '' };
  for (const k of Object.keys(fresh)) {
    if (h.has(k)) fresh[k] = k === 'dir' ? (h.get(k) === '-1' ? -1 : 1) : h.get(k);
  }
  Object.assign(state, fresh);
}
let writingHash = false;
function writeHash() {
  const h = new URLSearchParams();
  if (state.view !== 'board') h.set('view', state.view);
  for (const k of ['q', 'cat', 'chain', 'tier', 'status', 'detail']) if (state[k]) h.set(k, state[k]);
  if (state.sort !== 'rank') h.set('sort', state.sort);
  if (state.dir !== 1) h.set('dir', '-1');
  writingHash = true;
  history.replaceState(null, '', `#${h.toString()}`);
  writingHash = false;
}
window.addEventListener('hashchange', () => {
  if (writingHash) return;
  readHash();
  syncControls();
  render();
});

/* ------------------------------------------------------------- static panels */

function renderChrome() {
  $('stamp').innerHTML = `Snapshot as of <b>${esc(R.as_of)}</b>Sealed DefiLlama pull, identical for every run`;
  const stats = [
    [String(R.scanned), 'protocols scanned', ''],
    [`${R.watchlist_size} / ${R.watchlist_size}`, 'watchlist covered', ''],
    [String(R.board_size), 'pre-token rows ranked', 'hot'],
    [String(R.early_size), 'early finds past the floor', ''],
    [String(R.live_size), 'trading, set aside', ''],
  ];
  $('stats').innerHTML = stats.map(([b, s, c]) => `<div class="stat ${c}"><b>${b}</b><span>${s}</span></div>`).join('');

  const m = R.model;
  const topCats = R.categories.filter((c) => c.peers >= 3).slice(0, 10);
  $('model').innerHTML = `
    <h2>How a row earns its value — <em>peer-anchored model ${esc(m.version)}</em></h2>
    <div class="formula">implied value = TVL &times; <span class="f">peer multiple</span> &times; <span class="f">momentum</span> &times; <span class="f">maturity</span> &times; <span class="f">breadth</span></div>
    <p>The <b>peer multiple</b> is what the market pays per dollar of TVL for tokens that already trade:
    the median market-cap / TVL of the snapshot's own ${R.peer_protocols} tokenised protocols in the same
    category (global median <b>${R.global_median.toFixed(3)}&times;</b>), shrunk toward that global median
    when a category has few peers and clamped to ${m.multiple_min}&times;–${m.multiple_max}&times;.
    <b>Momentum</b> scales value by the 7-day TVL change (clamped ${m.momentum_floor_pct}% to +${m.momentum_cap_pct}%,
    weight ${m.momentum_weight}). <b>Maturity</b> rises from ${m.maturity_floor} to ${(m.maturity_floor + m.maturity_span).toFixed(2)}
    over ${m.maturity_days} days of tokenless record. <b>Breadth</b> adds ${m.breadth_weight} &times; ln(1 + chains).
    Open any row to see its own arithmetic — the same figures that produced board.json.</p>
    <div class="peers">${topCats.map((c) => `<span>${esc(c.category)}: <b>${c.multiple.toFixed(3)}&times;</b> (${c.peers} peers)</span>`).join('')}</div>`;

  $('source-line').textContent = `Source: ${R.source}. Board floor: protocols at or above ${money(R.floor_usd)} of TVL that record no token form the watchlist; the radar ranks past it.`;
}

function fillFilters() {
  const cats = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort();
  $('f-cat').innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  $('f-chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => `<option>${esc(c)}</option>`).join('');
}

function syncControls() {
  $('f-q').value = state.q;
  $('f-cat').value = state.cat;
  $('f-chain').value = state.chain;
  $('f-tier').value = state.tier;
  $('f-status').value = state.status;
}

/* ------------------------------------------------------------- the board */

const COLUMNS = [
  { key: 'rank', label: '#', cls: '' },
  { key: 'name', label: 'Protocol', cls: '' },
  { key: 'category', label: 'Category', cls: '' },
  { key: 'chains', label: 'Chains', cls: '' },
  { key: 'tvl', label: 'TVL', cls: 'n' },
  { key: 'change', label: '7d', cls: 'n' },
  { key: 'age', label: 'Age', cls: 'n' },
  { key: 'implied', label: 'Implied value', cls: 'n' },
  { key: 'mult', label: 'x TVL', cls: 'n' },
];
const valueOf = (r, key) => {
  switch (key) {
    case 'rank': return r.rank;
    case 'name': return r.name.toLowerCase();
    case 'category': return (r.category ?? '').toLowerCase();
    case 'chains': return r.chains.length;
    case 'tvl': return r.tvl_usd;
    case 'change': return r.change_7d ?? -Infinity;
    case 'age': return r.model.age_days ?? -1;
    case 'implied': return r.implied_value_usd;
    case 'mult': return r.implied_value_usd / r.tvl_usd;
    default: return r.rank;
  }
};

function tierOk(tvl) {
  switch (state.tier) {
    case 'b1': return tvl >= 1e9;
    case 'm250': return tvl >= 250e6 && tvl < 1e9;
    case 'm50': return tvl >= 50e6 && tvl < 250e6;
    case 'u50': return tvl < 50e6;
    default: return true;
  }
}

function visibleRows() {
  const q = state.q.trim().toLowerCase();
  let rows = R.rows.filter((r) =>
    (q === '' || r.name.toLowerCase().includes(q) || r.slug.includes(q)) &&
    (state.cat === '' || r.category === state.cat) &&
    (state.chain === '' || r.chains.includes(state.chain)) &&
    (state.status === '' || (state.status === 'watch' ? r.on_watchlist : !r.on_watchlist)) &&
    tierOk(r.tvl_usd));
  const key = state.sort;
  rows = rows.sort((a, b) => {
    const va = valueOf(a, key);
    const vb = valueOf(b, key);
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return cmp * state.dir || a.rank - b.rank;
  });
  return rows;
}

function renderBoard() {
  $('board-head').innerHTML = COLUMNS.map((c) =>
    `<th class="${c.cls} sortable" data-sort="${c.key}">${c.label}${state.sort === c.key ? ` <span class="dir">${state.dir === 1 ? '▲' : '▼'}</span>` : ''}</th>`).join('');
  const rows = visibleRows();
  $('board-body').innerHTML = rows.map((r) => `
    <tr class="row" data-slug="${esc(r.slug)}">
      <td class="rank">${r.rank}</td>
      <td><span class="pname">${esc(r.name)}</span><span class="badge ${r.on_watchlist ? 'watch' : 'early'}">${r.on_watchlist ? 'Watchlist' : 'Early find'}</span><br><span class="pslug">${esc(r.slug)}</span></td>
      <td class="cat">${esc(r.category ?? '—')}</td>
      <td class="chains">${chainText(r.chains)}</td>
      <td class="n">${money(r.tvl_usd)}</td>
      <td class="n">${pct(r.change_7d)}</td>
      <td class="n">${ageText(r.model.age_days)}</td>
      <td class="n implied">${money(r.implied_value_usd)}</td>
      <td class="n mult">${(r.implied_value_usd / r.tvl_usd).toFixed(2)}&times;</td>
    </tr>`).join('');
  $('board-empty').hidden = rows.length > 0;
  $('count').textContent = `${rows.length} of ${R.board_size} rows`;
  for (const th of document.querySelectorAll('#board-head th')) {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (state.sort === key) state.dir = state.dir === 1 ? -1 : 1;
      else { state.sort = key; state.dir = key === 'name' || key === 'category' ? 1 : -1; }
      writeHash();
      renderBoard();
    });
  }
  for (const tr of document.querySelectorAll('#board-body tr.row')) {
    tr.addEventListener('click', () => openDetail(tr.getAttribute('data-slug')));
  }
}

/* ------------------------------------------------------------- the live view */

function renderLive() {
  $('live-head').innerHTML = ['Protocol', 'Category', 'Chains', 'TVL', 'Market cap', 'Mcap / TVL', '7d']
    .map((h, i) => `<th class="${i >= 3 ? 'n' : ''}">${h}</th>`).join('');
  $('live-body').innerHTML = R.live.map((r) => `
    <tr>
      <td><span class="pname">${esc(r.name)}</span><br><span class="pslug">${esc(r.slug)}</span></td>
      <td class="cat">${esc(r.category ?? '—')}</td>
      <td class="chains">${chainText(r.chains)}</td>
      <td class="n">${money(r.tvl_usd)}</td>
      <td class="n implied">${money(r.mcap_usd)}</td>
      <td class="n mult">${(r.mcap_usd / r.tvl_usd).toFixed(2)}&times;</td>
      <td class="n">${pct(r.change_7d)}</td>
    </tr>`).join('');
}

/* ------------------------------------------------------------- detail view */

function openDetail(slug) {
  state.detail = slug ?? '';
  writeHash();
  renderDetail();
}
function closeDetail() {
  state.detail = '';
  writeHash();
  renderDetail();
}

function renderDetail() {
  const panel = $('detail');
  const r = R.rows.find((x) => x.slug === state.detail);
  if (!r) {
    panel.hidden = true;
    $('scrim').hidden = true;
    return;
  }
  const m = r.model;
  const peerLine = m.peer_count > 0
    ? `median of ${m.peer_count} tokenised ${esc(r.category ?? 'uncategorised')} peer${m.peer_count === 1 ? '' : 's'}: ${m.category_median === null ? '—' : `${m.category_median.toFixed(3)}×`}, shrunk toward the global median of ${R.global_median.toFixed(3)}×`
    : `no tokenised ${esc(r.category ?? 'uncategorised')} peers in the snapshot: the global median of ${R.global_median.toFixed(3)}× applies`;
  panel.innerHTML = `
    <button type="button" class="close" id="d-close" aria-label="Close">✕</button>
    <h2>${esc(r.name)}</h2>
    <p class="sub">${esc(r.slug)} · ${esc(r.category ?? 'Uncategorised')} · rank #${r.rank} of ${R.board_size}
      <span class="badge ${r.on_watchlist ? 'watch' : 'early'}">${r.on_watchlist ? 'Watchlist' : 'Early find'}</span>
      <span class="badge early">Records no token</span></p>
    <div class="figs">
      <div class="fig"><b>${moneyFull(r.tvl_usd)}</b><span>Total value locked</span></div>
      <div class="fig"><b>${moneyFull(r.implied_value_usd)}</b><span>Implied value</span></div>
      <div class="fig"><b>${(r.implied_value_usd / r.tvl_usd).toFixed(2)}&times;</b><span>Implied / TVL</span></div>
      <div class="fig"><b>${r.change_7d === null ? '—' : `${r.change_7d > 0 ? '+' : ''}${r.change_7d.toFixed(1)}%`}</b><span>TVL change, 7d</span></div>
      <div class="fig"><b>${m.age_days === null ? 'Unknown' : `${m.age_days.toLocaleString('en-US')} days`}</b><span>Tokenless record${r.listed_at ? ` since ${esc(r.listed_at)}` : ''}</span></div>
      <div class="fig"><b>${r.chains.length}</b><span>Chains: ${esc(r.chains.join(', ') || '—')}</span></div>
    </div>
    <h3>How this value is derived</h3>
    <div class="arith">
      <div class="row"><span>TVL (snapshot)</span><span>${moneyFull(r.tvl_usd)}</span></div>
      <div class="row"><span>&times; peer multiple</span><span>${m.peer_multiple.toFixed(4)}&times;</span></div>
      <div class="row"><span>&times; momentum (7d ${r.change_7d === null ? 'unreported' : `${r.change_7d.toFixed(1)}%`})</span><span>${m.momentum_multiplier.toFixed(4)}&times;</span></div>
      <div class="row"><span>&times; maturity (${m.age_days === null ? 'age unknown, scored mid' : `${m.age_days} days`})</span><span>${m.maturity_multiplier.toFixed(4)}&times;</span></div>
      <div class="row"><span>&times; breadth (${r.chains.length} chains)</span><span>${m.breadth_multiplier.toFixed(4)}&times;</span></div>
      <div class="row total"><span>Implied value</span><span>${moneyFull(r.implied_value_usd)}</span></div>
    </div>
    <p class="fineprint">Peer multiple: ${peerLine}. Every figure comes from the sealed snapshot; open the model panel on the board for the constants.</p>
    <h3>The farm plan</h3>
    <ol class="plan">${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    <p class="fineprint">Costs are the plan's own estimates in dollars at snapshot time. Positions in unaudited protocols can be lost in full; the plan sizes accordingly.</p>`;
  panel.hidden = false;
  $('scrim').hidden = false;
  $('d-close').addEventListener('click', closeDetail);
}

/* ------------------------------------------------------------- wiring */

function render() {
  const live = state.view === 'live';
  $('boardwrap').hidden = live;
  $('livewrap').hidden = !live;
  $('controls').style.display = live ? 'none' : '';
  $('tab-board').classList.toggle('active', !live);
  $('tab-live').classList.toggle('active', live);
  if (live) renderLive(); else renderBoard();
  renderDetail();
}

for (const [id, key] of [['f-q', 'q'], ['f-cat', 'cat'], ['f-chain', 'chain'], ['f-tier', 'tier'], ['f-status', 'status']]) {
  $(id).addEventListener('input', () => {
    state[key] = $(id).value;
    writeHash();
    renderBoard();
  });
}
$('tab-board').addEventListener('click', () => { state.view = 'board'; writeHash(); render(); });
$('tab-live').addEventListener('click', () => { state.view = 'live'; writeHash(); render(); });
$('scrim').addEventListener('click', closeDetail);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

readHash();
renderChrome();
fillFilters();
syncControls();
render();
