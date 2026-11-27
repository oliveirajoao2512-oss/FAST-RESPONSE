-- Meal break inside a reported period (minutes). Its time is not fixed: it depends on who covers the machine.
ALTER TABLE production_entries ADD COLUMN break_minutes integer NOT NULL DEFAULT 0 CHECK (break_minutes BETWEEN 0 AND 720);
