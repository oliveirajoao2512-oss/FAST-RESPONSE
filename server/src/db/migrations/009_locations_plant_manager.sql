-- Orders are opened on a machine or on an assembly cell, chosen from the registered lists (Cadastros).
-- Plant manager: gestor permissions over the whole plant, plus the plant indicators panel.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'plant_manager';

ALTER TABLE work_orders ADD COLUMN location_type text CHECK (location_type IN ('maquina', 'montagem'));
ALTER TABLE work_orders ADD CONSTRAINT work_orders_adjust_on_machine CHECK (domain <> 'ajuste' OR location_type IS DISTINCT FROM 'montagem');

-- order in which the lists are shown (as the plant numbers them); new entries go to the end
ALTER TABLE assets ADD COLUMN sort integer NOT NULL DEFAULT 1000;

INSERT INTO assets (type, code, sort) VALUES
  ('maquina', '1A', 1),
  ('maquina', '1C', 2),
  ('maquina', '1E', 3),
  ('maquina', '5', 4),
  ('maquina', '2', 5),
  ('maquina', '3', 6),
  ('maquina', '4', 7),
  ('maquina', '6', 8),
  ('maquina', '22', 9),
  ('maquina', '8', 10),
  ('maquina', '10', 11),
  ('maquina', '11', 12),
  ('maquina', '12', 13),
  ('maquina', '25', 14),
  ('maquina', '14', 15),
  ('maquina', '15', 16),
  ('maquina', '16', 17),
  ('maquina', '17A', 18),
  ('maquina', '17B', 19),
  ('maquina', '18A', 20),
  ('maquina', '18B', 21),
  ('maquina', '19A', 22),
  ('maquina', '19B', 23),
  ('maquina', '20', 24),
  ('maquina', '21A', 25),
  ('maquina', '21B', 26),
  ('maquina', '24', 27),
  ('maquina', '23', 28),
  ('maquina', 'INJETORA 120 T', 29),
  ('maquina', 'INJETORA 470 T', 30),
  ('montagem', '0013.01', 1),
  ('montagem', '0315.01', 2),
  ('montagem', '0539.01', 3),
  ('montagem', '492 / 493.01', 4),
  ('montagem', '0516', 5),
  ('montagem', '0509 / 510', 6),
  ('montagem', '0762.08', 7),
  ('montagem', '0789.08', 8),
  ('montagem', '0648.08', 9)
ON CONFLICT (type, lower(code)) DO UPDATE SET sort = EXCLUDED.sort, active = true;
