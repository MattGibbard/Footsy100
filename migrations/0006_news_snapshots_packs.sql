-- FPL's injury and availability news for each player, shown on cards so people
-- can see a doubt before they buy. chance_next is FPL's chance of playing in the
-- next round (0-100), NULL when FPL has no doubt about him.
ALTER TABLE players ADD COLUMN news TEXT NOT NULL DEFAULT '';
ALTER TABLE players ADD COLUMN news_added TEXT;
ALTER TABLE players ADD COLUMN chance_next INTEGER;

-- Each account's total value (cash + cards) once a day, for the portfolio chart.
CREATE TABLE portfolio_snapshots (
  user_id INTEGER NOT NULL REFERENCES users(id),
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  day TEXT NOT NULL,                  -- UTC date, YYYY-MM-DD
  value_pence INTEGER NOT NULL,
  PRIMARY KEY (user_id, season_id, day)
);

-- Make the next sync re-read players so the news columns fill in straight away.
DELETE FROM sync_state WHERE key = 'players_synced_at';

-- Weekly packs: one paid pack per user per gameweek, holding one random card.
CREATE TABLE packs (
  user_id INTEGER NOT NULL REFERENCES users(id),
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  event INTEGER NOT NULL,             -- gameweek the pack belongs to
  player_id INTEGER NOT NULL REFERENCES players(id),
  band TEXT NOT NULL,                 -- gold, silver or bronze
  price_pence INTEGER NOT NULL,       -- what the pack cost
  card_price_pence INTEGER NOT NULL,  -- the card's price when it was pulled
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, season_id, event)
);
