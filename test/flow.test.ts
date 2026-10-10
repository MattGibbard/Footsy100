import { beforeEach, describe, expect, it } from 'vitest';
import { emptyStats, type DataProvider } from '../src/fpl';
import { createLeague, joinLeague, leaderboard, leagueDetail, leaveLeague, myLeagues } from '../src/leagues';
import { buy, getPlayer, listFixtures, listPlayers, portfolio, sell, topMovers } from '../src/market';
import type { MatchStats } from '../src/pricing';
import { runLiveScores, runSync } from '../src/sync';
import { createD1 } from './d1shim';

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + 'Z';

interface FakeFixture {
  id: number;
  event: number;
  team_h: number;
  team_a: number;
  kickoff_time: string;
  started: boolean;
  finished: boolean;
  finished_provisional?: boolean;
  team_h_score: number | null;
  team_a_score: number | null;
}

// Serves FPL-shaped JSON text, the same shape the real API returns.
function fakeProvider() {
  const fixtures: FakeFixture[] = [
    // Arsenal v Chelsea kicks off in 5 hours, Liverpool v Spurs next week.
    { id: 1, event: 8, team_h: 1, team_a: 2, kickoff_time: iso(Date.now() + 5 * HOUR), started: false, finished: false, team_h_score: null, team_a_score: null },
    { id: 2, event: 9, team_h: 3, team_a: 4, kickoff_time: iso(Date.now() + 7 * 24 * HOUR), started: false, finished: false, team_h_score: null, team_a_score: null },
  ];
  const stats = new Map<number, MatchStats>();
  const el = (id: number, first: string, second: string, team: number, type: number, cost: number) => ({
    can_transact: true, code: 50000 + id, id, first_name: first, second_name: second, web_name: second, team, element_type: type, status: 'a', now_cost: cost,
  });
  const provider: DataProvider & { fixtures: FakeFixture[]; stats: Map<number, MatchStats> } = {
    fixtures,
    stats,
    async bootstrapText() {
      return JSON.stringify({
        events: [{ id: 1, deadline_time: '2026-08-21T17:30:00Z' }],
        teams: [
          { code: 3, id: 1, name: 'Arsenal', short_name: 'ARS' },
          { code: 8, id: 2, name: 'Chelsea', short_name: 'CHE' },
          { code: 14, id: 3, name: 'Liverpool', short_name: 'LIV' },
          { code: 6, id: 4, name: 'Spurs', short_name: 'TOT' },
        ],
        total_players: 1,
        element_types: [{ id: 1, singular_name_short: 'GKP' }],
        elements: [
          el(100, 'Bukayo', 'Saka', 1, 3, 100),
          el(101, 'David', 'Raya', 1, 1, 55),
          el(200, 'Cole', 'Palmer', 2, 3, 105),
          el(300, 'Mohamed', 'Salah', 3, 3, 140),
          { ...el(999, 'Mikel', 'Arteta', 1, 5, 15) }, // managers (type 5) are skipped
        ],
      });
    },
    async fixturesText() {
      return JSON.stringify(fixtures.map((f) => ({ code: 1000 + f.id, ...f, stats: [{ identifier: 'goals_scored', a: [], h: [] }] })));
    },
    async gameweekFixturesText(event) {
      const fs = fixtures.filter((f) => f.event === event);
      const statLists = (key: keyof MatchStats, id: string) =>
        fs.map((f) => ({ fixture: f.id, identifier: id, h: [...stats].filter(([p]) => p < 200 || (p >= 300 && p < 400)).map(([p, s]) => ({ element: p, value: s[key] })).filter((r) => r.value), a: [...stats].filter(([p]) => (p >= 200 && p < 300) || p >= 400).map(([p, s]) => ({ element: p, value: s[key] })).filter((r) => r.value) }));
      const ids: [keyof MatchStats, string][] = [['goals', 'goals_scored'], ['assists', 'assists'], ['yellow_cards', 'yellow_cards'], ['red_cards', 'red_cards'], ['saves', 'saves'], ['bonus', 'bonus'], ['bps', 'bps'], ['own_goals', 'own_goals']];
      return JSON.stringify(
        fs.map((f) => ({ code: 1000 + f.id, ...f, stats: ids.map(([k, id]) => { const l = statLists(k, id).find((x) => x.fixture === f.id)!; return { identifier: id, a: l.a, h: l.h }; }) })),
      );
    },
    async liveText(event) {
      const fixtureIds = fixtures.filter((f) => f.event === event).map((f) => f.id);
      return JSON.stringify({
        elements: [...stats].map(([id, s]) => ({
          id,
          stats: { minutes: s.minutes },
          explain: fixtureIds.map((fixture) => ({
            fixture,
            stats: [
              { identifier: 'minutes', points: 2, value: s.minutes, points_modification: 0 },
              ...(s.clean_sheet ? [{ identifier: 'clean_sheets', points: 4, value: 1, points_modification: 0 }] : []),
              ...(s.goals_conceded ? [{ identifier: 'goals_conceded', points: -1, value: s.goals_conceded, points_modification: 0 }] : []),
            ],
          })),
        })),
      });
    },
  };
  return provider;
}

