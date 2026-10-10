-- Starts everyone fresh: deletes every trade and holding and puts every
-- account back to £100. Users, leagues, prices and price history are kept.
-- Run once, after the whole-cards release has deployed:
--   npx wrangler d1 execute footsy100 --remote --file=scripts/reset-trades.sql
DELETE FROM trades;
DELETE FROM holdings;
UPDATE accounts SET cash_pence = 10000;
