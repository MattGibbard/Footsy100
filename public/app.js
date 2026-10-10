// Footsy100 front end: a small vanilla JS single-page app.
// Every player is a card, coloured by the band his price sits in.

const app = document.getElementById('app');
const state = { me: null, market: null, config: null, cash: null, owned: {} };

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (p) => `${p < 0 ? '−' : ''}£${(Math.abs(p) / 100).toFixed(2)}`;
const signedMoney = (p) => `${p > 0 ? '+' : ''}${money(p)}`;
const pct = (now, before) => (before ? ((now - before) / before) * 100 : 0);
// Changes always carry an arrow and a sign, never colour alone.
const pctText = (v) => (v > 0 ? `▲ ${v.toFixed(1)}%` : v < 0 ? `▼ ${Math.abs(v).toFixed(1)}%` : '0.0%');
const cls = (v) => (v > 0 ? 'rise' : v < 0 ? 'fall' : 'muted');
const cardsText = (n) => `${n} card${n === 1 ? '' : 's'}`;
const when = (iso) =>
  iso ? new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'TBC';
const POSITIONS = { GKP: 'Goalkeeper', DEF: 'Defender', MID: 'Midfielder', FWD: 'Forward' };
const FEE_BP = () => state.config?.sell_fee_bp ?? 200;
const saleQuote = (n, price) => {
  const gross = n * price;
  const fee = Math.ceil((gross * FEE_BP()) / 10000);
  return { gross, fee, net: gross - fee };
};

// Price bands: the card's whole colour comes from its price.
const BANDS = [
  { key: 'top', name: 'Gold', min: 700, sw: 't', range: '£7.00 and up', note: 'The stars. Premium prices.' },
  { key: 'mid', name: 'Silver', min: 500, sw: 'm', range: '£5.00–£6.99', note: 'Regular starters. Room to grow.' },
  { key: 'low', name: 'Bronze', min: 0, sw: 'l', range: 'Under £5.00', note: 'Bargains. Big upside if they click.' },
];
const band = (pence) => BANDS.find((b) => pence >= b.min).key;

function bandKey() {
  return `<div class="band-key">${BANDS.map((b) => `<div class="item"><span class="range"><span class="sw ${b.sw}"></span>${b.range}</span><span class="note">${b.note}</span></div>`).join('')}
    <div class="item"><span class="range">Cards change colour</span><span class="note">A great game can promote a card. A bad one can drop it.</span></div></div>`;
}

// Official Premier League photos and crests, keyed by FPL's `code` fields. The
// PL moved its image paths for 2025/26, so the older paths are tried next, and a
// plain placeholder shows if none has the image (e.g. a new signing).
const PL_CDN = 'https://resources.premierleague.com/premierleague';
const IMAGE_URLS = {
  photo: (c) => [`${PL_CDN}25/photos/players/110x140/${c}.png`, `${PL_CDN}/photos/players/110x140/p${c}.png`],
  // Cards show the photo larger, so try the bigger renditions first.
  'photo-card': (c) => [
    `${PL_CDN}25/photos/players/250x250/${c}.png`,
    `${PL_CDN}/photos/players/250x250/p${c}.png`,
    `${PL_CDN}25/photos/players/110x140/${c}.png`,
    `${PL_CDN}/photos/players/110x140/p${c}.png`,
  ],
  crest: (c) => [`${PL_CDN}25/badges/${c}.svg`, `${PL_CDN}/badges/70/t${c}.png`],
};
function img(kind, code, size = 'sm', alt = '') {
  const cls = `${kind} ${kind}-${size}`;
  const attrs = alt ? `role="img" aria-label="${esc(alt)}"` : 'aria-hidden="true"';
  if (!code) return `<span class="${cls} img-missing" ${attrs}></span>`;
  const [src, ...fallbacks] = IMAGE_URLS[kind === 'photo' && size === 'card' ? 'photo-card' : kind](code);
  return `<img class="${cls}" src="${src}" data-fallback="${fallbacks.join(' ')}" alt="${esc(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
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

window.addEventListener('popstate', route);

function emptyMarketText() {
  const s = state.status?.last_sync;
  if (!s) return 'Player data hasn\'t loaded yet. The first sync runs within 15 minutes of deploying.';
  if (!s.ok) return `Player data couldn't be loaded. Last sync failed ${esc(when(s.at))}: ${esc(s.error)}`;
  return 'Player data hasn\'t loaded yet.';
}

async function loadMarket(force = false) {
  // Refetch after a minute so match badges (locked, playing, awaiting price) stay current.
  if (!state.market || force || Date.now() - state.market.loadedAt > 60_000) {
    state.market = await api('/players');
    state.market.loadedAt = Date.now();
  }
  if (!state.market.players.length) state.status = await api('/status').catch(() => null);
  const m = state.market;
  m.teamById = Object.fromEntries(m.teams.map((t) => [t.id, t]));
  m.playerById = Object.fromEntries(m.players.map((p) => [p.id, p]));
  m.locked = new Set(m.locked_teams);
  m.teamState = m.team_states ?? {};
  m.form ??= {};
  return m;
}

// Cash and cards held, for the header and the "You own" tags on cards.
async function refreshWallet() {
  if (!state.me) {
    state.cash = null;
    state.owned = {};
  } else {
    const pf = await api('/portfolio').catch(() => null);
    state.cash = pf?.cash_pence ?? null;
    state.owned = Object.fromEntries((pf?.holdings ?? []).map((h) => [h.player_id, h.cards]));
  }
  renderAccount();
}

// Why a player can't be traded right now: about to kick off, mid-match, or waiting for his new price.
const MATCH_STATES = {
  locked: { label: 'Locked', cls: 'lock', title: 'His match kicks off soon, so trading is paused' },
  live: { label: 'Playing now', cls: 'live', title: 'His match is under way. Trading reopens once his new price is set.' },
  awaiting: { label: 'Awaiting new price', cls: 'lock', title: 'Full time. His new price is set once the final stats are in.' },
};
function matchBadge(s) {
  const m = MATCH_STATES[s];
  return m ? `<span class="badge ${m.cls}" title="${m.title}">${m.label}</span>` : '';
}
// FPL availability flags.
const AVAILABILITY = { d: 'Doubtful', i: 'Injured', s: 'Suspended', u: 'Unavailable', n: 'Not in squad' };

// FPL's injury and availability news as a badge: amber for a doubt (with his
// chance of playing when FPL gives one), red when he's out. Hover shows the news.
function availabilityBadge(p) {
  const label = AVAILABILITY[p.status];
  if (!label) return '';
  const doubt = p.status === 'd';
  const text = doubt && p.chance_next != null ? `${p.chance_next}% to play` : label;
  return `<span class="badge flag${doubt ? ' doubt' : ''}" title="${esc(p.news || label)}">${text}</span>`;
}

// The full news line for a player page.
function availabilityNote(p) {
  if (!AVAILABILITY[p.status]) return '';
  // FPL's news usually states the chance already ("Knock - 75% chance of playing").
  const chance = p.chance_next != null && !String(p.news).includes('%') ? ` · ${p.chance_next}% chance of playing next round` : '';
  const updated = p.news_added ? ` <span class="muted">Updated ${when(p.news_added)}</span>` : '';
  return `<p class="news ${p.status === 'd' ? 'doubt' : 'out'}">${availabilityBadge(p)} ${esc(p.news || AVAILABILITY[p.status])}${chance}.${updated}</p>`;
}

