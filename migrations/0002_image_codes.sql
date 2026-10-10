-- FPL's `code` fields key the official Premier League player photos and club
-- crests (they stay the same across seasons, unlike FPL ids).
ALTER TABLE players ADD COLUMN code INTEGER;
ALTER TABLE teams ADD COLUMN code INTEGER;

-- Make the next sync re-read players so existing rows pick up their codes.
-- Prices are untouched: only a new season resets them.
DELETE FROM sync_state WHERE key = 'players_synced_at';
