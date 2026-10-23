-- Process adjustment orders (Ordem de Ajuste - Processo) share the work-order tables with maintenance orders.
-- Process technicians ("tecnico_processo") only see this module.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'tecnico_processo';

CREATE SEQUENCE adjustment_order_number_seq;

ALTER TABLE work_orders ADD COLUMN domain text NOT NULL DEFAULT 'manutencao' CHECK (domain IN ('manutencao', 'ajuste'));
ALTER TABLE work_orders DROP CONSTRAINT work_orders_number_key;
ALTER TABLE work_orders ALTER COLUMN number DROP DEFAULT;
ALTER TABLE work_orders ADD CONSTRAINT work_orders_domain_number_key UNIQUE (domain, number);
ALTER TABLE work_orders ALTER COLUMN kind DROP NOT NULL;
-- adjustment orders: reason numbered as on the paper form, part number, and material mix for reason 21
ALTER TABLE work_orders ADD COLUMN reason integer CHECK (reason BETWEEN 1 AND 21);
ALTER TABLE work_orders ADD COLUMN part_number text;
ALTER TABLE work_orders ADD COLUMN virgin_pct numeric(5,2) CHECK (virgin_pct BETWEEN 0 AND 100);
ALTER TABLE work_orders ADD COLUMN regrind_pct numeric(5,2) CHECK (regrind_pct BETWEEN 0 AND 100);
ALTER TABLE work_orders ADD CONSTRAINT work_orders_domain_fields CHECK (
  (domain = 'manutencao' AND kind IS NOT NULL) OR (domain = 'ajuste' AND reason IS NOT NULL));
DROP INDEX work_orders_status_idx;
CREATE INDEX work_orders_status_idx ON work_orders (domain, status, opened_at);
