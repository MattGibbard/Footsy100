// Scheduled job: pull teams, players and fixtures from the data provider and
// settle prices for any match that has finished since the last run.

import { buildFixtureStats, chunkArray, sliceArray, type DataProvider, type FplFixture, type FplLive } from './fpl';
import type { MatchStats } from './pricing';
import { applyChange, scoreMatch, type Position } from './pricing';

const PLAYER_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
// A match counts as live from kick-off until FPL marks it finished (which waits
// for bonus points, so it can be an hour after the final whistle).
const LIVE_WINDOW_MS = 3 * 60 * 60 * 1000;
// FPL only marks a match finished once its data is checked, which can be hours
// after full time (often the end of the day). Its stats and bonus points are in
// well before that, so settle a provisionally finished match once it is this old.
const SETTLE_AFTER_KICKOFF_MS = 150 * 60 * 1000;
// Settling is the one step that parses JSON in the Worker, so cap it per run.
const MAX_SETTLEMENTS_PER_RUN = 2;

type Stage = (stage: string) => Promise<void>;

export interface SyncResult {
  season: string;
  playersSynced: boolean;
  fixtures: number;
  settled: number[];
}

// Runs the sync and records the outcome, so failures are visible at /api/status.
// Runs the sync and records progress as it goes, so /api/status shows where a
// run stopped even if Cloudflare kills it outright (which skips any catch).
export async function runSyncRecorded(db: D1Database, provider: DataProvider, now = new Date()): Promise<SyncResult> {
  const at = now.toISOString();
  const stage: Stage = (name) => recordSync(db, { at, ok: false, stage: name, finished: false });
  try {
    const result = await runSync(db, provider, now, stage);
    await recordSync(db, { at, ok: true, finished: true, result });
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await recordSync(db, { at, ok: false, finished: true, error }).catch(() => {});
    throw e;
  }
}

async function recordSync(db: D1Database, outcome: object) {
  await db.prepare(`INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_sync', ?)`).bind(JSON.stringify(outcome)).run();
}

export async function syncStatus(db: D1Database) {
  const [last, players, fixtures, season] = await Promise.all([
    db.prepare(`SELECT value FROM sync_state WHERE key = 'last_sync'`).first<string>('value'),
    db.prepare('SELECT COUNT(*) AS n FROM players').first<number>('n'),
    db.prepare('SELECT COUNT(*) AS n FROM fixtures').first<number>('n'),
    db.prepare('SELECT name FROM seasons WHERE active = 1').first<string>('name'),
  ]);
  return { last_sync: last ? JSON.parse(last) : null, players, fixtures, season };
}

export async function runSync(db: D1Database, provider: DataProvider, now = new Date(), stage: Stage = async () => {}): Promise<SyncResult> {
  await stage('fetching fixtures');
  const fixturesText = await provider.fixturesText();
  await stage('saving fixtures');
  const fixtures = await syncFixtures(db, fixturesText);

  const firstKickoff = await db.prepare('SELECT MIN(kickoff_time) AS k FROM fixtures').first<string>('k');
  const season = seasonName(firstKickoff, now);
  await ensureSeason(db, season);

  const last = await db.prepare(`SELECT value FROM sync_state WHERE key = 'players_synced_at'`).first<string>('value');
  const playerCount = (await db.prepare('SELECT COUNT(*) AS n FROM players').first<number>('n')) ?? 0;
  const resetPrices = (await db.prepare(`SELECT value FROM sync_state WHERE key = 'reset_prices'`).first<string>('value')) === '1';
  const playersDue = !last || playerCount === 0 || resetPrices || now.getTime() - Date.parse(last) > PLAYER_SYNC_INTERVAL_MS;
  if (playersDue) {
    await stage('fetching players');
    const bootstrap = await provider.bootstrapText();
    await stage('saving players');
    await syncTeamsAndPlayers(db, bootstrap, resetPrices, now);
  }

  // First sync of a season: prices start from the provider's current prices, so
  // matches already played are history, not price moves.
  if (playerCount === 0 || resetPrices) {
    await db
      .prepare('UPDATE fixtures SET settled_at = ? WHERE finished = 1 AND settled_at IS NULL')
      .bind(sqlTime(now))
      .run();
  }

  const due = await db
    .prepare(
      `SELECT id, event, team_h, team_a FROM fixtures
       WHERE settled_at IS NULL AND event IS NOT NULL
         AND (finished = 1 OR (finished_provisional = 1 AND kickoff_time <= ?1))
       ORDER BY kickoff_time LIMIT ?2`,
    )
    .bind(new Date(now.getTime() - SETTLE_AFTER_KICKOFF_MS).toISOString().slice(0, 19) + 'Z', MAX_SETTLEMENTS_PER_RUN)
    .all<DueFixture>();
  const settled: number[] = [];
  for (const f of due.results) {
    await stage(`settling fixture ${f.id}`);
    await settleFixture(db, provider, f, now);
    settled.push(f.id);
  }

  return { season, playersSynced: playersDue, fixtures, settled };
}

