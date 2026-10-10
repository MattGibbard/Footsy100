// Scheduled job: pull teams, players and fixtures from the data provider and
// settle prices for any match that has finished since the last run.

import type { DataProvider, ProviderFixture } from './fpl';
import { applyChange, scoreMatch, type Position } from './pricing';

const PLAYER_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface SyncResult {
  season: string;
  playersSynced: boolean;
  fixtures: number;
  settled: number[];
}

export async function runSync(db: D1Database, provider: DataProvider, now = new Date()): Promise<SyncResult> {
  const season = await provider.getSeasonName();
  await ensureSeason(db, season);

  const last = await db.prepare(`SELECT value FROM sync_state WHERE key = 'players_synced_at'`).first<string>('value');
  const playerCount = (await db.prepare('SELECT COUNT(*) AS n FROM players').first<number>('n')) ?? 0;
  const playersDue = !last || playerCount === 0 || now.getTime() - Date.parse(last) > PLAYER_SYNC_INTERVAL_MS;
  if (playersDue) await syncTeamsAndPlayers(db, provider, now);

  const fixtures = await provider.getFixtures();
  await syncFixtures(db, fixtures);

  const due = await db
    .prepare(`SELECT id FROM fixtures WHERE finished = 1 AND settled_at IS NULL ORDER BY kickoff_time`)
    .all<{ id: number }>();
  const settled: number[] = [];
  for (const { id } of due.results) {
    const f = fixtures.find((x) => x.id === id);
    if (!f) continue;
    await settleFixture(db, provider, f, now);
    settled.push(id);
  }

  return { season, playersSynced: playersDue, fixtures: fixtures.length, settled };
}

// A new season name (e.g. 2027/28 appearing in the fixture list) deactivates the
// old season, so everyone starts again with fresh £100 accounts.
export async function ensureSeason(db: D1Database, name: string): Promise<number> {
  const existing = await db.prepare('SELECT id, active FROM seasons WHERE name = ?').bind(name).first<{ id: number; active: number }>();
  if (existing?.active) return existing.id;
  if (existing) {
    await db.batch([
      db.prepare('UPDATE seasons SET active = 0'),
      db.prepare('UPDATE seasons SET active = 1 WHERE id = ?').bind(existing.id),
    ]);
    return existing.id;
  }
  const res = await db.batch([
    // Freeze the outgoing season's final values for the all-time table before prices reset.
    db.prepare(
      `INSERT OR REPLACE INTO season_results (user_id, season_id, final_value_pence)
       SELECT a.user_id, a.season_id, a.cash_pence + COALESCE(
         (SELECT SUM(h.shares_micro * p.price_pence / 1000000) FROM holdings h JOIN players p ON p.id = h.player_id
          WHERE h.user_id = a.user_id AND h.season_id = a.season_id), 0)
       FROM accounts a JOIN seasons s ON s.id = a.season_id WHERE s.active = 1`,
    ),
    db.prepare('UPDATE seasons SET active = 0'),
    db.prepare('INSERT INTO seasons (name, active) VALUES (?, 1) RETURNING id').bind(name),
  ]);
  const newSeason = (res[2].results as { id: number }[])[0].id;
  // New season: players go back to their provider starting price.
  await db.prepare(`DELETE FROM sync_state WHERE key = 'players_synced_at'`).run();
  await db.prepare(`INSERT OR REPLACE INTO sync_state (key, value) VALUES ('reset_prices', '1')`).run();
  return newSeason;
}

async function syncTeamsAndPlayers(db: D1Database, provider: DataProvider, now: Date) {
  const { teams, players } = await provider.getTeamsAndPlayers();
  const resetPrices = (await db.prepare(`SELECT value FROM sync_state WHERE key = 'reset_prices'`).first<string>('value')) === '1';

  // Bulk writes go through json_each so a whole squad list is one D1 query
  // (the free plan allows 50 queries per invocation).
  await db.batch([
    db
      .prepare(
        `INSERT INTO teams (id, name, short_name)
         SELECT j.value ->> 'id', j.value ->> 'name', j.value ->> 'short_name' FROM json_each(?) j WHERE true
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, short_name = excluded.short_name`,
      )
      .bind(JSON.stringify(teams)),
    // New players get the provider's price; existing players keep the market price
    // unless a new season has started.
    db
      .prepare(
        `INSERT INTO players (id, first_name, second_name, web_name, team_id, position, status, price_pence)
         SELECT j.value ->> 'id', j.value ->> 'first_name', j.value ->> 'second_name', j.value ->> 'web_name',
           j.value ->> 'team_id', j.value ->> 'position', j.value ->> 'status', j.value ->> 'start_price_pence'
         FROM json_each(?) j WHERE true
         ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, second_name = excluded.second_name,
           web_name = excluded.web_name, team_id = excluded.team_id, position = excluded.position,
           status = excluded.status
           ${resetPrices ? ', price_pence = excluded.price_pence, prev_price_pence = NULL' : ''}`,
      )
      .bind(JSON.stringify(players)),
    db.prepare(`INSERT OR REPLACE INTO sync_state (key, value) VALUES ('players_synced_at', ?)`).bind(now.toISOString()),
    db.prepare(`DELETE FROM sync_state WHERE key = 'reset_prices'`),
  ]);
}

