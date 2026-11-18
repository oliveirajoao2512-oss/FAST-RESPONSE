-- An order opened by mistake can be cancelled by whoever opened it (or the leadership) while nobody is working on it.
ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS work_orders_status_check;
ALTER TABLE work_orders ADD CONSTRAINT work_orders_status_check
  CHECK (status IN ('em_analise', 'programada', 'aberta', 'em_atendimento', 'pausada', 'finalizada', 'recusada', 'cancelada'));
ALTER TABLE work_orders
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by uuid REFERENCES users(id),
  ADD COLUMN cancel_reason text;

-- "one order at a time": finding the open order a person is on
CREATE INDEX work_order_workers_user_active_idx ON work_order_workers (user_id) WHERE left_at IS NULL;