// The cron fires every minute but only does the full sync every 15 minutes. In
// between, if a match is live, it refreshes just that gameweek's scores from
// FPL's small per-gameweek fixture list. With nothing live it is one query.
export async function runLiveScores(db: D1Database, provider: DataProvider, now = new Date()): Promise<number[]> {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + 'Z';
  const live = await db
    .prepare(
      `SELECT DISTINCT event FROM fixtures
       WHERE kickoff_time BETWEEN ? AND ? AND finished = 0 AND event IS NOT NULL`,
    )
    .bind(iso(now.getTime() - LIVE_WINDOW_MS), iso(now.getTime()))
    .all<{ event: number }>();
  const events = live.results.map((r) => r.event);
  for (const event of events) await syncFixtures(db, await provider.gameweekFixturesText(event));
  return events;
}

interface DueFixture {
  id: number;
  event: number;
  team_h: number;
  team_a: number;
}

const sqlTime = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);

// Seasons run August to May and are named after the first kickoff, e.g. '2026/27'.
export function seasonName(firstKickoff: string | null, now: Date): string {
  const d = firstKickoff ? new Date(firstKickoff) : now;
  const year = d.getUTCMonth() < 6 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
  return `${year}/${String((year + 1) % 100).padStart(2, '0')}`;
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
         (SELECT SUM(h.cards * p.price_pence) FROM holdings h JOIN players p ON p.id = h.player_id
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

// Bulk writes hand the provider's JSON text straight to json_each, so the database
// does the parsing and a whole squad list is one query. That keeps the Worker
// inside the free plan's 10ms CPU and 50-queries-per-run limits.
async function syncTeamsAndPlayers(db: D1Database, bootstrap: string, resetPrices: boolean, now: Date) {
  const stmts = [
    db
      .prepare(
        `INSERT INTO teams (id, name, short_name, code)
         SELECT j.value ->> 'id', j.value ->> 'name', j.value ->> 'short_name', j.value ->> 'code' FROM json_each(?) j WHERE true
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, short_name = excluded.short_name, code = excluded.code`,
      )
      .bind(sliceArray(bootstrap, 'teams')),
  ];
  // New players get FPL's price (now_cost is in £0.1m, so 55 = £5.5m lists at £5.50);
  // existing players keep the market price unless a new season has started.
  for (const chunk of chunkArray(sliceArray(bootstrap, 'elements', true))) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO players (id, code, first_name, second_name, web_name, team_id, position, status, price_pence)
           SELECT v ->> 'id', v ->> 'code', v ->> 'first_name', v ->> 'second_name', v ->> 'web_name', v ->> 'team',
             CASE v ->> 'element_type' WHEN 1 THEN 'GKP' WHEN 2 THEN 'DEF' WHEN 3 THEN 'MID' ELSE 'FWD' END,
             v ->> 'status', (v ->> 'now_cost') * 10
           FROM (SELECT j.value AS v FROM json_each(?) j) WHERE (v ->> 'element_type') BETWEEN 1 AND 4
           ON CONFLICT(id) DO UPDATE SET code = excluded.code, first_name = excluded.first_name, second_name = excluded.second_name,
             web_name = excluded.web_name, team_id = excluded.team_id, position = excluded.position,
             status = excluded.status
             ${resetPrices ? ', price_pence = excluded.price_pence, prev_price_pence = NULL' : ''}`,
        )
        .bind(chunk),
    );
  }
  stmts.push(
    db.prepare(`INSERT OR REPLACE INTO sync_state (key, value) VALUES ('players_synced_at', ?)`).bind(now.toISOString()),
    db.prepare(`DELETE FROM sync_state WHERE key = 'reset_prices'`),
  );
  await db.batch(stmts);
}

async function syncFixtures(db: D1Database, fixturesText: string): Promise<number> {
  const chunks = chunkArray(fixturesText);
  if (!chunks.length) return 0;
  await db.batch(
    chunks.map((chunk) =>
      db
        .prepare(
          `INSERT INTO fixtures (id, event, team_h, team_a, kickoff_time, started, finished, finished_provisional, team_h_score, team_a_score)
           SELECT v ->> 'id', v ->> 'event', v ->> 'team_h', v ->> 'team_a', v ->> 'kickoff_time',
             COALESCE(v ->> 'started', 0), COALESCE(v ->> 'finished', 0),
             COALESCE(v ->> 'finished_provisional', v ->> 'finished', 0), v ->> 'team_h_score', v ->> 'team_a_score'
           FROM (SELECT j.value AS v FROM json_each(?) j) WHERE true
           ON CONFLICT(id) DO UPDATE SET event = excluded.event,
             -- A fixture id reused for a different match (new season) starts unsettled.
             settled_at = CASE WHEN excluded.team_h != fixtures.team_h OR excluded.team_a != fixtures.team_a
               OR (fixtures.finished = 1 AND excluded.finished = 0) THEN NULL ELSE fixtures.settled_at END,
             team_h = excluded.team_h, team_a = excluded.team_a,
             kickoff_time = excluded.kickoff_time, started = excluded.started, finished = excluded.finished,
             finished_provisional = excluded.finished_provisional, team_h_score = excluded.team_h_score, team_a_score = excluded.team_a_score
           -- Skip unchanged rows so the every-minute live refresh doesn't eat the free plan's daily write allowance.
           WHERE excluded.event IS NOT fixtures.event OR excluded.team_h != fixtures.team_h OR excluded.team_a != fixtures.team_a
             OR excluded.kickoff_time IS NOT fixtures.kickoff_time OR excluded.started != fixtures.started
             OR excluded.finished != fixtures.finished OR excluded.finished_provisional != fixtures.finished_provisional
             OR excluded.team_h_score IS NOT fixtures.team_h_score
             OR excluded.team_a_score IS NOT fixtures.team_a_score`,
        )
        .bind(chunk),
    ),
  );
  return (await db.prepare('SELECT COUNT(*) AS n FROM fixtures').first<number>('n')) ?? 0;
}

// One match's stat lines. The gameweek's fixture list is small enough to parse
// here; the live file covers every player, so the database picks out just the
// minutes, clean sheets and goals conceded for this fixture.
async function fixtureStats(db: D1Database, provider: DataProvider, f: DueFixture): Promise<Map<number, MatchStats>> {
  const fixture = (JSON.parse(await provider.gameweekFixturesText(f.event)) as FplFixture[]).find((x) => x.id === f.id);
  if (!fixture) throw new Error(`Fixture ${f.id} not found in gameweek ${f.event}`);
  const elements = sliceArray(await provider.liveText(f.event), 'elements', true);
  const live: FplLive = { elements: [] };
  for (const chunk of chunkArray(elements)) {
    const rows = await db
      .prepare(
        `SELECT e.value ->> 'id' AS id, s.value ->> 'identifier' AS identifier, s.value ->> 'value' AS value
         FROM json_each(?1) e, json_each(e.value, '$.explain') x, json_each(x.value, '$.stats') s
         WHERE x.value ->> 'fixture' = ?2 AND s.value ->> 'identifier' IN ('minutes', 'clean_sheets', 'goals_conceded')`,
      )
      .bind(chunk, f.id)
      .all<{ id: number; identifier: string; value: number }>();
    for (const r of rows.results) {
      live.elements.push({ id: r.id, explain: [{ fixture: f.id, stats: [{ identifier: r.identifier, value: r.value }] }] });
    }
  }
  return buildFixtureStats(fixture, live);
}

export async function settleFixture(db: D1Database, provider: DataProvider, f: DueFixture, now: Date) {
  const stats = await fixtureStats(db, provider, f);
  const players = await db
    .prepare('SELECT id, position, price_pence FROM players WHERE team_id IN (?, ?)')
    .bind(f.team_h, f.team_a)
    .all<{ id: number; position: Position; price_pence: number }>();

  // Net cards bought (buys minus sells) since each player's last price move drives the demand nudge.
  const flows = await db
    .prepare(
      `SELECT t.player_id, SUM(CASE t.side WHEN 'buy' THEN t.cards ELSE -t.cards END) AS net
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