function renderAccount() {
  const el = document.getElementById('account');
  el.innerHTML = state.me
    ? `${state.cash != null ? `<span class="cash-pill"><b>${money(state.cash)}</b> cash</span>` : ''}<a class="btn quiet" href="/account" data-link>${esc(state.me.display_name)}</a>`
    : `<a class="btn quiet" href="/login" data-link>Log in</a><a class="btn primary header" href="/login" data-link>Sign up</a>`;
}

function needLogin() {
  app.innerHTML = `<div class="signup narrow"><h2>Sign in to play</h2><p>Collect Premier League player cards with a £100 virtual budget. Play money only: it can't be topped up or cashed out.</p><a class="btn primary lg block" href="/login" data-link>Sign in or join</a></div>`;
}

// ---------- the player card ----------
// Height of each form bar: price as a share of £15, so the top band fills the box.
function formBars(prices) {
  const list = prices.slice(-5);
  const bars = list.map((v) => `<span class="b-${band(v)}" style="height:${Math.max(6, Math.min(100, (v / 1500) * 100)).toFixed(0)}%"></span>`).join('');
  return `<div class="bars" role="img" aria-label="Price after recent matches: ${list.map(money).join(', ')}">${bars}</div>`;
}

function buyLabel(n, price) {
  return n === 1 ? `Buy for ${money(price)}` : `Buy ${n} for ${money(n * price)}`;
}
function sellLabel(n, price) {
  return n === 1 ? `Sell for ${money(saleQuote(1, price).net)}` : `Sell ${n} for ${money(saleQuote(n, price).net)}`;
}
function stepper(max, label) {
  return `<div class="stepper"><button type="button" data-step="-1" aria-label="One fewer">−</button><input type="number" inputmode="numeric" min="1" max="${max}" step="1" value="1" aria-label="${label}"><button type="button" data-step="1" aria-label="One more">+</button></div>`;
}
// The buy controls on a card: a stepper for how many, then the band-coloured button.
function buyRow(p, matchState, compact = false) {
  if (matchState) return `<div class="buy-row"><button class="btn-band" disabled>${MATCH_STATES[matchState].label}</button></div>`;
  return `<div class="buy-row">${compact ? '' : stepper(1000, 'Number of cards to buy')}<button class="btn-band" data-buy="${p.id}" data-price="${p.price_pence}">${buyLabel(1, p.price_pence)}</button></div>`;
}

// The sell controls on a card you own (My cards): how many to sell, the net after the fee, and a quiet link to buy more.
function sellRow(p, held, matchState) {
  const more = `<a class="small buy-more" href="/player/${p.id}" data-link>Buy more</a>`;
  if (matchState) return `<div class="buy-row"><button class="btn-band" disabled>${MATCH_STATES[matchState].label}</button></div><p class="quote">${more}</p>`;
  return `<div class="buy-row">${stepper(held, 'Number of cards to sell')}<button class="btn-band sell" data-sell="${p.id}" data-price="${p.price_pence}">${sellLabel(1, p.price_pence)}</button></div>
      <p class="quote" data-sell-quote>${money(p.price_pence)} less the ${money(saleQuote(1, p.price_pence).fee)} fee (${FEE_BP() / 100}%).</p>
      <p class="small sell-links">${held > 1 ? `<button class="link" data-sell="${p.id}" data-all="1">Sell all ${held} for ${money(saleQuote(held, p.price_pence).net)}</button> · ` : ''}${more}</p>`;
}

// p: a player row from /players (id, code, web_name, team_id, position, status, price_pence, prev_price_pence).
function playerCard(p, m, o = {}) {
  const team = m.teamById[p.team_id];
  const diff = p.prev_price_pence ? p.price_pence - p.prev_price_pence : null;
  const ch = pct(p.price_pence, p.prev_price_pence);
  const matchState = m.teamState[p.team_id];
  const form = m.form[p.id] ? JSON.parse(m.form[p.id]) : [];
  const owned = state.owned[p.id];
  const tag = matchState ? matchBadge(matchState) : availabilityBadge(p);
  return `<article class="pcard band-${band(p.price_pence)}${o.featured ? ' featured' : ''}" data-card="${p.id}">
    <div class="head"><div class="id">${img('crest', team?.code, 'md', `${team?.name ?? 'Club'} crest`)}<span class="pos" title="${POSITIONS[p.position] ?? ''}">${p.position}</span></div><span class="price">${money(p.price_pence)}</span></div>
    <a class="cover portrait" href="/player/${p.id}" data-link tabindex="-1">${img('photo', p.code, 'card', `Photo of ${p.web_name}`)}${tag ? `<span class="tag">${tag}</span>` : ''}${owned ? `<span class="owned badge me">You own ${owned}</span>` : ''}</a>
    <div class="body">
      <h3 class="name"><a href="/player/${p.id}" data-link>${esc(p.web_name)}</a></h3>
      <div><span class="caption">Price · last 5 matches</span>${formBars(form.length ? form : [p.price_pence])}</div>
      <div class="row">${diff != null ? `<span class="since">${signedMoney(diff)} since full time</span><span class="change ${cls(ch)}">${pctText(ch)}</span>` : '<span class="since">No matches settled yet</span>'}</div>
      ${o.sell ? `<div class="row"><span class="since">Paid ${money(o.sell.cost)} for ${cardsText(owned)}</span><span class="change ${cls(o.sell.gain)}">${signedMoney(o.sell.gain)}</span></div>${sellRow(p, owned, matchState)}` : o.buy === false ? '' : buyRow(p, matchState, o.compact)}
    </div>
  </article>`;
}

