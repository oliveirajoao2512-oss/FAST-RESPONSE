-- Registered part numbers (the plant's product list). Orders accept only a registered PN once the list has entries,
-- so a typo never creates a "new" product in the history. Loaded from the PCP spreadsheet in Gestão → Cadastros.
CREATE TABLE part_numbers (
  id serial PRIMARY KEY,
  code text NOT NULL CHECK (length(trim(code)) > 0),
  description text,
  customer text,
  machine text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX part_numbers_code_key ON part_numbers (upper(code));
ALTER TABLE part_numbers ENABLE ROW LEVEL SECURITY;
