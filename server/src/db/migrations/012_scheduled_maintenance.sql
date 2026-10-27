-- Planned maintenance ("manutenção programada"): opened with a date and an expected duration, analysed by the
-- Logistics leadership (approve, possibly on another date, or refuse) before it reaches the maintenance queue.
ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS work_orders_status_check;
ALTER TABLE work_orders ADD CONSTRAINT work_orders_status_check
  CHECK (status IN ('em_analise', 'programada', 'aberta', 'em_atendimento', 'pausada', 'finalizada', 'recusada'));
ALTER TABLE work_orders
  ADD COLUMN scheduled boolean NOT NULL DEFAULT false,
  -- date asked by whoever opened it, and the one approved by Logistics (may differ)
  ADD COLUMN requested_start timestamptz,
  ADD COLUMN planned_start timestamptz,
  ADD COLUMN planned_hours numeric(5,1) CHECK (planned_hours > 0),
  ADD COLUMN analyzed_by uuid REFERENCES users(id),
  ADD COLUMN analyzed_at timestamptz,
  ADD COLUMN analysis_note text;
CREATE INDEX work_orders_planned_idx ON work_orders (planned_start) WHERE scheduled;
