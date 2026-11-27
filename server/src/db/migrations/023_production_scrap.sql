-- What the leader says about pieces missing with no registered stop (João, 27/11/2026): scrap (bad pieces, with the
-- number of pieces) or pieces not made (rhythm). Feeds the Quality and Performance of the OEE.
ALTER TABLE production_entries
  ADD COLUMN gap_kind text CHECK (gap_kind IN ('refugo', 'ritmo')),
  ADD COLUMN scrap_pieces integer CHECK (scrap_pieces BETWEEN 0 AND 1000000);
