-- Conferência de produção, stage 1 (27/11/2026). Nothing in the order or setup modules changes: the stops are read
-- from what already exists (work_orders with the machine stopped, Controle de Setup) when the conferência is shown.

-- Standard cycle per machine and part number: seconds per cycle and pieces per cycle (cavities).
CREATE TABLE production_standards (
  id serial PRIMARY KEY,
  machine text NOT NULL CHECK (length(trim(machine)) > 0),
  pn text NOT NULL CHECK (length(trim(pn)) > 0),
  cycle_seconds numeric(8,2) NOT NULL CHECK (cycle_seconds > 0),
  cavities integer NOT NULL DEFAULT 1 CHECK (cavities BETWEEN 1 AND 64),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'controle_ciclo')),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX production_standards_key ON production_standards (upper(machine), upper(pn));
ALTER TABLE production_standards ENABLE ROW LEVEL SECURITY;

-- What the leader reported. The standard used is copied into the report, so changing a cycle later does not rewrite
-- history; the stops are not copied, so an OS registered later still counts.
CREATE TABLE production_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine text NOT NULL,
  pn text NOT NULL,
  shift text,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL CHECK (period_end > period_start),
  quantity integer NOT NULL CHECK (quantity >= 0),
  cycle_seconds numeric(8,2),
  cavities integer,
  -- machine of the standard used when it came from another machine running the same PN
  standard_machine text,
  note text,
  leader_id uuid NOT NULL REFERENCES users(id),
  gap_reason text,
  gap_reason_by uuid REFERENCES users(id),
  gap_reason_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  updated_by uuid REFERENCES users(id)
);
CREATE INDEX production_entries_machine_idx ON production_entries (upper(machine), period_start);
CREATE INDEX production_entries_start_idx ON production_entries (period_start);
ALTER TABLE production_entries ENABLE ROW LEVEL SECURITY;
