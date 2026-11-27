-- A stop the leader tells when reporting the hour, with no OS/OA/setup behind it (João, 27/11/2026): no raw material,
-- packaging, components, operator… It explains lost time before the rest becomes scrap.
ALTER TABLE production_entries
  ADD COLUMN other_stop_minutes integer CHECK (other_stop_minutes BETWEEN 1 AND 720),
  ADD COLUMN other_stop_reason text CHECK (other_stop_reason IS NULL OR length(other_stop_reason) <= 200);
