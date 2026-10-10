-- Each match's stats minus what was expected of the player at his price. The
-- season's average of this is the market adjustment that keeps prices flat overall.
ALTER TABLE player_match_stats ADD COLUMN vs_expected_bp INTEGER;
