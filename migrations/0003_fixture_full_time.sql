-- FPL sets finished_provisional at the final whistle, but only sets finished once
-- bonus points are confirmed (often an hour later). The site shows full time from
-- the first; prices still settle on the second.
ALTER TABLE fixtures ADD COLUMN finished_provisional INTEGER NOT NULL DEFAULT 0;
