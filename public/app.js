// Footsy100 front end: a small vanilla JS single-page app.

const MICRO = 1_000_000;
const app = document.getElementById('app');
const state = { me: null, market: null, config: null };

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (p) => `${p < 0 ? '-' : ''}£${(Math.abs(p) / 100).toFixed(2)}`;
const shares = (m) => (m / MICRO).toLocaleString('en-GB', { maximumFractionDigits: 4 });
const pct = (now, before) => (before ? ((now - before) / before) * 100 : 0);
const pctText = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'muted');
const when = (iso) =>
  iso ? new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'TBC';

// Official Premier League photos and crests, keyed by FPL's `code` fields. The
// PL moved its image paths for 2025/26, so the older path is tried next, and a
// plain placeholder shows if neither has the image (e.g. a new signing).
const PL_CDN = 'https://resources.premierleague.com/premierleague';
const IMAGE_URLS = {
  photo: (c) => [`${PL_CDN}25/photos/players/110x140/${c}.png`, `${PL_CDN}/photos/players/110x140/p${c}.png`],
  crest: (c) => [`${PL_CDN}25/badges/${c}.svg`, `${PL_CDN}/badges/70/t${c}.png`],
};
function img(kind, code, size = 'sm') {
  const cls = `${kind} ${kind}-${size}`;
  if (!code) return `<span class="${cls} img-missing" aria-hidden="true"></span>`;
  const [src, ...fallbacks] = IMAGE_URLS[kind](code);
  return `<img class="${cls}" src="${src}" data-fallback="${fallbacks.join(' ')}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
}
// Image errors don't bubble, so listen in the capture phase.
document.addEventListener(
  'error',
  (e) => {
    const el = e.target;
    if (!(el instanceof HTMLImageElement) || el.dataset.fallback === undefined) return;
    const [next, ...rest] = el.dataset.fallback.split(' ').filter(Boolean);
    if (next) {
      el.dataset.fallback = rest.join(' ');
      el.src = next;
    } else {
      const span = document.createElement('span');
      span.className = `${el.className} img-missing`;
      span.setAttribute('aria-hidden', 'true');
      el.replaceWith(span);
    }
  },
  true,
);

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

function navigate(path) {
  history.pushState(null, '', path);
  route();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    navigate(a.getAttribute('href'));
  }
});
window.addEventListener('popstate', route);

function emptyMarketText() {
  const s = state.status?.last_sync;
  if (!s) return 'Player data hasn\'t loaded yet. The first sync runs within 15 minutes of deploying.';
  if (!s.ok) return `Player data couldn't be loaded. Last sync failed ${esc(when(s.at))}: ${esc(s.error)}`;
  return 'Player data hasn\'t loaded yet.';
}

async function loadMarket(force = false) {
  if (!state.market || force) state.market = await api('/players');
  if (!state.market.players.length) state.status = await api('/status').catch(() => null);
  const m = state.market;
  m.teamById = Object.fromEntries(m.teams.map((t) => [t.id, t]));
  m.locked = new Set(m.locked_teams);
  return m;
}

function renderAccount() {
  const el = document.getElementById('account');
  el.innerHTML = state.me
    ? `<a href="/account" data-link>${esc(state.me.display_name)}</a>`
    : `<a href="/login" data-link><button class="primary">Sign in</button></a>`;
}

function needLogin() {
  app.innerHTML = `<div class="card login"><h1>Sign in to play</h1><p class="muted">You get £100 of fake money to invest in Premier League players.</p><a href="/login" data-link><button class="primary">Sign in</button></a></div>`;
}

