-- Trading moves to whole cards: no more fractional shares. Holdings and trades
-- now count cards. Existing micro-share rows are floored to whole cards so
-- nothing shows silly numbers; the reset in the README then starts everyone fresh.
ALTER TABLE holdings RENAME COLUMN shares_micro TO cards;
ALTER TABLE trades RENAME COLUMN shares_micro TO cards;
UPDATE holdings SET cards = cards / 1000000;
UPDATE trades SET cards = cards / 1000000;
