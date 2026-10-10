// Reads and trades against the market for the active season.

import { HttpError } from './auth';
import { MIN_TRADE_PENCE, STARTING_CASH_PENCE, saleProceeds, sharesForAmount, valueOf } from './money';

export const LOCK_BEFORE_KICKOFF_MS = 2 * 60 * 60 * 1000;
// A match that never gets marked finished (abandoned, data gap) stops locking after this.
const STALE_FIXTURE_MS = 3 * 24 * 60 * 60 * 1000;

const isoSecond = (d: Date) => d.toISOString().slice(0, 19) + 'Z';

export async function activeSeasonId(db: D1Database): Promise<number> {
  const id = await db.prepare('SELECT id FROM seasons WHERE active = 1').first<number>('id');
  if (!id) throw new HttpError(409, 'The season has not started yet. Check back soon.');
  return id;
}

export async function ensureAccount(db: D1Database, userId: number, seasonId: number) {
  await db
    .prepare('INSERT OR IGNORE INTO accounts (user_id, season_id, cash_pence) VALUES (?, ?, ?)')
    .bind(userId, seasonId, STARTING_CASH_PENCE)
    .run();
}

// Why a team's players can't be traded right now.
export type MatchState = 'locked' | 'live' | 'awaiting';
export interface TeamLock {
  kickoff_time: string;
  state: MatchState;
}
// If a team somehow has two unsettled matches in the window, show the most pressing.
const STATE_RANK: Record<MatchState, number> = { live: 3, awaiting: 2, locked: 1 };

// Teams whose players can't be traded: kickoff within 2 hours (locked), the match
// is under way (live), or it's over and prices are waiting to settle (awaiting).
export async function lockedTeams(db: D1Database, now = new Date()): Promise<Map<number, TeamLock>> {
  const rows = await db
    .prepare(
      `SELECT team_h, team_a, kickoff_time,
         CASE WHEN finished = 1 OR finished_provisional = 1 THEN 'awaiting'
              WHEN started = 1 OR kickoff_time <= ?3 THEN 'live'
              ELSE 'locked' END AS state
       FROM fixtures
       WHERE settled_at IS NULL AND kickoff_time IS NOT NULL AND kickoff_time <= ?1 AND kickoff_time > ?2`,
    )
    .bind(
      isoSecond(new Date(now.getTime() + LOCK_BEFORE_KICKOFF_MS)),
      isoSecond(new Date(now.getTime() - STALE_FIXTURE_MS)),
      isoSecond(now),
    )
    .all<{ team_h: number; team_a: number; kickoff_time: string; state: MatchState }>();
  const out = new Map<number, TeamLock>();
  for (const r of rows.results) {
    for (const team of [r.team_h, r.team_a]) {
      const cur = out.get(team);
      if (!cur || STATE_RANK[r.state] > STATE_RANK[cur.state]) out.set(team, { kickoff_time: r.kickoff_time, state: r.state });
    }
  }
  return out;
}

// team id -> match state, for the browser to badge players.
const teamStates = (locked: Map<number, TeamLock>) => Object.fromEntries([...locked].map(([t, l]) => [t, l.state]));

export const MOVERS_WINDOW_DAYS = 7;
const MOVERS_LIMIT = 10;

