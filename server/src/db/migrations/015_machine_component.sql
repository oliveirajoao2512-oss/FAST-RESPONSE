-- The place stays machine or assembly cell. On a machine, the maintenance order says which part has the problem:
-- the machine itself, a device or the trim die (both belong to the machine). Replaces the mold/device places of 014.
ALTER TABLE work_orders DROP CONSTRAINT work_orders_location_type_check;
ALTER TABLE work_orders ADD CONSTRAINT work_orders_location_type_check CHECK (location_type IN ('maquina', 'montagem'));
ALTER TABLE work_orders DROP CONSTRAINT work_orders_adjust_on_machine;
ALTER TABLE work_orders ADD CONSTRAINT work_orders_adjust_on_machine CHECK (domain <> 'ajuste' OR location_type IS DISTINCT FROM 'montagem');
ALTER TABLE work_orders ADD COLUMN component text CHECK (component IN ('maquina', 'dispositivo', 'trim_die'));