// ---------- trading ----------
document.addEventListener('click', async (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    navigate(a.getAttribute('href'));
    return;
  }
  const step = e.target.closest('[data-step]');
  if (step) {
    const input = step.parentElement.querySelector('input');
    input.value = Math.max(1, Math.min(Number(input.max) || 1000, (Number(input.value) || 1) + Number(step.dataset.step)));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const btn = e.target.closest('[data-buy], [data-sell]');
  if (!btn) return;
  if (!state.me) {
    const join = document.getElementById('join');
    return join ? join.scrollIntoView({ behavior: 'smooth', block: 'center' }) : navigate('/login');
  }
  const id = Number(btn.dataset.buy ?? btn.dataset.sell);
  const qty = btn.dataset.all ? 'all' : Number(btn.closest('.buy-row')?.querySelector('input')?.value || 1);
  btn.disabled = true;
  try {
    let r;
    if (btn.dataset.buy) {
      r = await api('/trade', { method: 'POST', body: { player_id: id, side: 'buy', cards: qty } });
      toast(`Bought ${cardsText(r.cards)} for ${money(r.gross_pence)}`);
    } else {
      r = await api('/trade', { method: 'POST', body: { player_id: id, side: 'sell', cards: qty } });
      toast(`Sold ${cardsText(r.cards)} for ${money(r.net_pence)} after a ${money(r.fee_pence)} fee`);
    }
    await refreshWallet();
    const onPlayerPage = location.pathname === `/player/${id}`;
    if (onPlayerPage) return void (await playerPage(id));
    // On My cards a sale changes the totals and may remove the card, so redraw the page.
    if (location.pathname === '/portfolio') return void (await portfolioPage());
    // Elsewhere, redraw just this card so the page doesn't jump.
    const card = btn.closest('[data-card]');
    const m = state.market;
    if (card && m?.playerById[id]) card.outerHTML = playerCard(m.playerById[id], m, { featured: card.classList.contains('featured'), compact: !!card.closest('.fan') });
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// Keep the stepper in range and the button's label in step with it.
document.addEventListener('input', (e) => {
  const input = e.target.closest('.stepper input');
  if (!input) return;
  const row = input.closest('.buy-row');
  const n = Math.max(1, Math.min(Number(input.max) || 1000, Math.floor(Number(input.value)) || 1));
  if (String(n) !== input.value && input.value !== '') input.value = n;
  const buy = row.querySelector('[data-buy]');
  if (buy) buy.textContent = buyLabel(n, Number(buy.dataset.price));
  const sell = row.querySelector('[data-sell]');
  if (sell) {
    const price = Number(sell.dataset.price);
    sell.textContent = sellLabel(n, price);
    const q = row.parentElement.querySelector('[data-sell-quote]');
    if (q) q.textContent = `${money(n * price)} less the ${money(saleQuote(n, price).fee)} fee (${FEE_BP() / 100}%).`;
  }
});

// ---------- weekly pack ----------
const BAND_NAMES = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze' };
const cardBack = () => `<div class="card-back" aria-hidden="true"><svg viewBox="0 0 34 34"><polygon points="17,2 31,10 31,24 17,32 3,24 3,10" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13 23V11h8.5M13 17h6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>FOOTSY<b>100</b></span></div>`;

// A placeholder that fills itself in, so pages don't wait on the pack to render.
function packSection() {
  if (!state.me) return '';
  queueMicrotask(loadPack);
  return '<section class="panel pack" id="pack" aria-live="polite"><p class="muted small">Loading your weekly pack…</p></section>';
}

async function loadPack() {
  const el = document.getElementById('pack');
  if (!el) return;
  const [pk, m] = await Promise.all([api('/pack').catch(() => null), loadMarket()]);
  if (!pk?.event) return void el.remove();
  const odds = pk.odds.slice().reverse().map((o) => `${o.percent}% ${BAND_NAMES[o.band]}`).join(' · ');
  if (pk.opened) {
    const p = m.playerById[pk.opened.player_id];
    el.innerHTML = `<div class="pack-slot">${p ? playerCard(p, m, { buy: false }) : ''}</div>
      <div class="pack-text"><h2>Gameweek ${pk.event} pack</h2>
      <p>You pulled <b>${esc(pk.opened.web_name)}</b>, a ${BAND_NAMES[pk.opened.band]} card worth ${money(pk.opened.card_price_pence)} when you opened it.</p>
      <p class="muted small">Your next pack arrives once gameweek ${pk.event}'s matches are settled.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="pack-slot"><div class="flip" id="pack-flip"><div class="face back">${cardBack()}</div><div class="face front"></div></div></div>
    <div class="pack-text"><h2>Gameweek ${pk.event} pack</h2>
    <p>One random player card for ${money(pk.price_pence)}. Most packs hold a Bronze, but you could pull a Gold.</p>
    <p class="muted small">${odds}. One pack per gameweek. The card is yours to keep or sell like any other.</p>
    <button class="btn primary" id="open-pack">Open pack for ${money(pk.price_pence)}</button></div>`;
  document.getElementById('open-pack').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/pack/open', { method: 'POST' });
      const p = m.playerById[r.player_id];
      const flip = document.getElementById('pack-flip');
      flip.querySelector('.front').innerHTML = p ? playerCard(p, m, { buy: false }) : '';
      flip.classList.add('flipped', `pulled-${r.band}`);
      e.target.remove();
      await refreshWallet();
      setTimeout(() => {
        state.owned[r.player_id] = (state.owned[r.player_id] ?? 0) + 1;
        el.querySelector('.pack-text').innerHTML = `<h2>${r.band === 'gold' ? 'Gold!' : `${BAND_NAMES[r.band]} card`}</h2>
          <p>You pulled <b>${esc(p?.web_name ?? 'a new card')}</b>, worth ${money(r.card_price_pence)}. It's in <a href="/portfolio" data-link>My cards</a>.</p>
          <p class="muted small">Your next pack arrives once gameweek ${r.event}'s matches are settled.</p>`;
      }, 700);
    } catch (err) {
      toast(err.message, true);
      e.target.disabled = false;
    }
  });
}

// ---------- pages ----------
async function homePage() {
  const m = await loadMarket();
  if (state.me) {
    app.innerHTML = `
      <h1>The market</h1>
      <p class="intro">Buy whole cards at today's price. Trading on a player locks ${m.lock_hours} hours before his team kicks off and reopens once the match is settled.</p>
      ${packSection()}
      ${bandKey()}
      ${m.players.length ? moversSection(m) : ''}
      <h2>All players</h2>
      ${marketTools(m)}`;
  } else {
    app.innerHTML = `
      ${heroSection(m)}
      ${bandKey()}
      <section id="market"><h2>The market</h2>${marketTools(m)}</section>
      <section class="two-col" style="margin-top:var(--space-10)">
        ${signupPanel()}
        <div class="panel"><h2>Top collectors</h2><ol class="ranks" id="top5"><li class="empty muted">Loading…</li></ol></div>
      </section>`;
    wireSignup();
    api('/leaderboard?scope=season')
      .then((d) => (document.getElementById('top5').innerHTML = rankRows(d.standings.slice(0, 5), 'season')))
      .catch(() => (document.getElementById('top5').innerHTML = '<li class="empty muted">The season hasn\'t started yet.</li>'));
  }
  wireMarket(m);
}

function heroSection(m) {
  const byPrice = [...m.players].sort((a, b) => b.price_pence - a.price_pence);
  const featured = byPrice[0];
  const mid = byPrice.find((p) => band(p.price_pence) === 'mid');
  const low = byPrice.find((p) => band(p.price_pence) === 'low');
  const fan = featured && mid && low ? [mid, low, featured] : [];
  return `<section class="hero">
    <div>
      <p class="eyebrow">Premier League · Free to play</p>
      <h1>Collect players. <span>Their form is your fortune.</span></h1>
      <p class="lead">Every footballer is a card with a live price. Buy cards with your virtual budget, and watch values climb or fall with every match they play.</p>
      <div class="actions"><a class="btn primary lg" href="#join">Get your free £100 budget</a><a class="btn lg" href="#market">Browse the market</a></div>
      <p class="note">Play money only: it can't be topped up or cashed out.</p>
    </div>
    <div class="fan" aria-label="Featured player cards">${fan.map((p) => playerCard(p, m, { featured: p === featured, compact: true })).join('')}</div>
  </section>`;
}

function signupPanel() {
  return `<div class="signup" id="join">
    <h2>Start your collection</h2>
    <p>A £100 virtual budget to spend on day one. Play money only: it can't be topped up or cashed out.</p>
    <form id="signup">
      <label for="email">Email</label>
      <input id="email" type="email" required autocomplete="email" placeholder="you@example.com">
      <button class="btn primary lg">Claim my £100</button>
      <p class="msg" id="login-msg" role="status"></p>
    </form>
    <p class="small">We'll email you a sign-in link. No password needed.</p>
  </div>`;
}
function wireSignup() {
  document.getElementById('signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('login-msg');
    try {
      const r = await api('/auth/request', { method: 'POST', body: { email: document.getElementById('email').value } });
      msg.innerHTML = r.devLink ? `Dev mode: <a href="${esc(r.devLink)}">open your sign-in link</a>` : 'Check your inbox for a sign-in link. It expires in 15 minutes.';
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

const SORTS = {
  'price-desc': { label: 'Price: high to low', key: (p) => -p.price_pence },
  'price-asc': { label: 'Price: low to high', key: (p) => p.price_pence },
  rise: { label: 'Biggest rise', key: (p) => -pct(p.price_pence, p.prev_price_pence) },
  fall: { label: 'Biggest fall', key: (p) => pct(p.price_pence, p.prev_price_pence) },
  name: { label: 'Name', key: (p) => p.web_name.toLowerCase() },
};
const PAGE = 24;

function marketTools(m) {
  const prefs = (homePage.prefs ??= { q: '', team: '', pos: '', band: '', sort: 'price-desc' });
  return `<div class="toolbar">
      <input id="q" type="search" placeholder="Search players" aria-label="Search players" value="${esc(prefs.q)}">
      <select id="team" aria-label="Club"><option value="">All clubs</option>${m.teams.map((t) => `<option value="${t.id}" ${String(t.id) === prefs.team ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <select id="pos" aria-label="Position"><option value="">All positions</option>${Object.entries(POSITIONS).map(([k, v]) => `<option value="${k}" ${k === prefs.pos ? 'selected' : ''}>${v}s</option>`).join('')}</select>
      <select id="band" aria-label="Card colour"><option value="">All cards</option>${BANDS.map((b) => `<option value="${b.key}" ${b.key === prefs.band ? 'selected' : ''}>${b.name}</option>`).join('')}</select>
      <select id="sort" aria-label="Sort">${Object.entries(SORTS).map(([k, s]) => `<option value="${k}" ${k === prefs.sort ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
    </div>
    <p class="small muted" id="count"></p>
    <div class="card-grid" id="grid"></div>
    <div class="more"><button class="btn" id="more" hidden>Show more</button></div>`;
}

function wireMarket(m) {
  const prefs = homePage.prefs;
  let limit = PAGE;
  let list = [];
  const filter = () => {
    const q = prefs.q.toLowerCase();
    const key = SORTS[prefs.sort].key;
    list = m.players
      .filter(
        (p) =>
          (!prefs.team || String(p.team_id) === prefs.team) &&
          (!prefs.pos || p.position === prefs.pos) &&
          (!prefs.band || band(p.price_pence) === prefs.band) &&
          (!q || `${p.first_name} ${p.second_name} ${p.web_name}`.toLowerCase().includes(q)),
      )
      .map((p) => [key(p), p])
      .sort((a, b) => (a[0] > b[0] ? 1 : a[0] < b[0] ? -1 : 0))
      .map(([, p]) => p);
  };
  const draw = () => {
    document.getElementById('grid').innerHTML = list.length
      ? list.slice(0, limit).map((p) => playerCard(p, m)).join('')
      : `<div class="panel empty" style="grid-column:1/-1">${m.players.length ? 'No players found.' : emptyMarketText()}</div>`;
    document.getElementById('count').textContent = list.length ? `Showing ${Math.min(limit, list.length)} of ${list.length} players` : '';
    document.getElementById('more').hidden = limit >= list.length;
  };
  const redo = () => {
    limit = PAGE;
    filter();
    draw();
  };
  redo();
  document.getElementById('q').addEventListener('input', (e) => ((prefs.q = e.target.value), redo()));
  document.getElementById('team').addEventListener('change', (e) => ((prefs.team = e.target.value), redo()));
  document.getElementById('pos').addEventListener('change', (e) => ((prefs.pos = e.target.value), redo()));
  document.getElementById('band').addEventListener('change', (e) => ((prefs.band = e.target.value), redo()));
  document.getElementById('sort').addEventListener('change', (e) => ((prefs.sort = e.target.value), redo()));
  document.getElementById('more').addEventListener('click', () => ((limit += PAGE), draw()));
}

// Top 10 risers and fallers over the last week, by % change. Each photo is ringed in its card's band colour.
function moversSection(m) {
  const list = (title, rows) => {
    const body = rows
      .map((r, i) => {
        const p = m.playerById[r.player_id];
        if (!p) return '';
        const ch = pct(r.to_pence, r.from_pence);
        const b = BANDS.find((x) => x.key === band(p.price_pence));
        return `<li class="clickable rarity band-${b.key}" data-player="${p.id}" title="${b.name} card"><span class="rank">${i + 1}</span>${img('photo', p.code)}
          <span class="who-name">${esc(p.web_name)} <span class="muted small">${esc(m.teamById[p.team_id]?.short_name)}</span></span>
          <span class="val">${money(r.to_pence)}</span><span class="chg ${cls(ch)}">${pctText(ch)}</span></li>`;
      })
      .join('');
    return `<div class="panel tight"><h3>${title}</h3><ol class="ranks">${body || `<li class="empty muted">No price moves in the last ${m.movers.days} days yet.</li>`}</ol></div>`;
  };
  return `<h2>Movers this week</h2><div class="movers">${list('Top risers', m.movers.risers)}${list('Top fallers', m.movers.fallers)}</div>`;
}
document.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-player]');
  if (li) navigate(`/player/${li.dataset.player}`);
});

function sparkline(points, empty = 'Price history appears after his first settled match.', label = 'Price history') {
  if (points.length < 2) return `<p class="muted small" style="margin:0">${empty}</p>`;
  const w = 600, h = 140, pad = 6;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const xy = points.map((v, i) => [pad + (i * (w - 2 * pad)) / (points.length - 1), h - pad - ((v - min) * (h - 2 * pad)) / span]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${label} from ${money(points[0])} to ${money(points[points.length - 1])}">
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
    <div class="panel tight next-match">
      <div class="nm-teams"><span class="who">${img('crest', teamById[next.team_h]?.code, 'md')}${esc(teamById[next.team_h]?.name)}</span> <span class="muted">v</span> <span class="who">${img('crest', teamById[next.team_a]?.code, 'md')}${esc(teamById[next.team_a]?.name)}</span></div>
      <div class="muted">${n.home ? 'Home' : 'Away'} vs ${esc(n.opp?.name)}${next.event ? ` · Gameweek ${next.event}` : ''}</div>
      <div class="nm-when">${next.finished_provisional ? '<span class="badge lock">Full time, waiting for final stats</span>' : next.started ? '<span class="badge live">Playing now</span>' : when(next.kickoff_time)}</div>
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

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const bpText = (bp) => `${bp > 0 ? '+' : bp < 0 ? '−' : ''}${Math.abs(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;

// What a player at this price is expected to earn from his stats (basis points),
// mirroring expectedBp in src/pricing.ts.
function expectedBp(position, pricePence, minutes = 90) {
  const e = state.config?.weights?.expected?.[position];
  if (!e) return null;
  return Math.round(((e.base + (e.perPound * pricePence) / 100) * Math.min(minutes, 90)) / 90);
}

// Parts of a breakdown that aren't from his own stats.
const NON_STAT_KEYS = ['expected', 'market', 'demand', 'did_not_play'];

// Plain-English line for each part of a stored price move (the keys scoreMatch writes).
function reasonLabel(key, s, bp, p) {
  const n = (k) => s?.[k] ?? 0;
  switch (key) {
    case 'appearance': return n('minutes') >= 60 ? `Played ${n('minutes')} minutes` : `Came on for ${plural(n('minutes'), 'minute')}`;
    case 'did_not_play': return "Didn't play";
    case 'goals': return n('goals') ? plural(n('goals'), 'goal') : 'Goals';
    case 'assists': return n('assists') ? plural(n('assists'), 'assist') : 'Assists';
    case 'clean_sheet': return 'Clean sheet';
    case 'goals_conceded': return n('goals_conceded') ? `${plural(n('goals_conceded'), 'goal')} conceded` : 'Goals conceded';
    case 'saves': return n('saves') ? plural(n('saves'), 'save') : 'Saves';
    case 'penalties_saved': return n('penalties_saved') > 1 ? `${n('penalties_saved')} penalties saved` : 'Penalty saved';
    case 'penalties_missed': return n('penalties_missed') > 1 ? `${n('penalties_missed')} penalties missed` : 'Penalty missed';
    case 'yellow_cards': return 'Yellow card';
    case 'red_cards': return 'Red card';
    case 'own_goals': return n('own_goals') > 1 ? `${n('own_goals')} own goals` : 'Own goal';
    case 'bonus': return n('bonus') ? plural(n('bonus'), 'bonus point') : 'Bonus points';
    case 'defensive_contribution': return n('defensive_contribution') ? `Defensive work (${n('defensive_contribution')} tackles, blocks, etc.)` : 'Defensive work';
    case 'expected': return `Expected of a ${money(s.old_price_pence)} ${(POSITIONS[p?.position] ?? 'player').toLowerCase()}${n('minutes') < 90 ? ` in ${plural(n('minutes'), 'minute')}` : ''}`;
    case 'market': return 'Market adjustment';
    case 'demand': return bp > 0 ? 'Fans buying his card' : 'Fans selling his card';
    default: return key.replace(/_/g, ' ');
  }
}

// Turns a match's stored breakdown (basis points per reason) into lines in pence
// that add up exactly to the real price move, including the per-match cap.
function matchBreakdown(s, p) {
  let parts = {};
  try { parts = JSON.parse(s.reason || '{}'); } catch {}
  const w = state.config?.weights ?? {};
  const items = Object.entries(parts).map(([key, bp]) => ({ label: reasonLabel(key, s, bp, p), bp }));
  const total = items.reduce((a, i) => a + i.bp, 0);
  const capped = Math.min(w.maxRise ?? Infinity, Math.max(w.maxFall ?? -Infinity, total));
  if (capped !== total) items.push({ label: total > 0 ? `Capped at the ${w.maxRise / 100}% max rise per match` : `Capped at the ${-w.maxFall / 100}% max fall per match`, bp: capped - total });
  // Round each line to whole pence; the odd penny of rounding goes on the biggest
  // line so the lines add up to the actual move.
  const pence = items.map((i) => Math.round((s.old_price_pence * i.bp) / 10000));
  const left = s.new_price_pence - s.old_price_pence - pence.reduce((a, v) => a + v, 0);
  if (left && pence.length) {
    const big = pence.reduce((b, v, i) => (Math.abs(v) > Math.abs(pence[b]) ? i : b), 0);
    pence[big] += left;
  }
  return items.map((it, i) => ({ ...it, pence: pence[i] }));
}

// One plain sentence on why his price moved in this match.
function matchVerdict(s) {
  let parts = {};
  try { parts = JSON.parse(s.reason || '{}'); } catch {}
  if (parts.did_not_play) return "He didn't play, so his price drifted down.";
  if (parts.expected === undefined) return null; // settled before prices were judged against expectations
  const stats = Object.entries(parts).filter(([k]) => !NON_STAT_KEYS.includes(k)).reduce((a, [, v]) => a + v, 0);
  const need = -parts.expected;
  const versus = `his stats earned ${bpText(stats)} against the ${bpText(need)} expected at his price`;
  if (stats > need) return `<b>Beat expectations:</b> ${versus}.`;
  if (stats < need) return `<b>Below expectations:</b> ${versus}.`;
  return `<b>Met expectations:</b> ${versus}.`;
}

function matchCard(s, p, teamById) {
  const home = s.team_h === p.team_id;
  const opp = teamById[home ? s.team_a : s.team_h];
  const move = s.new_price_pence - s.old_price_pence;
  const ch = pct(s.new_price_pence, s.old_price_pence);
  const verdict = matchVerdict(s);
  const lines = matchBreakdown(s, p)
    .map((l) => `<li><span>${esc(l.label)}</span><span class="muted small">${bpText(l.bp)}</span><span class="amt ${cls(l.pence)}">${signedMoney(l.pence)}</span></li>`)
    .join('');
  return `<div class="panel tight match">
    <div class="match-head">
      <div><span class="who">${img('crest', opp?.code)} ${esc(opp?.name ?? '')} (${home ? 'H' : 'A'}) ${s.team_h_score ?? ''}–${s.team_a_score ?? ''}</span>
        <div class="small muted">${when(s.kickoff_time)}</div></div>
      <div class="match-move"><span class="${cls(move)}">${signedMoney(move)}</span> <span class="small ${cls(ch)}">${pctText(ch)}</span>
        <div class="small muted">${money(s.old_price_pence)} → ${money(s.new_price_pence)}</div></div>
    </div>
    ${verdict ? `<p class="small verdict">${verdict}</p>` : ''}
    <ul class="breakdown">${lines || '<li><span class="muted">No change</span></li>'}</ul>
  </div>`;
}

async function playerPage(id) {
  const [d, m] = await Promise.all([api(`/players/${id}`), loadMarket()]);
  const p = d.player;
  const ch = pct(p.price_pence, p.prev_price_pence);
  const prices = d.history.length ? [d.history[d.history.length - 1].old_price_pence, ...d.history.slice().reverse().map((h) => h.new_price_pence)] : [];
  const held = d.holding?.cards ?? 0;
  state.owned[p.id] = held || undefined;

  app.innerHTML = `
    <a class="back" href="/" data-link>← Market</a>
    <div class="player-layout">
      <div class="side">
        ${playerCard(p, { ...m, teamState: { ...m.teamState, [p.team_id]: d.match_state ?? undefined } }, { featured: true, buy: false })}
        <div class="panel tight trade-box band-${band(p.price_pence)}" id="trade"></div>
      </div>
      <div class="main">
        <h1 style="margin-top:0">${esc(p.first_name)} ${esc(p.second_name)}</h1>
        <p class="muted who">${img('crest', p.team_code, 'md')}${esc(p.team_name)} · ${POSITIONS[p.position] ?? p.position}</p>
        ${d.match_state ? `<p>${matchBadge(d.match_state)}</p>` : ''}
        ${availabilityNote(p)}
        <div class="stats">
          <div class="stat"><div class="label">Price</div><div class="value">${money(p.price_pence)}</div></div>
          <div class="stat"><div class="label">Since full time</div><div class="value ${cls(ch)}">${p.prev_price_pence ? pctText(ch) : '–'}</div>${p.prev_price_pence ? `<div class="small muted">${signedMoney(p.price_pence - p.prev_price_pence)}</div>` : ''}</div>
          ${held ? `<div class="stat"><div class="label">You own</div><div class="value">${held}</div><div class="small muted">worth ${money(held * p.price_pence)}</div></div>` : ''}
        </div>
        <h2>Price history</h2>
        <div class="panel tight">${sparkline(prices)}</div>
        ${upcomingFixtures(d.upcoming, p.team_id, m.teamById)}
        <h2>Recent matches</h2>
        ${(() => {
          const need = expectedBp(p.position, p.price_pence);
          return need == null ? '<p class="small muted">What moved his price in each match.</p>'
            : `<p class="small muted">At ${money(p.price_pence)}, a ${POSITIONS[p.position].toLowerCase()} is expected to earn <b>${bpText(need)}</b> from his stats in a full match. Do better and his price rises; do worse and it falls. <a href="/how-it-works" data-link>How prices move</a></p>`;
        })()}
        ${d.matches.length ? `<div class="matches">${d.matches.map((s) => matchCard(s, p, m.teamById)).join('')}</div>` : '<p class="muted">No settled matches yet.</p>'}
      </div>
    </div>`;

  const box = document.getElementById('trade');
  if (!state.me) {
    box.innerHTML = `<h3>Collect this card</h3><p class="muted">Sign up to get a £100 virtual budget and start collecting.</p><a class="btn primary block" href="/login" data-link>Get your free £100 budget</a>`;
    return;
  }
  if (d.locked) {
    const why = {
      live: 'His match is being played right now. Trading reopens once the final stats are in and his new price is set.',
      awaiting: 'His match has finished. Trading reopens once the final stats are in and his new price is set, usually within about half an hour of full time.',
    }[d.match_state] ?? `His team kicks off ${when(d.locked_kickoff)}. Trading reopens once the match has been played and prices are settled.`;
    box.innerHTML = `<h3>Trading paused</h3><p class="muted">${why}</p>`;
    return;
  }
  const affordable = state.cash != null ? Math.floor(state.cash / p.price_pence) : null;
  box.innerHTML = `
    <h3>Buy</h3>
    <p class="small muted">Cash available: <b>${state.cash != null ? money(state.cash) : '–'}</b>${affordable != null ? ` · enough for ${cardsText(affordable)}` : ''}</p>
    <div class="buy-row row">${stepper(Math.max(1, Math.min(1000, affordable ?? 1000)), 'Number of cards to buy')}<button class="btn-band" data-buy="${p.id}" data-price="${p.price_pence}">${buyLabel(1, p.price_pence)}</button></div>
    ${
      held
        ? `<h3 style="margin-top:var(--space-3)">Sell</h3>
      <p class="small muted">You own ${cardsText(held)}, worth ${money(held * p.price_pence)}.</p>
      <div class="buy-row row">${stepper(held, 'Number of cards to sell')}<button class="btn danger" data-sell="${p.id}" data-price="${p.price_pence}">${sellLabel(1, p.price_pence)}</button></div>
      <p class="quote" data-sell-quote>${money(p.price_pence)} less the ${money(saleQuote(1, p.price_pence).fee)} fee (${FEE_BP() / 100}%).</p>
      ${held > 1 ? `<p><button class="link small" data-sell="${p.id}" data-all="1">Sell all ${held} for ${money(saleQuote(held, p.price_pence).net)}</button></p>` : ''}`
        : `<p class="small muted">Selling costs a ${FEE_BP() / 100}% fee.</p>`
    }`;
}

function rankRows(rows, scope) {
  if (!rows.length) return '<li class="empty muted">Nobody on the board yet.</li>';
  return rows
    .map(
      (r) => `<li><span class="rank">${r.rank}</span><span class="who-name">${esc(r.display_name)} ${state.me?.id === r.user_id ? '<span class="badge me">You</span>' : ''}</span>
        <span class="val ${scope === 'alltime' ? cls(r.total_pence) : ''}">${scope === 'alltime' ? signedMoney(r.total_pence) : money(r.total_pence)}</span></li>`,
    )
    .join('');
}

async function portfolioPage() {
  if (!state.me) return needLogin();
  const [pf, tr, m] = await Promise.all([api('/portfolio'), api('/trades'), loadMarket()]);
  state.cash = pf.cash_pence;
  state.owned = Object.fromEntries(pf.holdings.map((h) => [h.player_id, h.cards]));
  renderAccount();
  const profit = pf.total_pence - (state.config?.starting_cash_pence ?? 10000);
  app.innerHTML = `
    <h1>My cards</h1>
    ${packSection()}
    <div class="stats">
      <div class="stat"><div class="label">Total value</div><div class="value">${money(pf.total_pence)}</div><div class="small ${cls(profit)}">${signedMoney(profit)} this season</div></div>
      <div class="stat"><div class="label">Cash</div><div class="value">${money(pf.cash_pence)}</div></div>
      <div class="stat"><div class="label">Cards</div><div class="value">${money(pf.holdings_value_pence)}</div><div class="small muted">${cardsText(pf.holdings.reduce((a, h) => a + h.cards, 0))}</div></div>
    </div>
    <h2>Value over time</h2>
    <div class="panel tight chart-panel">${sparkline(
      // Everyone starts on the same budget; then one point a day, then right now.
      [state.config?.starting_cash_pence ?? 10000, ...pf.history.map((d) => d.value_pence), pf.total_pence],
      '',
      'Total value',
    )}<p class="small muted chart-note">From your ${money(state.config?.starting_cash_pence ?? 10000)} start to now, with a point added each day.</p></div>
    ${
      pf.holdings.length
        ? `<h2>Sell your cards</h2>
      <p class="small muted">Pick how many to sell. You get the price shown less the ${FEE_BP() / 100}% fee. To buy more of a player, open his card.</p>
      <div class="card-grid">${pf.holdings
        .map((h) => playerCard(m.playerById[h.player_id] ?? { ...h, id: h.player_id }, m, { sell: { cost: h.cost_pence, gain: h.value_pence - h.cost_pence } }))
        .join('')}</div>
      <h2>Breakdown</h2>
      <div class="table-wrap"><table><thead><tr><th>Player</th><th class="num">Cards</th><th class="num">Price</th><th class="num">Value</th><th class="num">Gain</th></tr></thead><tbody>
      ${pf.holdings
        .map((h) => {
          const gain = h.value_pence - h.cost_pence;
          return `<tr class="clickable" data-href="/player/${h.player_id}">
            <td><span class="who">${img('photo', h.code)}<span><b>${esc(h.web_name)}</b> <span class="small muted">${esc(h.team_short)} · ${h.position}</span>${h.match_state ? ' ' + matchBadge(h.match_state) : ' ' + availabilityBadge(h)}</span></span></td>
            <td class="num">${h.cards}</td><td class="num">${money(h.price_pence)}</td>
            <td class="num">${money(h.value_pence)}</td><td class="num ${cls(gain)}">${signedMoney(gain)}</td></tr>`;
        })
        .join('')}</tbody></table></div>`
        : `<div class="panel empty">You don't own any cards yet. <a href="/" data-link>Visit the market</a> to sign your first player.</div>`
    }
    <h2>Recent trades</h2>
    ${
      tr.trades.length
        ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Player</th><th>Side</th><th class="num">Cards</th><th class="num">Price</th><th class="num">Total</th><th class="num">Fee</th></tr></thead><tbody>
      ${tr.trades
        .map(
          (t) => `<tr><td class="small">${when(t.created_at)}</td><td>${esc(t.web_name)}</td><td class="${t.side === 'buy' ? 'rise' : 'fall'}">${t.side === 'buy' ? 'Bought' : 'Sold'}</td>
          <td class="num">${t.cards}</td><td class="num">${money(t.price_pence)}</td><td class="num">${money(t.gross_pence)}</td><td class="num">${t.fee_pence ? money(t.fee_pence) : '–'}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
        : '<p class="muted">No trades yet.</p>'
    }`;
}
document.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-href]');
  if (tr) navigate(tr.dataset.href);
});

async function fixturesPage() {
  const d = await api('/fixtures');
  const teamById = Object.fromEntries(d.teams.map((t) => [t.id, t]));
  const locked = new Set(d.locked_teams);
  const events = [...new Set(d.fixtures.map((f) => f.event).filter((e) => e != null))].sort((a, b) => a - b);
  const prefs = (fixturesPage.prefs ??= { event: null, team: '' });
  if (prefs.event == null || !events.includes(prefs.event)) prefs.event = d.current_event ?? events[events.length - 1] ?? null;

  app.innerHTML = `
    <h1>Fixtures</h1>
    <p class="intro">Premier League fixtures and results. Times are shown in your time zone. Pick a club to see its players.</p>
    <div class="toolbar">
      <select id="fx-team" aria-label="Club"><option value="">All clubs</option>${d.teams.map((t) => `<option value="${t.id}" ${String(t.id) === prefs.team ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <div class="seg" id="gw-nav"><button id="gw-prev" aria-label="Previous gameweek">‹</button><select id="gw" aria-label="Gameweek">${events.map((e) => `<option value="${e}" ${e === prefs.event ? 'selected' : ''}>Gameweek ${e}</option>`).join('')}</select><button id="gw-next" aria-label="Next gameweek">›</button></div>
    </div>
    <div id="fx-list"></div>`;

  const row = (f) => {
    // FPL marks a match finished only once bonus points are confirmed; full time comes first.
    const ft = f.finished || f.finished_provisional;
    const live = f.started && !ft;
    const mid = ft || live ? `${f.team_h_score ?? 0} – ${f.team_a_score ?? 0}` : f.kickoff_time ? new Date(f.kickoff_time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'TBC';
    // Locks by team are for trading; only flag the match that is actually causing the lock.
    const lockedNow = !f.finished && f.kickoff_time && new Date(f.kickoff_time).getTime() - Date.now() <= d.lock_hours * 3_600_000 && (locked.has(f.team_h) || locked.has(f.team_a));
    const team = (id, side) => `<a href="/" class="fx-team ${side}" data-team="${id}">${img('crest', teamById[id]?.code, 'md')}<span class="hide-sm">${esc(teamById[id]?.name)}</span><span class="show-sm">${esc(teamById[id]?.short_name)}</span></a>`;
    return `<div class="fx-row">
      ${team(f.team_h, 'home')}
      <div class="fx-mid">${mid}${live ? '<div class="small rise">Live</div>' : ft ? '<div class="small muted">FT</div>' : lockedNow ? '<div><span class="badge lock">Locked</span></div>' : ''}</div>
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
      ? groups.map((g) => `<h3 class="fx-day">${esc(g.k)}</h3><div class="panel fx-card">${g.rows.map(row).join('')}</div>`).join('')
      : `<div class="panel empty">${d.fixtures.length ? 'No upcoming fixtures.' : "Fixtures haven't loaded yet."}</div>`;
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
    e.stopPropagation();
    homePage.prefs = { ...(homePage.prefs ?? { q: '', pos: '', band: '', sort: 'price-desc' }), team: a.dataset.team, q: '' };
    navigate('/');
  });
}

function scopeToggle(scope) {
  return `<div class="seg"><button data-scope="season" class="${scope === 'season' ? 'on' : ''}">This season</button><button data-scope="alltime" class="${scope === 'alltime' ? 'on' : ''}">All time</button></div>`;
}

async function leaderboardPage(scope = 'season') {
  const d = await api(`/leaderboard?scope=${scope}`);
  app.innerHTML = `<h1>Leaderboard</h1>
    <p class="intro">${scope === 'alltime' ? 'Profit added up across every season.' : 'Ranked by total value: cash plus cards at today\'s prices.'}</p>
    <div class="toolbar">${scopeToggle(scope)}</div>
    <div class="panel" style="max-width:720px"><ol class="ranks">${rankRows(d.standings, scope)}</ol></div>`;
  app.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => leaderboardPage(b.dataset.scope)));
}

async function leaguesPage() {
  if (!state.me) return needLogin();
  const d = await api('/leagues');
  app.innerHTML = `
    <h1>Private leagues</h1>
    <p class="intro">Compete with friends. Create a league and share its code, or join one with a code.</p>
    <div class="two-col">
      <div>${
        d.leagues.length
          ? `<div class="table-wrap"><table><thead><tr><th>League</th><th>Code</th><th class="num">Members</th></tr></thead><tbody>
        ${d.leagues.map((l) => `<tr><td><a href="/leagues/${l.id}" data-link>${esc(l.name)}</a></td><td class="code" style="font-size:16px">${esc(l.code)}</td><td class="num">${l.members}</td></tr>`).join('')}
        </tbody></table></div>`
          : '<div class="panel empty">You are not in any leagues yet.</div>'
      }</div>
      <div class="panel">
        <h3>Create a league</h3>
        <div class="toolbar"><input id="lname" placeholder="League name" aria-label="League name" maxlength="40"><button class="btn primary" id="create">Create</button></div>
        <h3>Join a league</h3>
        <div class="toolbar"><input id="lcode" placeholder="Code" aria-label="League code" maxlength="6" style="text-transform:uppercase"><button class="btn" id="join-league">Join</button></div>
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
  document.getElementById('join-league').addEventListener('click', async () => {
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
    <a class="back" href="/leagues" data-link>← Leagues</a>
    <h1>${esc(d.league.name)}</h1>
    <p class="intro">Invite friends with code <span class="code">${esc(d.league.code)}</span></p>
    <div class="toolbar">${scopeToggle(scope)}<button class="btn danger" id="leave" style="margin-left:auto">Leave league</button></div>
    <div class="panel" style="max-width:720px"><ol class="ranks">${rankRows(d.standings, scope)}</ol></div>`;
  app.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => leaguePage(id, b.dataset.scope)));
  document.getElementById('leave').addEventListener('click', async () => {
    if (!confirm('Leave this league?')) return;
    await api(`/leagues/${id}/leave`, { method: 'POST' });
    navigate('/leagues');
  });
}