// Biggest % risers and fallers over the last week: each player's current price
// against the price before his first move in the window. Done in SQL to keep CPU low.
export async function topMovers(db: D1Database, now = new Date()) {
  const since = new Date(now.getTime() - MOVERS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const rows = await db
    .prepare(
      `WITH firsts AS (
         SELECT player_id, old_price_pence,
           ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY created_at, id) AS rn
         FROM price_history WHERE created_at >= ?1
       ), moves AS (
         SELECT p.id AS player_id, f.old_price_pence AS from_pence, p.price_pence AS to_pence,
           (p.price_pence - f.old_price_pence) * 1.0 / f.old_price_pence AS change
         FROM firsts f JOIN players p ON p.id = f.player_id
         WHERE f.rn = 1 AND f.old_price_pence > 0
       )
       SELECT 'up' AS dir, * FROM (SELECT * FROM moves WHERE change > 0 ORDER BY change DESC, player_id LIMIT ?2)
       UNION ALL
       SELECT 'down' AS dir, * FROM (SELECT * FROM moves WHERE change < 0 ORDER BY change ASC, player_id LIMIT ?2)`,
    )
    .bind(since, MOVERS_LIMIT)
    .all<{ dir: 'up' | 'down'; player_id: number; from_pence: number; to_pence: number }>();
  const pick = (dir: string) => rows.results.filter((r) => r.dir === dir).map(({ dir: _, ...r }) => r);
  return { days: MOVERS_WINDOW_DAYS, risers: pick('up'), fallers: pick('down') };
}

export async function listPlayers(db: D1Database) {
  const [players, teams, upcoming, locked, movers] = await Promise.all([
    db
      .prepare(
        `SELECT id, code, web_name, first_name, second_name, team_id, position, status, price_pence, prev_price_pence
         FROM players ORDER BY price_pence DESC`,
      )
      .all(),
    db.prepare('SELECT id, name, short_name, code FROM teams ORDER BY name').all(),
    db
      .prepare(
        `SELECT id, team_h, team_a, kickoff_time FROM fixtures
         WHERE settled_at IS NULL AND kickoff_time IS NOT NULL AND kickoff_time > ? ORDER BY kickoff_time`,
      )
      .bind(isoSecond(new Date(Date.now() - STALE_FIXTURE_MS)))
      .all<{ id: number; team_h: number; team_a: number; kickoff_time: string }>(),
    lockedTeams(db),
    topMovers(db),
  ]);
  const next: Record<number, { fixture_id: number; opponent: number; home: boolean; kickoff_time: string }> = {};
  for (const f of upcoming.results) {
    next[f.team_h] ??= { fixture_id: f.id, opponent: f.team_a, home: true, kickoff_time: f.kickoff_time };
    next[f.team_a] ??= { fixture_id: f.id, opponent: f.team_h, home: false, kickoff_time: f.kickoff_time };
  }
  return {
    players: players.results,
    teams: teams.results,
    next_fixtures: next,
    locked_teams: [...locked.keys()],
    team_states: teamStates(locked),
    lock_hours: LOCK_BEFORE_KICKOFF_MS / 3_600_000,
    movers,
  };
}

export async function getPlayer(db: D1Database, id: number, userId: number | null) {
  const player = await db
    .prepare(
      `SELECT p.*, t.name AS team_name, t.short_name AS team_short, t.code AS team_code FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = ?`,
    )
    .bind(id)
    .first<{ team_id: number }>();
  if (!player) throw new HttpError(404, 'Player not found');
  const [history, matches, upcoming, locked] = await Promise.all([
    db
      .prepare(
        `SELECT fixture_id, old_price_pence, new_price_pence, reason, created_at FROM price_history
         WHERE player_id = ? ORDER BY created_at DESC LIMIT 60`,
      )
      .bind(id)
      .all(),
    db
      .prepare(
        `SELECT s.*, f.kickoff_time, f.team_h, f.team_a, f.team_h_score, f.team_a_score
         FROM player_match_stats s JOIN fixtures f ON f.id = s.fixture_id
         WHERE s.player_id = ? ORDER BY f.kickoff_time DESC LIMIT 40`,
      )
      .bind(id)
      .all(),
    db
      .prepare(
        `SELECT id, event, team_h, team_a, kickoff_time, started, finished_provisional FROM fixtures
         WHERE (team_h = ? OR team_a = ?) AND finished = 0 AND (kickoff_time IS NULL OR kickoff_time > ?)
         ORDER BY kickoff_time IS NULL, kickoff_time, id LIMIT 6`,
      )
      .bind(player.team_id, player.team_id, isoSecond(new Date(Date.now() - STALE_FIXTURE_MS)))
      .all(),
    lockedTeams(db),
  ]);
  let holding = null;
  if (userId) {
    const seasonId = await db.prepare('SELECT id FROM seasons WHERE active = 1').first<number>('id');
    if (seasonId) {
      holding = await db
        .prepare('SELECT shares_micro, cost_pence FROM holdings WHERE user_id = ? AND season_id = ? AND player_id = ? AND shares_micro > 0')
        .bind(userId, seasonId, id)
        .first();
    }
  }
  return {
    player,
    locked: locked.has(player.team_id),
    locked_kickoff: locked.get(player.team_id)?.kickoff_time ?? null,
    match_state: locked.get(player.team_id)?.state ?? null,
    history: history.results,
    matches: matches.results,
    upcoming: upcoming.results,
    holding,
  };
}

// Every fixture of the season, for the fixtures page (380 rows, so the browser does the grouping).
export async function listFixtures(db: D1Database) {
  const [fixtures, teams, locked] = await Promise.all([
    db
      .prepare(
        `SELECT id, event, team_h, team_a, kickoff_time, started, finished, finished_provisional, team_h_score, team_a_score FROM fixtures
         ORDER BY kickoff_time IS NULL, kickoff_time, id`,
      )
      .all<{ event: number | null; finished: number }>(),
    db.prepare('SELECT id, name, short_name, code FROM teams ORDER BY name').all(),
    lockedTeams(db),
  ]);
  // The gameweek to open on: the earliest one with a match still to finish.
  const current = fixtures.results.find((f) => !f.finished && f.event != null)?.event ?? null;
  return {
    fixtures: fixtures.results,
    teams: teams.results,
    current_event: current,
    locked_teams: [...locked.keys()],
    lock_hours: LOCK_BEFORE_KICKOFF_MS / 3_600_000,
  };
}

export async function portfolio(db: D1Database, userId: number) {
  const seasonId = await activeSeasonId(db);
  await ensureAccount(db, userId, seasonId);
  const [account, holdings, locked] = await Promise.all([
    db.prepare('SELECT cash_pence FROM accounts WHERE user_id = ? AND season_id = ?').bind(userId, seasonId).first<number>('cash_pence'),
    db
      .prepare(
        `SELECT h.player_id, h.shares_micro, h.cost_pence, p.web_name, p.position, p.price_pence, p.prev_price_pence,
           p.team_id, p.code, t.short_name AS team_short, t.code AS team_code
         FROM holdings h JOIN players p ON p.id = h.player_id JOIN teams t ON t.id = p.team_id
         WHERE h.user_id = ? AND h.season_id = ? AND h.shares_micro > 0
         ORDER BY h.shares_micro * p.price_pence DESC`,
      )
      .bind(userId, seasonId)
      .all<{ shares_micro: number; price_pence: number; team_id: number }>(),
    lockedTeams(db),
  ]);
  const rows = holdings.results.map((h) => ({
    ...h,
    value_pence: valueOf(h.shares_micro, h.price_pence),
    match_state: locked.get(h.team_id)?.state ?? null,
  }));
  const invested = rows.reduce((a, h) => a + h.value_pence, 0);
  return { cash_pence: account ?? 0, holdings_value_pence: invested, total_pence: (account ?? 0) + invested, holdings: rows };
}

export async function recentTrades(db: D1Database, userId: number) {
  const seasonId = await activeSeasonId(db);
  return (
    await db
      .prepare(
        `SELECT t.id, t.player_id, p.web_name, t.side, t.shares_micro, t.price_pence, t.gross_pence, t.fee_pence, t.created_at
         FROM trades t JOIN players p ON p.id = t.player_id
         WHERE t.user_id = ? AND t.season_id = ? ORDER BY t.id DESC LIMIT 100`,
      )
      .bind(userId, seasonId)
      .all()
  ).results;
}

async function tradablePlayer(db: D1Database, playerId: number) {
  const player = await db.prepare('SELECT id, team_id, price_pence FROM players WHERE id = ?').bind(playerId).first<{
    id: number;
    team_id: number;
    price_pence: number;
  }>();
  if (!player) throw new HttpError(404, 'Player not found');
  if ((await lockedTeams(db)).has(player.team_id)) {
    throw new HttpError(409, 'Trading on this player is locked until his match has been played and settled.');
  }
  return player;
}

export async function buy(db: D1Database, userId: number, playerId: number, amountPence: number) {
  if (!Number.isInteger(amountPence) || amountPence < MIN_TRADE_PENCE) throw new HttpError(400, 'Minimum purchase is 10p');
  const seasonId = await activeSeasonId(db);
  await ensureAccount(db, userId, seasonId);
  const player = await tradablePlayer(db, playerId);
  const shares = sharesForAmount(amountPence, player.price_pence);
  if (shares <= 0) throw new HttpError(400, 'Amount too small');

  try {
    // One transaction: the cash CHECK constraint aborts everything on an overspend.
    await db.batch([
      db
        .prepare('UPDATE accounts SET cash_pence = cash_pence - ? WHERE user_id = ? AND season_id = ?')
        .bind(amountPence, userId, seasonId),
      db
        .prepare(
          `INSERT INTO holdings (user_id, season_id, player_id, shares_micro, cost_pence) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, season_id, player_id) DO UPDATE SET
             shares_micro = shares_micro + excluded.shares_micro, cost_pence = cost_pence + excluded.cost_pence`,
        )
        .bind(userId, seasonId, playerId, shares, amountPence),
      db
        .prepare(
          `INSERT INTO trades (user_id, season_id, player_id, side, shares_micro, price_pence, gross_pence, fee_pence)
           VALUES (?, ?, ?, 'buy', ?, ?, ?, 0)`,
        )
        .bind(userId, seasonId, playerId, shares, player.price_pence, amountPence),
    ]);
  } catch (e) {
    if (String(e).includes('CHECK')) throw new HttpError(400, 'Not enough cash');
    throw e;
  }
  return { side: 'buy', shares_micro: shares, price_pence: player.price_pence, gross_pence: amountPence, fee_pence: 0 };
}

// sharesMicro = null sells the whole holding.
export async function sell(db: D1Database, userId: number, playerId: number, sharesMicro: number | null) {
  const seasonId = await activeSeasonId(db);
  const player = await tradablePlayer(db, playerId);
  const holding = await db
    .prepare('SELECT shares_micro, cost_pence FROM holdings WHERE user_id = ? AND season_id = ? AND player_id = ?')
    .bind(userId, seasonId, playerId)
    .first<{ shares_micro: number; cost_pence: number }>();
  if (!holding || holding.shares_micro <= 0) throw new HttpError(400, "You don't own any shares in this player");

  const shares = sharesMicro ?? holding.shares_micro;
  if (!Number.isInteger(shares) || shares <= 0) throw new HttpError(400, 'Invalid number of shares');
  if (shares > holding.shares_micro) throw new HttpError(400, "You don't own that many shares");
  const { gross, fee, net } = saleProceeds(shares, player.price_pence);
  if (gross < 1) throw new HttpError(400, 'Amount too small');
  const costReduction = Math.round((holding.cost_pence * shares) / holding.shares_micro);

  try {
    // The holdings CHECK constraint aborts the batch if a concurrent sale got there first.
    await db.batch([
      db
        .prepare(
          `UPDATE holdings SET shares_micro = shares_micro - ?, cost_pence = MAX(0, cost_pence - ?)
           WHERE user_id = ? AND season_id = ? AND player_id = ?`,
        )
        .bind(shares, costReduction, userId, seasonId, playerId),
      db
        .prepare('UPDATE accounts SET cash_pence = cash_pence + ? WHERE user_id = ? AND season_id = ?')
        .bind(net, userId, seasonId),
      db
        .prepare(
          `INSERT INTO trades (user_id, season_id, player_id, side, shares_micro, price_pence, gross_pence, fee_pence)
           VALUES (?, ?, ?, 'sell', ?, ?, ?, ?)`,
        )
        .bind(userId, seasonId, playerId, shares, player.price_pence, gross, fee),
    ]);
  } catch (e) {
    if (String(e).includes('CHECK')) throw new HttpError(409, "You don't own that many shares");
    throw e;
  }
  return { side: 'sell', shares_micro: shares, price_pence: player.price_pence, gross_pence: gross, fee_pence: fee, net_pence: net };
}

