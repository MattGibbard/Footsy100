// Replays a past Premier League season through the real price engine to check
// that prices don't drift up just from holding cards, and that good performers
// still rise. Uses the per-match FPL data at github.com/vaastav/Fantasy-Premier-League.
//
//   node --experimental-strip-types scripts/simulate-season.mjs [season] [--fit]
//
// season defaults to 2025-26. --fit prints the per-position expectation that
// makes an average match worth 0%, for pasting into WEIGHTS.expected.
// Demand is left out: there are no trades to replay.

import { applyChange, expectedBp, marketAdjustment, scoreMatch } from '../src/pricing.ts';

const args = process.argv.slice(2);
const season = args.find((a) => !a.startsWith('--')) ?? '2025-26';
const fit = args.includes('--fit');

const url = `https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data/${season}/gws/merged_gw.csv`;
const res = await fetch(url);
if (!res.ok) throw new Error(`${url}: ${res.status}`);
const rows = parseCsv(await res.text())
  .map((r) => ({ ...r, position: r.position === 'GK' ? 'GKP' : r.position }))
  .filter((r) => ['GKP', 'DEF', 'MID', 'FWD'].includes(r.position));
rows.sort((a, b) => a.kickoff_time.localeCompare(b.kickoff_time) || +a.fixture - +b.fixture);

const n = (r, k) => +(r[k] ?? 0) || 0;
const statLine = (r) => ({
  minutes: n(r, 'minutes'),
  goals: n(r, 'goals_scored'),
  assists: n(r, 'assists'),
  clean_sheet: n(r, 'clean_sheets'),
  goals_conceded: n(r, 'goals_conceded'),
  own_goals: n(r, 'own_goals'),
  penalties_saved: n(r, 'penalties_saved'),
  penalties_missed: n(r, 'penalties_missed'),
  yellow_cards: n(r, 'yellow_cards'),
  red_cards: n(r, 'red_cards'),
  saves: n(r, 'saves'),
  bonus: n(r, 'bonus'),
  bps: n(r, 'bps'),
  defensive_contribution: n(r, 'defensive_contribution'),
});

if (fit) {
  // Least squares per position: stat score ~ (minutes / 90) * (base + perPound * £price).
  const sums = {};
  for (const r of rows) {
    const s = statLine(r);
    if (s.minutes <= 0) continue;
    const pence = n(r, 'value') * 10;
    const { vsExpectedBp } = scoreMatch(r.position, s, { pricePence: pence });
    const y = vsExpectedBp + expectedBp(r.position, pence, s.minutes);
    const w = Math.min(s.minutes, 90) / 90;
    const x1 = w, x2 = (w * pence) / 100;
    const a = (sums[r.position] ??= { a11: 0, a12: 0, a22: 0, b1: 0, b2: 0 });
    a.a11 += x1 * x1; a.a12 += x1 * x2; a.a22 += x2 * x2; a.b1 += x1 * y; a.b2 += x2 * y;
  }
  for (const [pos, a] of Object.entries(sums)) {
    const det = a.a11 * a.a22 - a.a12 * a.a12;
    const base = (a.b1 * a.a22 - a.b2 * a.a12) / det;
    const perPound = (a.a11 * a.b2 - a.a12 * a.b1) / det;
    console.log(`${pos}: { base: ${Math.round(base)}, perPound: ${Math.round(perPound)} },`);
  }
  process.exit(0);
}

const players = new Map();
let sum = 0, count = 0; // season-to-date vs-expected, as the database keeps it
const byFixture = Map.groupBy(rows, (r) => r.fixture);
const index = []; // average price relative to start, after each gameweek
for (const fixtureRows of byFixture.values()) {
  const marketBp = marketAdjustment(count ? sum / count : null);
  const settled = [];
  for (const r of fixtureRows) {
    const p = players.get(r.element) ?? { name: r.name, position: r.position, start: n(r, 'value') * 10, minutes: 0, points: 0 };
    p.price ??= p.start;
    players.set(r.element, p);
    const s = statLine(r);
    const { changeBp, vsExpectedBp } = scoreMatch(r.position, s.minutes > 0 ? s : null, { pricePence: p.price, marketBp });
    p.price = applyChange(p.price, changeBp);
    p.minutes += s.minutes;
    p.points += n(r, 'total_points');
    p.gw = +r.GW;
    if (vsExpectedBp !== null) settled.push(vsExpectedBp);
  }
  for (const v of settled) { sum += v; count++; }
  const gw = +fixtureRows[0].GW;
  const all = [...players.values()];
  index[gw] = all.reduce((a, p) => a + p.price, 0) / all.reduce((a, p) => a + p.start, 0);
}

const change = (p) => p.price / p.start - 1;
const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : 0; };
const basket = (ps) => ps.reduce((a, p) => a + p.price / p.start, 0) / ps.length - 1; // equal £ in each at the start

const all = [...players.values()];
const regulars = all.filter((p) => p.minutes >= 2000);
console.log(`${season}: ${all.length} players, ${regulars.length} regulars (2,000+ minutes)\n`);
console.log(`Whole market (equal £ in every player):   ${pct(basket(all))}`);
console.log(`Hold every regular all season:            ${pct(basket(regulars))}`);
console.log(`Median regular:                           ${pct(median(regulars.map(change)))}`);
console.log(`Regulars that rose:                       ${Math.round((100 * regulars.filter((p) => change(p) > 0).length) / regulars.length)}%`);
for (const pos of ['GKP', 'DEF', 'MID', 'FWD']) {
  console.log(`  ${pos} median regular:                     ${pct(median(regulars.filter((p) => p.position === pos).map(change)))}`);
}
// Did performing pay? Rank regulars by FPL points per £ of starting price.
const ranked = [...regulars].sort((a, b) => b.points / b.start - a.points / a.start);
const q = Math.floor(ranked.length / 4);
console.log(`\nBest quarter by FPL points per £:          ${pct(basket(ranked.slice(0, q)))}`);
console.log(`Worst quarter by FPL points per £:         ${pct(basket(ranked.slice(-q)))}`);
console.log(`\nMarket index by gameweek: ${[5, 10, 19, 28, 38].filter((g) => index[g]).map((g) => `GW${g} ${pct(index[g] - 1)}`).join(', ')}`);
const top = [...all].sort((a, b) => change(b) - change(a));
const line = (p) => `  ${p.name} (${p.position}) £${(p.start / 100).toFixed(2)} -> £${(p.price / 100).toFixed(2)} ${pct(change(p))}, ${p.points} pts`;
console.log('\nBiggest risers:');
top.slice(0, 8).forEach((p) => console.log(line(p)));
console.log('Biggest fallers among regulars:');
top.filter((p) => p.minutes >= 2000).slice(-5).forEach((p) => console.log(line(p)));

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const cells = [];
    let cur = '', quoted = false;
    for (const ch of l) {
      if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(head.map((h, i) => [h, cells[i]?.trim()]));
  });
}
