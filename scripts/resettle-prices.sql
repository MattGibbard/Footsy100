-- Re-prices every settled match with the current price engine: puts each
-- player back to his price before his first settled match, clears the price
-- history and match stats, and marks those matches unsettled so the next syncs
-- settle them again (2 matches per run, every 15 minutes). Trades and holdings
-- are kept, so card values change with the prices.
--   npx wrangler d1 execute footsy100 --remote --file=scripts/resettle-prices.sql
UPDATE players SET
  price_pence = (SELECT ph.old_price_pence FROM price_history ph WHERE ph.player_id = players.id ORDER BY ph.created_at, ph.id LIMIT 1),
  prev_price_pence = NULL
WHERE id IN (SELECT player_id FROM price_history);
UPDATE fixtures SET settled_at = NULL WHERE id IN (SELECT fixture_id FROM price_history WHERE fixture_id IS NOT NULL);
DELETE FROM player_match_stats WHERE fixture_id IN (SELECT fixture_id FROM price_history WHERE fixture_id IS NOT NULL);
DELETE FROM price_history;
