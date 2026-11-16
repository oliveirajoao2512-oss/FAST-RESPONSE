-- Devices ("D", e.g. D405) and trim dies ("T", e.g. T129) of the plant, as identified on the shop floor.
-- A tool is linked to the part numbers it makes and, optionally, directly to machines; with that, the OS opening
-- suggests the device of the machine chosen. Loaded from the "Controle de Moldes e Dispositivos" spreadsheet in
-- Administração → Cadastros, and editable there.
CREATE TABLE tools (
  code text PRIMARY KEY CHECK (code ~ '^[DT][0-9]{3,4}$'),
  type text NOT NULL CHECK (type IN ('dispositivo', 'trim_die')),
  CHECK ((type = 'dispositivo') = (code LIKE 'D%')),
  description text,
  molds text,
  part_numbers text[] NOT NULL DEFAULT '{}',
  machines text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tools ENABLE ROW LEVEL SECURITY;

-- The device (D) or trim die (T) of a maintenance order on a machine.
ALTER TABLE work_orders ADD COLUMN tool_code text;
ALTER TABLE work_orders ADD CONSTRAINT work_orders_tool_component
  CHECK (tool_code IS NULL OR (tool_code LIKE 'D%' AND component = 'dispositivo') OR (tool_code LIKE 'T%' AND component = 'trim_die'));
CREATE INDEX work_orders_tool_code_idx ON work_orders (tool_code) WHERE tool_code IS NOT NULL;

-- Finished orders are listed month by month.
CREATE INDEX IF NOT EXISTS work_orders_finished_idx ON work_orders (domain, finished_at DESC) WHERE finished_at IS NOT NULL;

-- The old paper history only had the device code in place of the machine: it becomes the order's device.
UPDATE work_orders SET tool_code = asset_ref WHERE imported AND component = 'dispositivo' AND asset_ref ~ '^D[0-9]{3,4}$';
