// Leaderboards (global and private leagues).

import { HttpError } from './auth';
import { activeSeasonId, ensureAccount } from './market';
import { STARTING_CASH_PENCE } from './money';

// Current season value per user: cash plus holdings at today's prices.
const SEASON_VALUES = `
  SELECT a.user_id, a.cash_pence + COALESCE((
    SELECT SUM(h.shares_micro * p.price_pence / 1000000) FROM holdings h JOIN players p ON p.id = h.player_id
    WHERE h.user_id = a.user_id AND h.season_id = a.season_id), 0) AS total_pence
  FROM accounts a WHERE a.season_id = (SELECT id FROM seasons WHERE active = 1)`;

// All-time profit: frozen results of past seasons plus the current season, each measured against £100.
const ALLTIME_VALUES = `
  SELECT user_id, SUM(total_pence - ${STARTING_CASH_PENCE}) AS total_pence FROM (
    SELECT user_id, final_value_pence AS total_pence FROM season_results
    UNION ALL ${SEASON_VALUES}
  ) GROUP BY user_id`;

export type Scope = 'season' | 'alltime';

export async function leaderboard(db: D1Database, scope: Scope, leagueId?: number) {
  const values = scope === 'alltime' ? ALLTIME_VALUES : SEASON_VALUES;
  const filter = leagueId ? 'WHERE v.user_id IN (SELECT user_id FROM league_members WHERE league_id = ?)' : '';
  const stmt = db.prepare(
    `SELECT u.id AS user_id, u.display_name, v.total_pence FROM (${values}) v JOIN users u ON u.id = v.user_id
     ${filter} ORDER BY v.total_pence DESC, u.id LIMIT 200`,
  );
  const rows = (await (leagueId ? stmt.bind(leagueId) : stmt).all<{ user_id: number; display_name: string; total_pence: number }>()).results;
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function leagueCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
}

const MAX_LEAGUES_PER_USER = 20;

async function leagueCount(db: D1Database, userId: number) {
  return (await db.prepare('SELECT COUNT(*) AS n FROM league_members WHERE user_id = ?').bind(userId).first<number>('n')) ?? 0;
}

export async function createLeague(db: D1Database, userId: number, rawName: unknown) {
  const name = typeof rawName === 'string' ? rawName.trim().slice(0, 40) : '';
  if (!name) throw new HttpError(400, 'Give your league a name');
  if ((await leagueCount(db, userId)) >= MAX_LEAGUES_PER_USER) throw new HttpError(400, `You can be in at most ${MAX_LEAGUES_PER_USER} leagues`);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = leagueCode();
    try {
      const league = await db
        .prepare('INSERT INTO leagues (name, code, owner_id) VALUES (?, ?, ?) RETURNING id, name, code')
        .bind(name, code, userId)
        .first<{ id: number; name: string; code: string }>();
      await db.prepare('INSERT INTO league_members (league_id, user_id) VALUES (?, ?)').bind(league!.id, userId).run();
      await ensureAccount(db, userId, await activeSeasonId(db));
      return league;
    } catch (e) {
      if (!String(e).includes('UNIQUE')) throw e;
    }
  }
  throw new HttpError(500, 'Could not create a league code, please try again');
}

export async function joinLeague(db: D1Database, userId: number, rawCode: unknown) {
  const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
  const league = await db.prepare('SELECT id, name, code FROM leagues WHERE code = ?').bind(code).first<{ id: number }>();
  if (!league) throw new HttpError(404, 'No league with that code');
  if ((await leagueCount(db, userId)) >= MAX_LEAGUES_PER_USER) throw new HttpError(400, `You can be in at most ${MAX_LEAGUES_PER_USER} leagues`);
  await db.prepare('INSERT OR IGNORE INTO league_members (league_id, user_id) VALUES (?, ?)').bind(league.id, userId).run();
  // Members show on the table from day one, even before their first trade.
  await ensureAccount(db, userId, await activeSeasonId(db));
  return league;
}

export async function leaveLeague(db: D1Database, userId: number, leagueId: number) {
  await db.prepare('DELETE FROM league_members WHERE league_id = ? AND user_id = ?').bind(leagueId, userId).run();
  // Last one out turns off the lights.
  await db.prepare('DELETE FROM leagues WHERE id = ? AND NOT EXISTS (SELECT 1 FROM league_members WHERE league_id = ?)').bind(leagueId, leagueId).run();
}

export async function myLeagues(db: D1Database, userId: number) {
  return (
    await db
      .prepare(
        `SELECT l.id, l.name, l.code, l.owner_id, (SELECT COUNT(*) FROM league_members m2 WHERE m2.league_id = l.id) AS members
         FROM leagues l JOIN league_members m ON m.league_id = l.id WHERE m.user_id = ? ORDER BY l.name`,
      )
      .bind(userId)
      .all()
  ).results;
}

export async function leagueDetail(db: D1Database, userId: number, leagueId: number, scope: Scope) {
  const league = await db
    .prepare(
      `SELECT l.id, l.name, l.code, l.owner_id FROM leagues l JOIN league_members m ON m.league_id = l.id
       WHERE l.id = ? AND m.user_id = ?`,
    )
    .bind(leagueId, userId)
    .first();
  if (!league) throw new HttpError(404, 'League not found');
  return { league, standings: await leaderboard(db, scope, leagueId) };
}