function loginPage() {
  app.innerHTML = `<div class="narrow">${signupPanel()}</div>`;
  document.querySelector('#join h2').textContent = 'Sign in or join';
  document.querySelector('#join p').textContent = "We'll email you a link to sign in. New here? The same link creates your account with a £100 virtual budget.";
  document.querySelector('#join button').textContent = 'Email me a link';
  wireSignup();
}

async function verifyPage() {
  const token = new URLSearchParams(location.search).get('token');
  app.innerHTML = '<p class="muted">Signing you in…</p>';
  try {
    const r = await api('/auth/verify', { method: 'POST', body: { token } });
    state.me = r.user;
    await refreshWallet();
    history.replaceState(null, '', r.is_new ? '/account' : '/');
    if (r.is_new) toast('Welcome! You have £100 to spend. Pick a display name first.');
    route();
  } catch (e) {
    app.innerHTML = `<div class="signup narrow"><h2>Link expired</h2><p>${esc(e.message)}</p><a class="btn primary lg block" href="/login" data-link>Get a new link</a></div>`;
  }
}

function accountPage() {
  if (!state.me) return needLogin();
  app.innerHTML = `
    <div class="panel narrow">
      <h2>Your account</h2>
      <p class="muted small">${esc(state.me.email)}</p>
      <form id="acct" class="trade-box">
        <label for="dname">Display name (shown on leaderboards)</label>
        <input id="dname" maxlength="24" value="${esc(state.me.display_name)}">
        <button class="btn primary">Save</button>
      </form>
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
    await refreshWallet();
    navigate('/');
  });
}

function rulesPage() {
  const c = state.config;
  const w = c.weights;
  const bp = (v) => (v ? bpText(v) : '–');
  const POS = ['GKP', 'DEF', 'MID', 'FWD'];
  const same = (v) => POS.map(() => v);
  const statRows = [
    ['Goal', POS.map((p) => w.goal[p])],
    ['Assist', same(w.assist)],
    ['Clean sheet (60+ minutes)', POS.map((p) => w.cleanSheet[p])],
    ['Every 2 goals conceded', POS.map((p) => w.per2GoalsConceded[p])],
    ['Every 3 saves', POS.map((p) => (p === 'GKP' ? w.per3Saves : 0))],
    ['Penalty saved', same(w.penaltySaved)],
    ['Penalty missed', same(w.penaltyMissed)],
    ['Each FPL bonus point (1 to 3)', same(w.perBonusPoint)],
    ['Defensive contribution threshold reached', POS.map((p) => (p === 'GKP' ? 0 : w.defensiveContribution))],
    ['Yellow card', same(w.yellowCard)],
    ['Red card', same(w.redCard)],
    ['Own goal', same(w.ownGoal)],
  ];
  const prices = [400, 600, 800, 1000, 1200, 1400];
  // Worked example: a £10 midfielder who scores once and gets 2 bonus points in a full match.
  const exStats = w.goal.MID + 2 * w.perBonusPoint;
  const exNeed = expectedBp('MID', 1000);
  const exMove = exStats - exNeed;
  app.innerHTML = `
    <h1>How it works</h1>
    <div class="panel rules">
      <ol>
        <li>Sign up and get a <b>${money(c.starting_cash_pence)}</b> virtual budget for the season. It's play money only: it can't be topped up or cashed out.</li>
        <li>Every Premier League player is a card. Buy cards at the player's current price. You can own several of the same card, but only whole cards.</li>
        <li>A card's colour shows its price band: gold from £7.00, silver from £5.00 to £6.99, bronze under £5.00. Cards change colour as prices move.</li>
        <li>Trading on a player locks <b>2 hours before kick-off</b>. Once the official stats are confirmed after the final whistle, his price moves (see below) and trading reopens.</li>
        <li>Selling costs a <b>${c.sell_fee_bp / 100}% fee</b>.</li>
        <li>Each gameweek you can buy one <b>pack</b> for ${money(c.pack_price_pence)}. It holds one random card from a fit player whose match isn't under way: ${c.pack_odds.slice().reverse().map((o) => `${o.percent}% ${BAND_NAMES[o.band]}`).join(', ')}. The price is about what the average pull is worth, so a pack is a gamble on a Gold rather than free money. Opening one doesn't move the player's price.</li>
        <li>The leaderboard ranks everyone by total value: cash plus cards at today's prices. Everyone restarts with ${money(c.starting_cash_pence)} each season, and the all-time table adds up your profit across seasons.</li>
      </ol>
    </div>

    <h2>How prices move</h2>
    <div class="panel rules">
      <p>Prices reward players who do <b>better than expected for their price</b>, not just players who turn up. An ordinary game leaves a price about where it was, so you make money by backing players before they outperform, not by holding cards all season.</p>
      <ol>
        <li><b>Stats score.</b> Everything he did in the match adds up to a percentage, using the stat points below.</li>
        <li><b>Minus what's expected.</b> We take off what a player at his price and position normally earns in that many minutes. Pricier players are expected to do more, so a star has to keep delivering just to hold his value.</li>
        <li><b>Market adjustment.</b> If players across the league have been beating expectations on average this season, every match takes that average back off (or adds it back if they've been missing). This keeps the market as a whole from drifting up or down. It's capped at ±${w.marketCap / 100}%.</li>
        <li><b>Demand.</b> Every 10 cards bought (minus sold) since his last match adds ${bp(w.demandPer10Cards)}, capped at ±${w.demandCap / 100}%.</li>
        <li><b>Didn't play?</b> If his team plays without him, his price drifts ${bp(w.didNotPlay)}.</li>
      </ol>
      <p>The total move is capped between ${bp(w.maxFall)} and ${bp(w.maxRise)} per match. Every player's page shows this breakdown for each of his matches.</p>
      ${exNeed != null ? `<p class="small muted"><b>Example:</b> a ${money(1000)} midfielder scores once and gets 2 bonus points in a full match. His stats earn ${bp(exStats)}, he was expected to earn ${bp(exNeed)}, so his price moves ${bp(exMove)} to ${money(Math.round(1000 * (1 + exMove / 10000)))}. A quiet 90 minutes would cost him ${bp(-exNeed)}.</p>` : ''}
    </div>

    <h2>Stat points</h2>
    <div class="table-wrap"><table class="weights">
      <thead><tr><th></th>${POS.map((p) => `<th>${p}</th>`).join('')}</tr></thead>
      <tbody>${statRows.map(([label, vals]) => `<tr><td>${label}</td>${vals.map((v) => `<td>${bp(v)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>

    <h2>What's expected in a full match</h2>
    <p class="small muted">Taken off every match he plays (less if he plays part of a match). These are set from last season's data so an average performance is worth about 0%.</p>
    <div class="table-wrap"><table class="weights">
      <thead><tr><th>Price</th>${POS.map((p) => `<th>${p}</th>`).join('')}</tr></thead>
      <tbody>${prices.map((pence) => `<tr><td>${money(pence)}</td>${POS.map((p) => `<td>${bp(expectedBp(p, pence))}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
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
    if (path === '/') await homePage();
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
    app.innerHTML = `<div class="panel empty">${esc(e.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

(async function start() {
  const [me, config] = await Promise.all([api('/me').catch(() => ({ user: null })), api('/config')]);
  state.me = me.user;
  state.config = config;
  renderAccount();
  await refreshWallet();
  route();
})();
