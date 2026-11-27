-- The PCP's daily plan (sheet PLANEJAMENTO): which PN each machine runs in each shift. The last upload of a date is
-- the plan of that date; older uploads stay as history.
CREATE TABLE production_plans (
  id serial PRIMARY KEY,
  plan_date date NOT NULL,
  file_name text,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX production_plans_date_idx ON production_plans (plan_date, uploaded_at DESC);
ALTER TABLE production_plans ENABLE ROW LEVEL SECURITY;

CREATE TABLE production_plan_items (
  id serial PRIMARY KEY,
  plan_id integer NOT NULL REFERENCES production_plans(id),
  machine text NOT NULL,
  pn text NOT NULL,
  -- 1, 2, 3 = 1º, 2º, 3º turno
  shifts integer[] NOT NULL,
  cycle_seconds numeric(8,2),
  cavities integer NOT NULL DEFAULT 1,
  op text
);
CREATE INDEX production_plan_items_plan_idx ON production_plan_items (plan_id);
ALTER TABLE production_plan_items ENABLE ROW LEVEL SECURITY;