async function syncFixtures(db: D1Database, fixtures: ProviderFixture[]) {
  const rows = fixtures.map((f) => ({ ...f, started: f.started ? 1 : 0, finished: f.finished ? 1 : 0 }));
  await db
    .prepare(
      `INSERT INTO fixtures (id, event, team_h, team_a, kickoff_time, started, finished, team_h_score, team_a_score)
       SELECT j.value ->> 'id', j.value ->> 'event', j.value ->> 'team_h', j.value ->> 'team_a', j.value ->> 'kickoff_time',
         j.value ->> 'started', j.value ->> 'finished', j.value ->> 'team_h_score', j.value ->> 'team_a_score'
       FROM json_each(?) j WHERE true
       ON CONFLICT(id) DO UPDATE SET event = excluded.event, team_h = excluded.team_h, team_a = excluded.team_a,
         kickoff_time = excluded.kickoff_time, started = excluded.started, finished = excluded.finished,
         team_h_score = excluded.team_h_score, team_a_score = excluded.team_a_score`,
    )
    .bind(JSON.stringify(rows))
    .run();
}

export async function settleFixture(db: D1Database, provider: DataProvider, f: ProviderFixture, now: Date) {
  const stats = await provider.getFixturePlayerStats(f);
  const players = await db
    .prepare('SELECT id, position, price_pence FROM players WHERE team_id IN (?, ?)')
    .bind(f.team_h, f.team_a)
    .all<{ id: number; position: Position; price_pence: number }>();

  // Net buying (buys minus sells) since each player's last price move drives the demand nudge.
  const flows = await db
    .prepare(
      `SELECT t.player_id, SUM(CASE t.side WHEN 'buy' THEN t.gross_pence ELSE -t.gross_pence END) AS net
       FROM trades t JOIN players p ON p.id = t.player_id
       WHERE p.team_id IN (?, ?)
         AND t.created_at > COALESCE((SELECT MAX(created_at) FROM price_history ph WHERE ph.player_id = t.player_id), '')
       GROUP BY t.player_id`,
    )
    .bind(f.team_h, f.team_a)
    .all<{ player_id: number; net: number }>();
  const flowBy = new Map(flows.results.map((r) => [r.player_id, r.net]));

  const ts = now.toISOString().replace('T', ' ').slice(0, 19);
  const moves = [];
  const lines = [];
  for (const p of players.results) {
    const s = stats.get(p.id) ?? null;
    const { changeBp, breakdown } = scoreMatch(p.position, s, flowBy.get(p.id) ?? 0);
    const price = applyChange(p.price_pence, changeBp);
    moves.push({ id: p.id, old: p.price_pence, price, reason: JSON.stringify(breakdown) });
    if (s) lines.push({ player_id: p.id, ...s, change_bp: changeBp });
  }

  const movesJson = JSON.stringify(moves);
  // One atomic batch, and the fixture is marked settled in it, so prices never move twice.
  await db.batch([
    db
      .prepare(
        `UPDATE players SET prev_price_pence = price_pence,
           price_pence = (SELECT j.value ->> 'price' FROM json_each(?1) j WHERE j.value ->> 'id' = players.id),
           updated_at = ?2
         WHERE id IN (SELECT j.value ->> 'id' FROM json_each(?1) j)`,
      )
      .bind(movesJson, ts),
    db
      .prepare(
        `INSERT INTO price_history (player_id, fixture_id, old_price_pence, new_price_pence, reason, created_at)
         SELECT j.value ->> 'id', ?2, j.value ->> 'old', j.value ->> 'price', j.value ->> 'reason', ?3 FROM json_each(?1) j`,
      )
      .bind(movesJson, f.id, ts),
    db
      .prepare(
        `INSERT OR REPLACE INTO player_match_stats (fixture_id, player_id, minutes, goals, assists, clean_sheet,
           goals_conceded, own_goals, penalties_saved, penalties_missed, yellow_cards, red_cards, saves, bonus, bps,
           defensive_contribution, change_bp)
         SELECT ?2, v ->> 'player_id', v ->> 'minutes', v ->> 'goals', v ->> 'assists', v ->> 'clean_sheet',
           v ->> 'goals_conceded', v ->> 'own_goals', v ->> 'penalties_saved', v ->> 'penalties_missed',
           v ->> 'yellow_cards', v ->> 'red_cards', v ->> 'saves', v ->> 'bonus', v ->> 'bps',
           v ->> 'defensive_contribution', v ->> 'change_bp'
         FROM (SELECT j.value AS v FROM json_each(?1) j)`,
      )
      .bind(JSON.stringify(lines), f.id),
    db.prepare('UPDATE fixtures SET settled_at = ? WHERE id = ? AND settled_at IS NULL').bind(ts, f.id),
  ]);
}