// ---------- pages ----------
async function marketPage() {
  const m = await loadMarket();
  const prefs = (marketPage.prefs ??= { q: '', team: '', pos: '', sort: 'price', dir: -1 });
  app.innerHTML = `
    <h1>Market</h1>
    <p class="muted">Buy shares at today's price. Trading on a player locks ${m.lock_hours} hours before his team kicks off and reopens once the match is settled.</p>
    ${m.players.length ? moversSection(m) : ''}
    <div class="toolbar">
      <input id="q" placeholder="Search players" value="${esc(prefs.q)}">
      <select id="team"><option value="">All teams</option>${m.teams.map((t) => `<option value="${t.id}" ${String(t.id) === prefs.team ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <select id="pos"><option value="">All positions</option>${['GKP', 'DEF', 'MID', 'FWD'].map((p) => `<option ${p === prefs.pos ? 'selected' : ''}>${p}</option>`).join('')}</select>
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th class="sortable" data-sort="name">Player</th><th>Team</th><th>Pos</th>
        <th class="sortable num" data-sort="price">Price</th><th class="sortable num" data-sort="change">Last match</th>
        <th class="hide-sm">Next match</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table></div>`;

  const draw = () => {
    const q = prefs.q.toLowerCase();
    let list = m.players.filter(
      (p) =>
        (!prefs.team || String(p.team_id) === prefs.team) &&
        (!prefs.pos || p.position === prefs.pos) &&
        (!q || `${p.first_name} ${p.second_name} ${p.web_name}`.toLowerCase().includes(q)),
    );
    const key = { name: (p) => p.web_name, price: (p) => p.price_pence, change: (p) => pct(p.price_pence, p.prev_price_pence) }[prefs.sort];
    list = list.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * prefs.dir).slice(0, 300);
    document.getElementById('rows').innerHTML =
      list
        .map((p) => {
          const ch = pct(p.price_pence, p.prev_price_pence);
          const nf = m.next_fixtures[p.team_id];
          const opp = nf ? `${esc(m.teamById[nf.opponent]?.short_name)} (${nf.home ? 'H' : 'A'}) · ${when(nf.kickoff_time)}` : '<span class="muted">None</span>';
          return `<tr class="clickable" data-id="${p.id}">
            <td><span class="who">${img('photo', p.code)}<span><b>${esc(p.web_name)}</b>${p.status !== 'a' ? ' <span class="badge" title="Availability flag from FPL">!</span>' : ''}${m.locked.has(p.team_id) ? ' <span class="badge lock show-sm">Locked</span>' : ''}</span></span></td>
            <td><span class="who">${img('crest', m.teamById[p.team_id]?.code)}${esc(m.teamById[p.team_id]?.short_name)}</span></td>
            <td><span class="badge pos">${p.position}</span></td>
            <td class="num">${money(p.price_pence)}</td>
            <td class="num ${cls(ch)}">${p.prev_price_pence ? pctText(ch) : '–'}</td>
            <td class="hide-sm">${m.locked.has(p.team_id) ? '<span class="badge lock">Locked</span> ' : ''}<span class="small">${opp}</span></td>
          </tr>`;
        })
        .join('') || `<tr><td colspan="6" class="empty">${m.players.length ? 'No players found.' : emptyMarketText()}</td></tr>`;
  };
  draw();

  document.getElementById('q').addEventListener('input', (e) => ((prefs.q = e.target.value), draw()));
  document.getElementById('team').addEventListener('change', (e) => ((prefs.team = e.target.value), draw()));
  document.getElementById('pos').addEventListener('change', (e) => ((prefs.pos = e.target.value), draw()));
  app.querySelectorAll('th[data-sort]').forEach((th) =>
    th.addEventListener('click', () => {
      prefs.dir = prefs.sort === th.dataset.sort ? -prefs.dir : th.dataset.sort === 'name' ? 1 : -1;
      prefs.sort = th.dataset.sort;
      draw();
    }),
  );
  app.querySelectorAll('tbody').forEach((tb) =>
    tb.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr) navigate(`/player/${tr.dataset.id}`);
    }),
  );
}

// Top 10 risers and fallers over the last week, by % change.
function moversSection(m) {
  const byId = (m.playerById ??= Object.fromEntries(m.players.map((p) => [p.id, p])));
  const list = (title, rows) => {
    const body = rows
      .map((r, i) => {
        const p = byId[r.player_id];
        if (!p) return '';
        const ch = pct(r.to_pence, r.from_pence);
        return `<tr class="clickable" data-id="${p.id}">
          <td class="num muted">${i + 1}</td>
          <td><span class="who">${img('photo', p.code)}<span><b>${esc(p.web_name)}</b> <span class="muted small">${esc(m.teamById[p.team_id]?.short_name)}</span></span></span></td>
          <td class="num">${money(r.to_pence)}</td>
          <td class="num ${cls(ch)}">${pctText(ch)}</td>
        </tr>`;
      })
      .join('');
    return `<div><h2>${title}</h2><div class="table-wrap"><table>
      <tbody>${body || `<tr><td colspan="4" class="empty">No price moves in the last ${m.movers.days} days yet.</td></tr>`}</tbody>
    </table></div></div>`;
  };
  return `<div class="movers">${list('Top risers', m.movers.risers)}${list('Top fallers', m.movers.fallers)}</div>
    <p class="muted small">Biggest price changes over the last ${m.movers.days} days. Prices move when a player's match is settled.</p>`;
}

function sparkline(points) {
  if (points.length < 2) return '<p class="muted small">Price history appears after his first settled match.</p>';
  const w = 600, h = 120, pad = 6;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const xy = points.map((v, i) => [pad + (i * (w - 2 * pad)) / (points.length - 1), h - pad - ((v - min) * (h - 2 * pad)) / span]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Price history">
    <path class="area" d="${line}L${w - pad},${h}L${pad},${h}Z"/><path class="line" d="${line}"/></svg>`;
}

// Next match card plus the few after it, for a player's team.
function upcomingFixtures(list, teamId, teamById) {
  if (!list.length) return '<h2>Next match</h2><p class="muted">No upcoming matches scheduled.</p>';
  const [next, ...rest] = list;
  const vs = (f) => {
    const home = f.team_h === teamId;
    return { opp: teamById[home ? f.team_a : f.team_h], home };
  };
  const n = vs(next);
  const lockAt = next.kickoff_time ? new Date(new Date(next.kickoff_time).getTime() - (state.market?.lock_hours ?? 2) * 3_600_000).toISOString() : null;
  return `
    <h2>Next match</h2>
    <div class="card next-match">
      <div class="nm-teams"><span class="who">${img('crest', teamById[next.team_h]?.code)}${esc(teamById[next.team_h]?.name)}</span> <span class="muted">v</span> <span class="who">${img('crest', teamById[next.team_a]?.code)}${esc(teamById[next.team_a]?.name)}</span></div>
      <div class="muted">${n.home ? 'Home' : 'Away'} vs ${esc(n.opp?.name)}${next.event ? ` · Gameweek ${next.event}` : ''}</div>
      <div class="nm-when">${next.finished_provisional ? '<span class="badge lock">Full time, waiting for final stats</span>' : next.started ? '<span class="badge lock">In play</span>' : when(next.kickoff_time)}</div>
      ${lockAt && !next.started ? `<div class="small muted">Trading on him locks ${when(lockAt)}</div>` : ''}
    </div>
    ${
      rest.length
        ? `<div class="table-wrap coming-up"><table><tbody>${rest
            .map((f) => {
              const v = vs(f);
              return `<tr><td><span class="who">${img('crest', v.opp?.code)}${esc(v.opp?.name)} (${v.home ? 'H' : 'A'})</span></td><td class="small muted">${f.event ? `GW${f.event}` : ''}</td><td class="num small">${when(f.kickoff_time)}</td></tr>`;
            })
            .join('')}</tbody></table></div>`
        : ''
    }`;
}

const STAT_LABELS = { goals: 'G', assists: 'A', clean_sheet: 'CS', yellow_cards: 'YC', red_cards: 'RC', saves: 'Sv', bonus: 'Bonus' };

async function playerPage(id) {
  const [d, m] = await Promise.all([api(`/players/${id}`), loadMarket()]);
  const p = d.player;
  const ch = pct(p.price_pence, p.prev_price_pence);
  const prices = d.history.length ? [d.history[d.history.length - 1].old_price_pence, ...d.history.slice().reverse().map((h) => h.new_price_pence)] : [];
  const feePct = (state.config?.sell_fee_bp ?? 200) / 100;

  app.innerHTML = `
    <p><a href="/" data-link>← Market</a></p>
    <div class="player-head">
      ${img('photo', p.code, 'lg')}
      <div>
        <h1>${esc(p.first_name)} ${esc(p.second_name)}</h1>
        <p class="muted who">${img('crest', p.team_code)}${esc(p.team_name)} · ${p.position}</p>
      </div>
    </div>
    <div class="grid grid-2">
      <div>
        <div class="stats">
          <div class="stat"><div class="label">Price</div><div class="value">${money(p.price_pence)}</div></div>
          <div class="stat"><div class="label">Last match</div><div class="value ${cls(ch)}">${p.prev_price_pence ? pctText(ch) : '–'}</div></div>
          ${d.holding ? `<div class="stat"><div class="label">You own</div><div class="value">${shares(d.holding.shares_micro)}</div><div class="small muted">worth ${money(Math.floor((d.holding.shares_micro * p.price_pence) / MICRO))}</div></div>` : ''}
        </div>
        <div class="card">${sparkline(prices)}</div>
        ${upcomingFixtures(d.upcoming, p.team_id, m.teamById)}
        <h2>Recent matches</h2>
        ${
          d.matches.length
            ? `<div class="table-wrap"><table><thead><tr><th>Match</th><th class="num">Min</th><th>Key stats</th><th class="num">Price move</th></tr></thead><tbody>
          ${d.matches
            .map((s) => {
              const home = s.team_h === p.team_id;
              const opp = m.teamById[home ? s.team_a : s.team_h]?.short_name;
              const key = Object.entries(STAT_LABELS).filter(([k]) => s[k]).map(([k, l]) => `${l}${s[k] > 1 ? '×' + s[k] : ''}`).join(' · ');
              return `<tr><td>${img('crest', m.teamById[home ? s.team_a : s.team_h]?.code)} ${esc(opp)} (${home ? 'H' : 'A'}) ${s.team_h_score ?? ''}–${s.team_a_score ?? ''}<div class="small muted">${when(s.kickoff_time)}</div></td>
                <td class="num">${s.minutes}</td><td class="small">${key || '<span class="muted">–</span>'}</td>
                <td class="num ${cls(s.change_bp)}">${pctText(s.change_bp / 100)}</td></tr>`;
            })
            .join('')}</tbody></table></div>`
            : '<p class="muted">No settled matches yet.</p>'
        }
      </div>
      <div class="card trade-box" id="trade"></div>
    </div>`;

  const box = document.getElementById('trade');
  if (!state.me) {
    box.innerHTML = `<h2 style="margin-top:0">Trade</h2><p class="muted">Sign in to buy shares.</p><a href="/login" data-link><button class="primary">Sign in</button></a>`;
    return;
  }
  if (d.locked) {
    box.innerHTML = `<h2 style="margin-top:0">Trading locked</h2><p class="muted">His team kicks off ${when(d.locked_kickoff)}. Trading reopens once the match has been played and prices are settled.</p>`;
    return;
  }
  const pf = await api('/portfolio').catch(() => null);
  box.innerHTML = `
    <h2 style="margin-top:0">Trade</h2>
    <p class="small muted">Cash available: <b>${pf ? money(pf.cash_pence) : '–'}</b></p>
    <label for="buy-amt">Buy (£)</label>
    <div class="row"><input id="buy-amt" type="number" min="0.10" step="0.01" placeholder="10.00"><button class="primary" id="buy">Buy</button></div>
    <div class="quote" id="buy-quote"></div>
    ${
      d.holding
        ? `<label for="sell-amt">Sell (shares)</label>
      <div class="row"><input id="sell-amt" type="number" min="0" step="0.0001" placeholder="${shares(d.holding.shares_micro)}"><button class="danger" id="sell">Sell</button></div>
      <button class="link small" id="sell-all">Sell all ${shares(d.holding.shares_micro)} shares</button>
      <div class="quote" id="sell-quote"></div>`
        : ''
    }
    <p class="small muted">A ${feePct}% fee is taken when you sell.</p>`;

  const buyAmt = document.getElementById('buy-amt');
  buyAmt.addEventListener('input', () => {
    const pence = Math.round(Number(buyAmt.value) * 100);
    document.getElementById('buy-quote').textContent = pence > 0 ? `≈ ${shares(Math.ceil((pence * MICRO) / p.price_pence))} shares at ${money(p.price_pence)}` : '';
  });
  document.getElementById('buy').addEventListener('click', () =>
    trade({ player_id: p.id, side: 'buy', amount_pence: Math.round(Number(buyAmt.value) * 100) }, id),
  );
  if (d.holding) {
    const sellAmt = document.getElementById('sell-amt');
    const quote = (micro) => {
      const gross = Math.floor((micro * p.price_pence) / MICRO);
      const fee = Math.ceil((gross * feePct) / 100);
      document.getElementById('sell-quote').textContent = micro > 0 ? `≈ ${money(gross - fee)} after ${money(fee)} fee` : '';
    };
    sellAmt.addEventListener('input', () => quote(Math.round(Number(sellAmt.value) * MICRO)));
    document.getElementById('sell').addEventListener('click', () => {
      let micro = Math.round(Number(sellAmt.value) * MICRO);
      if (micro >= d.holding.shares_micro) micro = d.holding.shares_micro;
      trade({ player_id: p.id, side: 'sell', shares_micro: micro }, id);
    });
    document.getElementById('sell-all').addEventListener('click', () => trade({ player_id: p.id, side: 'sell', shares_micro: 'all' }, id));
  }
}

async function trade(body, id) {
  try {
    const r = await api('/trade', { method: 'POST', body });
    toast(r.side === 'buy' ? `Bought ${shares(r.shares_micro)} shares for ${money(r.gross_pence)}` : `Sold for ${money(r.net_pence)} (fee ${money(r.fee_pence)})`);
    playerPage(id);
  } catch (e) {
    toast(e.message, true);
  }
}

async function portfolioPage() {
  if (!state.me) return needLogin();
  const [pf, tr] = await Promise.all([api('/portfolio'), api('/trades')]);
  const profit = pf.total_pence - (state.config?.starting_cash_pence ?? 10000);
  app.innerHTML = `
    <h1>Portfolio</h1>
    <div class="stats">
      <div class="stat"><div class="label">Total value</div><div class="value">${money(pf.total_pence)}</div><div class="small ${cls(profit)}">${profit >= 0 ? '+' : ''}${money(profit)} this season</div></div>
      <div class="stat"><div class="label">Cash</div><div class="value">${money(pf.cash_pence)}</div></div>
      <div class="stat"><div class="label">Invested</div><div class="value">${money(pf.holdings_value_pence)}</div></div>
    </div>
    <h2>Holdings</h2>
    ${
      pf.holdings.length
        ? `<div class="table-wrap"><table><thead><tr><th>Player</th><th class="num">Shares</th><th class="num">Price</th><th class="num">Value</th><th class="num">Gain</th></tr></thead><tbody>
      ${pf.holdings
        .map((h) => {
          const gain = h.value_pence - h.cost_pence;
          return `<tr class="clickable" onclick="history.pushState(null,'','/player/${h.player_id}');dispatchEvent(new PopStateEvent('popstate'))">
            <td><span class="who">${img('photo', h.code)}<span><b>${esc(h.web_name)}</b> <span class="small muted">${esc(h.team_short)} · ${h.position}</span></span></span></td>
            <td class="num">${shares(h.shares_micro)}</td><td class="num">${money(h.price_pence)}</td>
            <td class="num">${money(h.value_pence)}</td><td class="num ${cls(gain)}">${gain >= 0 ? '+' : ''}${money(gain)}</td></tr>`;
        })
        .join('')}</tbody></table></div>`
        : `<div class="card empty">You don't own any players yet. <a href="/" data-link>Visit the market</a> to buy your first shares.</div>`
    }
    <h2>Recent trades</h2>
    ${
      tr.trades.length
        ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Player</th><th>Side</th><th class="num">Shares</th><th class="num">Price</th><th class="num">Total</th><th class="num">Fee</th></tr></thead><tbody>
      ${tr.trades
        .map(
          (t) => `<tr><td class="small">${when(t.created_at)}</td><td>${esc(t.web_name)}</td><td class="${t.side === 'buy' ? 'up' : 'down'}">${t.side}</td>
          <td class="num">${shares(t.shares_micro)}</td><td class="num">${money(t.price_pence)}</td><td class="num">${money(t.gross_pence)}</td><td class="num">${t.fee_pence ? money(t.fee_pence) : '–'}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
        : '<p class="muted">No trades yet.</p>'
    }`;
}

async function fixturesPage() {
  const d = await api('/fixtures');
  const teamById = Object.fromEntries(d.teams.map((t) => [t.id, t]));
  const locked = new Set(d.locked_teams);
  const events = [...new Set(d.fixtures.map((f) => f.event).filter((e) => e != null))].sort((a, b) => a - b);
  const prefs = (fixturesPage.prefs ??= { event: null, team: '' });
  if (prefs.event == null || !events.includes(prefs.event)) prefs.event = d.current_event ?? events[events.length - 1] ?? null;

  app.innerHTML = `
    <h1>Fixtures</h1>
    <p class="muted">Premier League fixtures and results. Times are shown in your time zone. Click a team to see its players.</p>
    <div class="toolbar">
      <select id="fx-team"><option value="">All teams</option>${d.teams.map((t) => `<option value="${t.id}" ${String(t.id) === prefs.team ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <div class="seg" id="gw-nav"><button id="gw-prev" aria-label="Previous gameweek">‹</button><select id="gw">${events.map((e) => `<option value="${e}" ${e === prefs.event ? 'selected' : ''}>Gameweek ${e}</option>`).join('')}</select><button id="gw-next" aria-label="Next gameweek">›</button></div>
    </div>
    <div id="fx-list"></div>`;

  const row = (f) => {
    // FPL marks a match finished only once bonus points are confirmed; full time comes first.
    const ft = f.finished || f.finished_provisional;
    const live = f.started && !ft;
    const mid = ft || live ? `<b>${f.team_h_score ?? 0} – ${f.team_a_score ?? 0}</b>` : f.kickoff_time ? new Date(f.kickoff_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'TBC';
    // Locks by team are for trading; only flag the match that is actually causing the lock.
    const lockedNow = !f.finished && f.kickoff_time && new Date(f.kickoff_time).getTime() - Date.now() <= d.lock_hours * 3_600_000 && (locked.has(f.team_h) || locked.has(f.team_a));
    const team = (id, side) => `<a href="/" class="fx-team ${side}" data-team="${id}">${img('crest', teamById[id]?.code)}<span class="hide-sm">${esc(teamById[id]?.name)}</span><span class="show-sm">${esc(teamById[id]?.short_name)}</span></a>`;
    return `<div class="fx-row">
      ${team(f.team_h, 'home')}
      <div class="fx-mid">${mid}${live ? '<div class="small up">Live</div>' : ft ? '<div class="small muted">FT</div>' : lockedNow ? '<div><span class="badge lock">Locked</span></div>' : ''}</div>
      ${team(f.team_a, 'away')}
    </div>`;
  };
  const dayKey = (f) =>
    f.kickoff_time ? new Date(f.kickoff_time).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : 'Date to be confirmed';

  const draw = () => {
    const teamId = Number(prefs.team);
    let list;
    if (teamId) {
      list = d.fixtures.filter((f) => !f.finished && !f.finished_provisional && (f.team_h === teamId || f.team_a === teamId));
    } else {
      list = d.fixtures.filter((f) => f.event === prefs.event);
    }
    document.getElementById('gw-nav').hidden = !!teamId;
    const groups = [];
    for (const f of list) {
      const k = (teamId && f.event ? `Gameweek ${f.event} · ` : '') + dayKey(f);
      if (groups.at(-1)?.k !== k) groups.push({ k, rows: [] });
      groups.at(-1).rows.push(f);
    }
    document.getElementById('fx-list').innerHTML = groups.length
      ? groups.map((g) => `<h2 class="fx-day">${esc(g.k)}</h2><div class="card fx-card">${g.rows.map(row).join('')}</div>`).join('')
      : `<div class="card empty">${d.fixtures.length ? 'No upcoming fixtures.' : "Fixtures haven't loaded yet."}</div>`;
    const i = events.indexOf(prefs.event);
    document.getElementById('gw-prev').disabled = i <= 0;
    document.getElementById('gw-next').disabled = i < 0 || i >= events.length - 1;
  };
  draw();

  const setEvent = (e) => {
    prefs.event = e;
    document.getElementById('gw').value = String(e);
    draw();
  };
  // While a match is on, pick up new scores every minute without a reload.
  const liveNow = () =>
    d.fixtures.some((f) => {
      const since = f.kickoff_time ? Date.now() - new Date(f.kickoff_time).getTime() : -1;
      return !f.finished && !f.finished_provisional && since >= 0 && since < 3 * 3_600_000;
    });
  clearInterval(fixturesPage.timer);
  fixturesPage.timer = setInterval(async () => {
    if (location.pathname !== '/fixtures') return clearInterval(fixturesPage.timer);
    if (!liveNow()) return;
    try {
      d.fixtures = (await api('/fixtures')).fixtures;
      draw();
    } catch {}
  }, 60_000);

  document.getElementById('gw').addEventListener('change', (e) => setEvent(Number(e.target.value)));
  document.getElementById('gw-prev').addEventListener('click', () => setEvent(events[events.indexOf(prefs.event) - 1]));
  document.getElementById('gw-next').addEventListener('click', () => setEvent(events[events.indexOf(prefs.event) + 1]));
  document.getElementById('fx-team').addEventListener('change', (e) => ((prefs.team = e.target.value), draw()));
  document.getElementById('fx-list').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-team]');
    if (!a) return;
    e.preventDefault();
    marketPage.prefs = { ...(marketPage.prefs ?? { q: '', pos: '', sort: 'price', dir: -1 }), team: a.dataset.team, q: '' };
    navigate('/');
  });
}

function standingsTable(rows, scope) {
  if (!rows.length) return '<div class="card empty">Nobody on the board yet.</div>';
  return `<div class="table-wrap"><table><thead><tr><th class="num" style="width:60px">#</th><th>Manager</th><th class="num">${scope === 'alltime' ? 'All-time profit' : 'Total value'}</th></tr></thead><tbody>
    ${rows
      .map(
        (r) => `<tr><td class="num">${r.rank}</td><td>${esc(r.display_name)} ${state.me?.id === r.user_id ? '<span class="badge me">You</span>' : ''}</td>
        <td class="num ${scope === 'alltime' ? cls(r.total_pence) : ''}">${money(r.total_pence)}</td></tr>`,
      )
      .join('')}</tbody></table></div>`;
}

function scopeToggle(scope) {
  return `<div class="seg"><button data-scope="season" class="${scope === 'season' ? 'on' : ''}">This season</button><button data-scope="alltime" class="${scope === 'alltime' ? 'on' : ''}">All time</button></div>`;
}

async function leaderboardPage(scope = 'season') {
  const d = await api(`/leaderboard?scope=${scope}`);
  app.innerHTML = `<h1>Leaderboard</h1><div class="toolbar">${scopeToggle(scope)}</div>${standingsTable(d.standings, scope)}`;
  app.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => leaderboardPage(b.dataset.scope)));
}

async function leaguesPage() {
  if (!state.me) return needLogin();
  const d = await api('/leagues');
  app.innerHTML = `
    <h1>Private leagues</h1>
    <p class="muted">Compete with friends. Create a league and share its code, or join one with a code.</p>
    <div class="grid grid-2">
      <div>${
        d.leagues.length
          ? `<div class="table-wrap"><table><thead><tr><th>League</th><th>Code</th><th class="num">Members</th></tr></thead><tbody>
        ${d.leagues.map((l) => `<tr><td><a href="/leagues/${l.id}" data-link>${esc(l.name)}</a></td><td class="code" style="font-size:14px">${esc(l.code)}</td><td class="num">${l.members}</td></tr>`).join('')}
        </tbody></table></div>`
          : '<div class="card empty">You are not in any leagues yet.</div>'
      }</div>
      <div class="card">
        <h2 style="margin-top:0">Create a league</h2>
        <div class="toolbar"><input id="lname" placeholder="League name" maxlength="40"><button class="primary" id="create">Create</button></div>
        <h2>Join a league</h2>
        <div class="toolbar"><input id="lcode" placeholder="Code" maxlength="6" style="text-transform:uppercase"><button id="join">Join</button></div>
      </div>
    </div>`;
  document.getElementById('create').addEventListener('click', async () => {
    try {
      const r = await api('/leagues', { method: 'POST', body: { name: document.getElementById('lname').value } });
      navigate(`/leagues/${r.league.id}`);
    } catch (e) {
      toast(e.message, true);
    }
  });
  document.getElementById('join').addEventListener('click', async () => {
    try {
      const r = await api('/leagues/join', { method: 'POST', body: { code: document.getElementById('lcode').value } });
      navigate(`/leagues/${r.league.id}`);
    } catch (e) {
      toast(e.message, true);
    }
  });
}

async function leaguePage(id, scope = 'season') {
  if (!state.me) return needLogin();
  const d = await api(`/leagues/${id}?scope=${scope}`);
  app.innerHTML = `
    <p><a href="/leagues" data-link>← Leagues</a></p>
    <h1>${esc(d.league.name)}</h1>
    <p class="muted">Invite friends with code <span class="code">${esc(d.league.code)}</span></p>
    <div class="toolbar">${scopeToggle(scope)}<button class="danger" id="leave" style="margin-left:auto">Leave league</button></div>
    ${standingsTable(d.standings, scope)}`;
  app.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => leaguePage(id, b.dataset.scope)));
  document.getElementById('leave').addEventListener('click', async () => {
    if (!confirm('Leave this league?')) return;
    await api(`/leagues/${id}/leave`, { method: 'POST' });
    navigate('/leagues');
  });
}

function loginPage() {
  app.innerHTML = `
    <div class="card login">
      <h1>Sign in</h1>
      <p class="muted">We'll email you a link to sign in. No password needed. New here? The same link creates your account with £100 to invest.</p>
      <form id="login"><input id="email" type="email" placeholder="you@example.com" required autocomplete="email"><button class="primary" style="width:100%">Email me a link</button></form>
      <p id="login-msg" class="small"></p>
    </div>`;
  document.getElementById('login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('login-msg');
    try {
      const r = await api('/auth/request', { method: 'POST', body: { email: document.getElementById('email').value } });
      msg.innerHTML = r.devLink
        ? `Dev mode: <a href="${esc(r.devLink)}">open your sign-in link</a>`
        : 'Check your inbox for a sign-in link. It expires in 15 minutes.';
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

async function verifyPage() {
  const token = new URLSearchParams(location.search).get('token');
  app.innerHTML = '<p class="muted">Signing you in…</p>';
  try {
    const r = await api('/auth/verify', { method: 'POST', body: { token } });
    state.me = r.user;
    renderAccount();
    history.replaceState(null, '', r.is_new ? '/account' : '/');
    if (r.is_new) toast('Welcome! You have £100 to invest. Pick a display name first.');
    route();
  } catch (e) {
    app.innerHTML = `<div class="card login"><h1>Link expired</h1><p class="muted">${esc(e.message)}</p><a href="/login" data-link><button class="primary">Get a new link</button></a></div>`;
  }
}

function accountPage() {
  if (!state.me) return needLogin();
  app.innerHTML = `
    <div class="card login">
      <h1>Your account</h1>
      <p class="muted small">${esc(state.me.email)}</p>
      <label class="small muted" for="dname">Display name (shown on leaderboards)</label>
      <form id="acct"><input id="dname" maxlength="24" value="${esc(state.me.display_name)}"><button class="primary">Save</button></form>
      <p><button class="link" id="logout">Sign out</button></p>
    </div>`;
  document.getElementById('acct').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/me', { method: 'POST', body: { display_name: document.getElementById('dname').value } });
      state.me = r.user;
      renderAccount();
      toast('Saved');
    } catch (err) {
      toast(err.message, true);
    }
  });
  document.getElementById('logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    state.me = null;
    renderAccount();
    navigate('/');
  });
}

function rulesPage() {
  const c = state.config;
  const w = c.weights;
  const bp = (v) => `${v > 0 ? '+' : ''}${(v / 100).toFixed(1).replace(/\.0$/, '')}%`;
  const byPos = (o) => ['GKP', 'DEF', 'MID', 'FWD'].map((p) => `${p} ${bp(o[p])}`).join(', ');
  const rows = [
    ['Played 60+ minutes', bp(w.appearance60)],
    ['Played 1 to 59 minutes', bp(w.appearanceSub)],
    ['Did not play', bp(w.didNotPlay)],
    ['Goal', byPos(w.goal)],
    ['Assist', bp(w.assist)],
    ['Clean sheet (60+ minutes)', byPos(w.cleanSheet)],
    ['Every 2 goals conceded', byPos(w.per2GoalsConceded)],
    ['Every 3 saves (goalkeepers)', bp(w.per3Saves)],
    ['Penalty saved', bp(w.penaltySaved)],
    ['Penalty missed', bp(w.penaltyMissed)],
    ['Yellow card', bp(w.yellowCard)],
    ['Red card', bp(w.redCard)],
    ['Own goal', bp(w.ownGoal)],
    ['Each FPL bonus point (1 to 3)', bp(w.perBonusPoint)],
    ['Defensive contribution threshold reached', bp(w.defensiveContribution)],
    ['Demand: every £100 net bought since his last match', `${bp(w.demandPer100Pounds)} (capped at ±${(w.demandCap / 100).toFixed(0)}%)`],
  ];
  app.innerHTML = `
    <h1>How it works</h1>
    <div class="card">
      <ol>
        <li>Sign up and get <b>${money(c.starting_cash_pence)}</b> of fake money for the season.</li>
        <li>Buy shares in any Premier League player at his current price. Fractional shares are fine.</li>
        <li>Trading on a player locks <b>2 hours before kick-off</b>.</li>
        <li>After the final whistle, once the official stats are confirmed, his price moves based on how he played (and a little on how much people bought or sold him). Then trading reopens.</li>
        <li>Selling costs a <b>${c.sell_fee_bp / 100}% fee</b>.</li>
        <li>The leaderboard ranks everyone by total value: cash plus shares at today's prices. Everyone restarts with ${money(c.starting_cash_pence)} each season, and the all-time table adds up your profit across seasons.</li>
      </ol>
    </div>
    <h2>Price moves per match</h2>
    <div class="table-wrap"><table class="weights"><tbody>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</tbody></table></div>
    <p class="small muted">Moves add up and are capped between ${bp(w.maxFall)} and ${bp(w.maxRise)} per match.</p>`;
}

// ---------- router ----------
async function route() {
  const path = location.pathname;
  document.querySelectorAll('.nav a').forEach((a) => {
    const href = a.getAttribute('href');
    a.classList.toggle('active', href === '/' ? path === '/' || path.startsWith('/player') : path.startsWith(href));
  });
  try {
    let m;
    if (path === '/') await marketPage();
    else if ((m = path.match(/^\/player\/(\d+)$/))) await playerPage(m[1]);
    else if (path === '/fixtures') await fixturesPage();
    else if (path === '/portfolio') await portfolioPage();
    else if (path === '/leaderboard') await leaderboardPage();
    else if (path === '/leagues') await leaguesPage();
    else if ((m = path.match(/^\/leagues\/(\d+)$/))) await leaguePage(m[1]);
    else if (path === '/login') loginPage();
    else if (path === '/verify') await verifyPage();
    else if (path === '/account') accountPage();
    else if (path === '/how-it-works') rulesPage();
    else app.innerHTML = '<div class="empty">Page not found. <a href="/" data-link>Back to the market</a></div>';
  } catch (e) {
    if (e.status === 401) return needLogin();
    app.innerHTML = `<div class="card empty">${esc(e.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

(async function start() {
  const [me, config] = await Promise.all([api('/me').catch(() => ({ user: null })), api('/config')]);
  state.me = me.user;
  state.config = config;
  renderAccount();
  route();
})();
