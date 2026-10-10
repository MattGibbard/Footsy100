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

// Teams whose players can't be traded: kickoff within 2 hours, or the match is
// under way / awaiting final stats.
export async function lockedTeams(db: D1Database, now = new Date()): Promise<Map<number, string>> {
  const rows = await db
    .prepare(
      `SELECT team_h, team_a, kickoff_time FROM fixtures
       WHERE settled_at IS NULL AND kickoff_time IS NOT NULL AND kickoff_time <= ? AND kickoff_time > ?`,
    )
    .bind(isoSecond(new Date(now.getTime() + LOCK_BEFORE_KICKOFF_MS)), isoSecond(new Date(now.getTime() - STALE_FIXTURE_MS)))
    .all<{ team_h: number; team_a: number; kickoff_time: string }>();
  const out = new Map<number, string>();
  for (const r of rows.results) {
    out.set(r.team_h, r.kickoff_time);
    out.set(r.team_a, r.kickoff_time);
  }
  return out;
}

export async function listPlayers(db: D1Database) {
  const [players, teams, upcoming, locked] = await Promise.all([
    db
      .prepare(
        `SELECT id, web_name, first_name, second_name, team_id, position, status, price_pence, prev_price_pence
         FROM players ORDER BY price_pence DESC`,
      )
      .all(),
    db.prepare('SELECT id, name, short_name FROM teams ORDER BY name').all(),
    db
      .prepare(
        `SELECT id, team_h, team_a, kickoff_time FROM fixtures
         WHERE settled_at IS NULL AND kickoff_time IS NOT NULL AND kickoff_time > ? ORDER BY kickoff_time`,
      )
      .bind(isoSecond(new Date(Date.now() - STALE_FIXTURE_MS)))
      .all<{ id: number; team_h: number; team_a: number; kickoff_time: string }>(),
    lockedTeams(db),
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
    lock_hours: LOCK_BEFORE_KICKOFF_MS / 3_600_000,
  };
}

export async function getPlayer(db: D1Database, id: number, userId: number | null) {
  const player = await db
    .prepare(
      `SELECT p.*, t.name AS team_name, t.short_name AS team_short FROM players p JOIN teams t ON t.id = p.team_id WHERE p.id = ?`,
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
        `SELECT id, event, team_h, team_a, kickoff_time, started FROM fixtures
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
    locked_kickoff: locked.get(player.team_id) ?? null,
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
        `SELECT id, event, team_h, team_a, kickoff_time, started, finished, team_h_score, team_a_score FROM fixtures
         ORDER BY kickoff_time IS NULL, kickoff_time, id`,
      )
      .all<{ event: number | null; finished: number }>(),
    db.prepare('SELECT id, name, short_name FROM teams ORDER BY name').all(),
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
  const [account, holdings] = await Promise.all([
    db.prepare('SELECT cash_pence FROM accounts WHERE user_id = ? AND season_id = ?').bind(userId, seasonId).first<number>('cash_pence'),
    db
      .prepare(
        `SELECT h.player_id, h.shares_micro, h.cost_pence, p.web_name, p.position, p.price_pence, p.prev_price_pence,
           p.team_id, t.short_name AS team_short
         FROM holdings h JOIN players p ON p.id = h.player_id JOIN teams t ON t.id = p.team_id
         WHERE h.user_id = ? AND h.season_id = ? AND h.shares_micro > 0
         ORDER BY h.shares_micro * p.price_pence DESC`,
      )
      .bind(userId, seasonId)
      .all<{ shares_micro: number; price_pence: number }>(),
  ]);
  const rows = holdings.results.map((h) => ({ ...h, value_pence: valueOf(h.shares_micro, h.price_pence) }));
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

