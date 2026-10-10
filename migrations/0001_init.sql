-- Money is stored in pence (INTEGER). Shares are stored in micro-shares
-- (1 share = 1,000,000) so fractional holdings stay exact.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_login_tokens_email ON login_tokens(email, created_at);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,          -- e.g. '2026/27'
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One cash account per user per season; each season starts at £100.
CREATE TABLE accounts (
  user_id INTEGER NOT NULL REFERENCES users(id),
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  -- The CHECK makes an overspend abort the whole trade batch.
  cash_pence INTEGER NOT NULL CHECK (cash_pence >= 0),
  PRIMARY KEY (user_id, season_id)
);

CREATE TABLE teams (
  id INTEGER PRIMARY KEY,             -- FPL team id
  name TEXT NOT NULL,
  short_name TEXT NOT NULL
);

CREATE TABLE players (
  id INTEGER PRIMARY KEY,             -- FPL element id
  first_name TEXT NOT NULL,
  second_name TEXT NOT NULL,
  web_name TEXT NOT NULL,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  position TEXT NOT NULL,             -- GKP, DEF, MID, FWD
  status TEXT NOT NULL DEFAULT 'a',   -- FPL availability flag
  price_pence INTEGER NOT NULL,
  prev_price_pence INTEGER,           -- price before the last match was settled
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_players_team ON players(team_id);

CREATE TABLE fixtures (
  id INTEGER PRIMARY KEY,             -- FPL fixture id
  event INTEGER,                      -- gameweek
  team_h INTEGER NOT NULL,
  team_a INTEGER NOT NULL,
  kickoff_time TEXT,                  -- ISO UTC, NULL if unscheduled
  started INTEGER NOT NULL DEFAULT 0,
  finished INTEGER NOT NULL DEFAULT 0,
  team_h_score INTEGER,
  team_a_score INTEGER,
  settled_at TEXT                     -- set once prices have been updated
);
CREATE INDEX idx_fixtures_kickoff ON fixtures(kickoff_time);

CREATE TABLE holdings (
  user_id INTEGER NOT NULL REFERENCES users(id),
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  -- Rows are kept at zero rather than deleted, so a double sell hits this CHECK.
  shares_micro INTEGER NOT NULL CHECK (shares_micro >= 0),
  cost_pence INTEGER NOT NULL,        -- cost basis of the shares still held
  PRIMARY KEY (user_id, season_id, player_id)
);
CREATE INDEX idx_holdings_player ON holdings(player_id);

CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  shares_micro INTEGER NOT NULL,
  price_pence INTEGER NOT NULL,
  gross_pence INTEGER NOT NULL,
  fee_pence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_trades_user ON trades(user_id, created_at);
CREATE INDEX idx_trades_player ON trades(player_id, created_at);

CREATE TABLE price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(id),
  fixture_id INTEGER,
  old_price_pence INTEGER NOT NULL,
  new_price_pence INTEGER NOT NULL,
  reason TEXT NOT NULL,               -- JSON breakdown of the change
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_price_history_player ON price_history(player_id, created_at);

CREATE TABLE player_match_stats (
  fixture_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 0,
  goals INTEGER NOT NULL DEFAULT 0,
  assists INTEGER NOT NULL DEFAULT 0,
  clean_sheet INTEGER NOT NULL DEFAULT 0,
  goals_conceded INTEGER NOT NULL DEFAULT 0,
  own_goals INTEGER NOT NULL DEFAULT 0,
  penalties_saved INTEGER NOT NULL DEFAULT 0,
  penalties_missed INTEGER NOT NULL DEFAULT 0,
  yellow_cards INTEGER NOT NULL DEFAULT 0,
  red_cards INTEGER NOT NULL DEFAULT 0,
  saves INTEGER NOT NULL DEFAULT 0,
  bonus INTEGER NOT NULL DEFAULT 0,
  bps INTEGER NOT NULL DEFAULT 0,
  defensive_contribution INTEGER NOT NULL DEFAULT 0,
  change_bp INTEGER NOT NULL DEFAULT 0, -- total price change in basis points
  PRIMARY KEY (fixture_id, player_id)
);

CREATE TABLE leagues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE league_members (
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league_id, user_id)
);
CREATE INDEX idx_league_members_user ON league_members(user_id);

-- Final value of each account, frozen when a new season starts.
CREATE TABLE season_results (
  user_id INTEGER NOT NULL REFERENCES users(id),
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  final_value_pence INTEGER NOT NULL,
  PRIMARY KEY (user_id, season_id)
);

CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
