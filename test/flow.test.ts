import { beforeEach, describe, expect, it } from 'vitest';
import { emptyStats, type DataProvider, type ProviderFixture } from '../src/fpl';
import { createLeague, joinLeague, leaderboard, leagueDetail, leaveLeague, myLeagues } from '../src/leagues';
import { buy, listPlayers, portfolio, sell } from '../src/market';
import type { MatchStats } from '../src/pricing';
import { runSync } from '../src/sync';
import { createD1 } from './d1shim';

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + 'Z';

function fakeProvider(season = '2026/27') {
  const fixtures: ProviderFixture[] = [
    // Arsenal v Chelsea kicks off in 5 hours, Liverpool v Spurs next week.
    { id: 1, event: 8, team_h: 1, team_a: 2, kickoff_time: iso(Date.now() + 5 * HOUR), started: false, finished: false, team_h_score: null, team_a_score: null },
    { id: 2, event: 9, team_h: 3, team_a: 4, kickoff_time: iso(Date.now() + 7 * 24 * HOUR), started: false, finished: false, team_h_score: null, team_a_score: null },
  ];
  const stats = new Map<number, MatchStats>();
  const provider: DataProvider & { fixtures: ProviderFixture[]; stats: Map<number, MatchStats>; season: string } = {
    fixtures,
    stats,
    season,
    async getSeasonName() {
      return provider.season;
    },
    async getTeamsAndPlayers() {
      return {
        teams: [
          { id: 1, name: 'Arsenal', short_name: 'ARS' },
          { id: 2, name: 'Chelsea', short_name: 'CHE' },
          { id: 3, name: 'Liverpool', short_name: 'LIV' },
          { id: 4, name: 'Spurs', short_name: 'TOT' },
        ],
        players: [
          { id: 100, first_name: 'Bukayo', second_name: 'Saka', web_name: 'Saka', team_id: 1, position: 'MID', status: 'a', start_price_pence: 1000 },
          { id: 101, first_name: 'David', second_name: 'Raya', web_name: 'Raya', team_id: 1, position: 'GKP', status: 'a', start_price_pence: 550 },
          { id: 200, first_name: 'Cole', second_name: 'Palmer', web_name: 'Palmer', team_id: 2, position: 'MID', status: 'a', start_price_pence: 1050 },
          { id: 300, first_name: 'Mohamed', second_name: 'Salah', web_name: 'Salah', team_id: 3, position: 'MID', status: 'a', start_price_pence: 1400 },
        ],
      };
    },
    async getFixtures() {
      return fixtures;
    },
    async getFixturePlayerStats() {
      return stats;
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
    expect((await portfolio(db, alice)).cash_pence).toBe(10_000);
    expect(m.next_fixtures[1]).toMatchObject({ opponent: 2, home: true });
    expect(m.locked_teams).toEqual([]);
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

    // Settled: trading reopens and a re-run doesn't move prices twice.
    expect((await listPlayers(db)).locked_teams).toEqual([]);
    expect((await runSync(db, provider)).settled).toEqual([]);
    const sale = await sell(db, alice, 100, null);
    expect(sale.gross_pence).toBe(Math.floor((5_000_000 * 1201) / 1_000_000));

    const board = await leaderboard(db, 'season');
    expect(board[0].user_id).toBe(alice);
    expect(board.map((r) => r.rank)).toEqual([1, 2]);
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

  it('resets everyone to £100 for a new season and keeps an all-time table', async () => {
    await buy(db, alice, 100, 5000);
    await db.prepare('UPDATE players SET price_pence = 2000 WHERE id = 100').run(); // Saka doubles
    await portfolio(db, bob);

    provider.season = '2027/28';
    await runSync(db, provider);

    expect((await portfolio(db, alice)).total_pence).toBe(10_000);
    const prices = Object.fromEntries((await listPlayers(db)).players.map((p) => [p.id, p.price_pence]));
    expect(prices[100]).toBe(1000);
    const allTime = await leaderboard(db, 'alltime');
    expect(allTime.find((r) => r.user_id === alice)?.total_pence).toBe(5000); // £50 profit last season
    expect(allTime.find((r) => r.user_id === bob)?.total_pence).toBe(0);
  });
});
