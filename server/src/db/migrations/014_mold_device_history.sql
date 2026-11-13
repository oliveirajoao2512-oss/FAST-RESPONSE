-- Orders can also be opened for a mold (identified by the machine it runs on) or a device (dispositivo).
ALTER TABLE work_orders DROP CONSTRAINT IF EXISTS work_orders_location_type_check;
ALTER TABLE work_orders ADD CONSTRAINT work_orders_location_type_check CHECK (location_type IN ('maquina', 'montagem', 'molde', 'dispositivo'));
ALTER TABLE work_orders DROP CONSTRAINT work_orders_adjust_on_machine;
ALTER TABLE work_orders ADD CONSTRAINT work_orders_adjust_on_machine CHECK (domain <> 'ajuste' OR location_type IS NULL OR location_type = 'maquina');

-- Orders loaded from the old paper/spreadsheet history: only the day is known (no hour), and the original OS number is kept.
ALTER TABLE work_orders ADD COLUMN imported boolean NOT NULL DEFAULT false;
ALTER TABLE work_orders ADD COLUMN legacy_number text;
