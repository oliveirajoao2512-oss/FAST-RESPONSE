-- Meal break told as start and end times (João, 27/11/2026: it does not always start on the hour). The minutes inside
-- each reported hour stay in break_minutes; the interval lets the next hour of the same machine count the rest.
ALTER TABLE production_entries
  ADD COLUMN break_start timestamptz,
  ADD COLUMN break_end timestamptz,
  ADD CONSTRAINT production_entries_break_chk CHECK (break_start IS NULL OR (break_end > break_start AND break_end - break_start <= interval '4 hours'));
