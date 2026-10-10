// Weekly packs: once a gameweek, pay a flat price for one random card. Most
// packs hold a Bronze, some a Silver, a few a Gold. The price is about what the
// average pull is worth, so packs are a gamble on a Gold rather than free money.

import { HttpError } from './auth';
import { activeSeasonId, ensureAccount, lockedTeams } from './market';

export const PACK_PRICE_PENCE = 450;

// Matches the card bands on the site: gold from £7, silver from £5, bronze below.
export const PACK_ODDS = [
  { band: 'gold', percent: 3, min: 700, max: null },
  { band: 'silver', percent: 17, min: 500, max: 699 },
  { band: 'bronze', percent: 80, min: 0, max: 499 },
] as const;
export type Band = (typeof PACK_ODDS)[number]['band'];

// Packs belong to the gameweek with matches still to settle.
async function currentEvent(db: D1Database): Promise<number | null> {
  return db.prepare('SELECT MIN(event) AS e FROM fixtures WHERE settled_at IS NULL AND event IS NOT NULL').first<number | null>('e');
}

// roll is 0-99; pass one in tests.
export function rollBand(roll = randomInt(100)): Band {
  let acc = 0;
  for (const o of PACK_ODDS) if (roll < (acc += o.percent)) return o.band;
  return 'bronze';
}

function randomInt(n: number) {
  return crypto.getRandomValues(new Uint32Array(1))[0] % n;
}

export async function packStatus(db: D1Database, userId: number) {
  const seasonId = await activeSeasonId(db);
  const event = await currentEvent(db);
  const opened = event
    ? await db
        .prepare(
          `SELECT k.player_id, k.band, k.card_price_pence, k.created_at, p.web_name FROM packs k JOIN players p ON p.id = k.player_id
           WHERE k.user_id = ? AND k.season_id = ? AND k.event = ?`,
        )
        .bind(userId, seasonId, event)
        .first()
    : null;
  return { event, price_pence: PACK_PRICE_PENCE, odds: PACK_ODDS.map(({ band, percent }) => ({ band, percent })), opened };
}

export async function openPack(db: D1Database, userId: number, roll?: number) {
  const seasonId = await activeSeasonId(db);
  await ensureAccount(db, userId, seasonId);
  const event = await currentEvent(db);
  if (!event) throw new HttpError(409, 'There are no packs until the next gameweek is scheduled.');

  // Only players who can be traded right now and are fit, preferring ones who
  // have played this season, so a pack never hands out a card frozen mid-match.
  const locked = [...(await lockedTeams(db)).keys()];
  let band = rollBand(roll);
  let player: { id: number; price_pence: number } | null = null;
  for (const b of [band, 'bronze' as const]) {
    const o = PACK_ODDS.find((x) => x.band === b)!;
    player = await db
      .prepare(
        `SELECT id, price_pence FROM players p
         WHERE status = 'a' AND price_pence >= ?1 AND (?2 IS NULL OR price_pence <= ?2)
           AND team_id NOT IN (SELECT value FROM json_each(?3))
         ORDER BY EXISTS (SELECT 1 FROM player_match_stats s WHERE s.player_id = p.id AND s.minutes > 0) DESC, RANDOM()
         LIMIT 1`,
      )
      .bind(o.min, o.max, JSON.stringify(locked))
      .first<{ id: number; price_pence: number }>();
    if (player) {
      band = b;
      break;
    }
  }
  if (!player) throw new HttpError(409, 'No cards are available right now. Try again once matches settle.');

  try {
    // One transaction: the packs key stops a second pack this gameweek and the
    // cash CHECK stops an overspend. It isn't a trade, so it doesn't nudge the price.
    await db.batch([
      db
        .prepare(
          `INSERT INTO packs (user_id, season_id, event, player_id, band, price_pence, card_price_pence) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(userId, seasonId, event, player.id, band, PACK_PRICE_PENCE, player.price_pence),
      db.prepare('UPDATE accounts SET cash_pence = cash_pence - ? WHERE user_id = ? AND season_id = ?').bind(PACK_PRICE_PENCE, userId, seasonId),
      db
        .prepare(
          `INSERT INTO holdings (user_id, season_id, player_id, cards, cost_pence) VALUES (?, ?, ?, 1, ?)
           ON CONFLICT(user_id, season_id, player_id) DO UPDATE SET cards = cards + 1, cost_pence = cost_pence + excluded.cost_pence`,
        )
        .bind(userId, seasonId, player.id, PACK_PRICE_PENCE),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('PRIMARY')) throw new HttpError(409, "You've already opened this gameweek's pack.");
    if (String(e).includes('CHECK')) throw new HttpError(400, `Not enough cash. A pack costs £${(PACK_PRICE_PENCE / 100).toFixed(2)}.`);
    throw e;
  }
  return { event, band, player_id: player.id, card_price_pence: player.price_pence, price_pence: PACK_PRICE_PENCE };
}