async function addUser(db: D1Database, email: string) {
  return (await db.prepare('INSERT INTO users (email, display_name) VALUES (?, ?) RETURNING id').bind(email, email.split('@')[0]).first<number>('id'))!;
}

describe('trading and settlement', () => {
  let db: D1Database;
  let provider: ReturnType<typeof fakeProvider>;
  let alice: number;
  let bob: number;

  beforeEach(async () => {
    db = createD1();
    provider = fakeProvider();
    await runSync(db, provider);
    alice = await addUser(db, 'alice@example.com');
    bob = await addUser(db, 'bob@example.com');
  });

  it('seeds players at provider prices with £100 accounts', async () => {
    const m = await listPlayers(db);
    expect(m.players).toHaveLength(4);
    expect(m.players.find((p) => p.id === 100)).toMatchObject({ code: 50100 });
    expect(m.teams.find((t) => t.id === 1)).toMatchObject({ code: 3 });
    expect((await portfolio(db, alice)).cash_pence).toBe(10_000);
    expect(m.next_fixtures[1]).toMatchObject({ opponent: 2, home: true });
    expect(m.locked_teams).toEqual([]);
  });

  it('lists fixtures and shows a player\'s next matches', async () => {
    const f = await listFixtures(db);
    expect(f.fixtures.map((x) => x.id)).toEqual([1, 2]);
    expect(f.current_event).toBe(8);
    expect(f.teams).toHaveLength(4);

    const saka = await getPlayer(db, 100, null);
    expect(saka.upcoming).toEqual([expect.objectContaining({ id: 1, team_h: 1, team_a: 2, event: 8 })]);

    // Once Arsenal v Chelsea is finished it drops off, and gameweek 9 becomes current.
    provider.fixtures[0] = { ...provider.fixtures[0], kickoff_time: iso(Date.now() - 2 * HOUR), started: true, finished: true, team_h_score: 1, team_a_score: 0 };
    await runSync(db, provider);
    expect((await getPlayer(db, 100, null)).upcoming).toEqual([]);
    expect((await getPlayer(db, 300, null)).upcoming).toEqual([expect.objectContaining({ id: 2 })]);
    expect((await listFixtures(db)).current_event).toBe(9);
  });

  it('buys fractional shares, blocks overspending and oversells', async () => {
    const r = await buy(db, alice, 100, 2500); // £25 of Saka at £10
    expect(r.shares_micro).toBe(2_500_000);
    await expect(buy(db, alice, 300, 8000)).rejects.toThrow('Not enough cash');
    const pf = await portfolio(db, alice);
    expect(pf.cash_pence).toBe(7500);
    expect(pf.total_pence).toBe(10_000);
    await expect(sell(db, alice, 100, 3_000_000)).rejects.toThrow("don't own that many");
    await expect(sell(db, bob, 100, null)).rejects.toThrow("don't own any");
  });

  it('charges 2% on sales', async () => {
    await buy(db, alice, 100, 1000);
    const r = await sell(db, alice, 100, null);
    expect(r).toMatchObject({ gross_pence: 1000, fee_pence: 20, net_pence: 980 });
    const pf = await portfolio(db, alice);
    expect(pf.cash_pence).toBe(9980);
    expect(pf.holdings).toHaveLength(0);
  });

  it('locks trading two hours before kickoff and reopens after settlement', async () => {
    await buy(db, alice, 100, 5000);
    await buy(db, bob, 200, 5000);

    // Kickoff moves to 90 minutes away: Arsenal and Chelsea players lock.
    provider.fixtures[0].kickoff_time = iso(Date.now() + 1.5 * HOUR);
    await runSync(db, provider);
    expect((await listPlayers(db)).locked_teams.sort()).toEqual([1, 2]);
    await expect(buy(db, alice, 100, 100)).rejects.toThrow('locked');
    await expect(sell(db, alice, 100, null)).rejects.toThrow('locked');
    await buy(db, alice, 300, 100); // Liverpool still tradable

    // Match finishes: Saka scores twice, Raya concedes 2, Palmer is booked.
    provider.fixtures[0] = { ...provider.fixtures[0], kickoff_time: iso(Date.now() - 2 * HOUR), started: true, finished: true, team_h_score: 2, team_a_score: 2 };
    provider.stats.set(100, { ...emptyStats(), minutes: 90, goals: 2, bonus: 3 });
    provider.stats.set(101, { ...emptyStats(), minutes: 90, goals_conceded: 2, saves: 3 });
    provider.stats.set(200, { ...emptyStats(), minutes: 90, yellow_cards: 1 });
    const res = await runSync(db, provider);
    expect(res.settled).toEqual([1]);

    const prices = Object.fromEntries((await listPlayers(db)).players.map((p) => [p.id, p.price_pence]));
    // Saka: +1% app, +16% goals, +3% bonus, +0.05% demand (£50 net bought) = +20.05%
    expect(prices[100]).toBe(1201);
    // Raya: +1% app, -1% conceded, +1% saves = +1%
    expect(prices[101]).toBe(556);
    // Palmer: +1% app, -2% yellow, +0.05% demand = -0.95%
    expect(prices[200]).toBe(1040);
    expect(prices[300]).toBe(1400); // didn't play yet

    // Risers and fallers rank by % change over the last week.
    const { movers } = await listPlayers(db);
    expect(movers.risers[0]).toEqual({ player_id: 100, from_pence: 1000, to_pence: 1201, change: expect.closeTo(0.201) });
    expect(movers.risers.map((r) => r.player_id)).toContain(101);
    expect(movers.fallers.map((r) => r.player_id)).toContain(200);
    expect([...movers.risers, ...movers.fallers].map((r) => r.player_id)).not.toContain(300);
    const later = await topMovers(db, new Date(Date.now() + 8 * 24 * HOUR));
    expect(later.risers).toEqual([]);
    expect(later.fallers).toEqual([]);

    // Settled: trading reopens and a re-run doesn't move prices twice.
    expect((await listPlayers(db)).locked_teams).toEqual([]);
    expect((await runSync(db, provider)).settled).toEqual([]);
    const sale = await sell(db, alice, 100, null);
    expect(sale.gross_pence).toBe(Math.floor((5_000_000 * 1201) / 1_000_000));

    const board = await leaderboard(db, 'season');
    expect(board[0].user_id).toBe(alice);
    expect(board.map((r) => r.rank)).toEqual([1, 2]);
  });

  it('treats matches finished before the first sync as history', async () => {
    const fresh = createD1();
    const p = fakeProvider();
    p.fixtures[0] = { ...p.fixtures[0], kickoff_time: iso(Date.now() - 48 * HOUR), started: true, finished: true, team_h_score: 1, team_a_score: 0 };
    p.stats.set(100, { ...emptyStats(), minutes: 90, goals: 1 });
    const res = await runSync(fresh, p);
    expect(res.settled).toEqual([]);
    expect((await listPlayers(fresh)).players.find((x) => x.id === 100)?.price_pence).toBe(1000);
  });

  it('runs private leagues', async () => {
    const league = (await createLeague(db, alice, 'Five-a-side lads'))!;
    expect(league.code).toMatch(/^[A-Z2-9]{6}$/);
    await joinLeague(db, bob, league.code.toLowerCase());
    const detail = await leagueDetail(db, bob, league.id, 'season');
    expect(detail.standings).toHaveLength(2);
    const carol = await addUser(db, 'carol@example.com');
    await expect(leagueDetail(db, carol, league.id, 'season')).rejects.toThrow('not found');
    await expect(joinLeague(db, carol, 'NOPE00')).rejects.toThrow('No league');
    await leaveLeague(db, bob, league.id);
    await leaveLeague(db, alice, league.id);
    expect(await myLeagues(db, alice)).toEqual([]);
  });

  it('refreshes live scores between full syncs, and does nothing when no match is on', async () => {
    const calls: number[] = [];
    const gameweek = provider.gameweekFixturesText.bind(provider);
    provider.gameweekFixturesText = async (event) => (calls.push(event), gameweek(event));
    expect(await runLiveScores(db, provider)).toEqual([]);

    provider.fixtures[0] = { ...provider.fixtures[0], kickoff_time: iso(Date.now() - HOUR), started: true, team_h_score: 2, team_a_score: 1 };
    await runSync(db, provider);
    provider.fixtures[0].team_h_score = 3;
    expect(await runLiveScores(db, provider)).toEqual([8]);
    expect(calls).toEqual([8]);
    expect((await listFixtures(db)).fixtures[0]).toMatchObject({ started: 1, finished: 0, finished_provisional: 0, team_h_score: 3, team_a_score: 1 });

    // Final whistle: FPL marks it provisionally finished, but prices wait for the confirmed stats.
    Object.assign(provider.fixtures[0], { finished_provisional: true });
    await runLiveScores(db, provider);
    expect((await listFixtures(db)).fixtures[0]).toMatchObject({ finished: 0, finished_provisional: 1 });
    expect((await runSync(db, provider)).settled).toEqual([]);
  });

  it('resets everyone to £100 for a new season and keeps an all-time table', async () => {
    await buy(db, alice, 100, 5000);
    await db.prepare('UPDATE players SET price_pence = 2000 WHERE id = 100').run(); // Saka doubles
    await portfolio(db, bob);

    // Next season's fixture list arrives: same ids, new matches.
    provider.fixtures.forEach((f) => (f.kickoff_time = `2027-08-2${f.id}T14:00:00Z`));
    await runSync(db, provider);
    expect(await db.prepare('SELECT name FROM seasons WHERE active = 1').first('name')).toBe('2027/28');

    expect((await portfolio(db, alice)).total_pence).toBe(10_000);
    const prices = Object.fromEntries((await listPlayers(db)).players.map((p) => [p.id, p.price_pence]));
    expect(prices[100]).toBe(1000);
    const allTime = await leaderboard(db, 'alltime');
    expect(allTime.find((r) => r.user_id === alice)?.total_pence).toBe(5000); // £50 profit last season
    expect(allTime.find((r) => r.user_id === bob)?.total_pence).toBe(0);
  });
});
