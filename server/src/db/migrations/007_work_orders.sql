-- Maintenance work orders (Ordem de Manutenção). Maintainers ("manutentor") only see this module.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'manutentor';

CREATE SEQUENCE work_order_number_seq;

CREATE TABLE work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer NOT NULL UNIQUE DEFAULT nextval('work_order_number_seq'),
  code text NOT NULL UNIQUE,
  opened_by uuid NOT NULL REFERENCES users(id),
  area_id integer NOT NULL REFERENCES areas(id),
  asset_ref text NOT NULL CHECK (length(trim(asset_ref)) > 0),
  kind text NOT NULL CHECK (kind IN ('mecanica', 'eletrica', 'hidraulica', 'pneumatica', 'outros')),
  machine_stopped boolean NOT NULL,
  description text NOT NULL CHECK (length(trim(description)) > 0),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('critica', 'alta', 'normal', 'baixa')),
  pinned boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'em_atendimento', 'pausada', 'finalizada')),
  -- maintainer suggested by the maintenance leadership ("indicada para")
  suggested_to uuid REFERENCES users(id),
  -- pending hand-over: only takes effect when transfer_to accepts
  transfer_from uuid REFERENCES users(id),
  transfer_to uuid REFERENCES users(id),
  service_done text,
  material text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  first_accepted_at timestamptz,
  finished_at timestamptz,
  finished_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX work_orders_status_idx ON work_orders (status, opened_at);
CREATE INDEX work_orders_asset_idx ON work_orders (lower(asset_ref));

-- Who worked on the order and when (one row per stint; several maintainers at once is allowed).
CREATE TABLE work_order_workers (
  id bigserial PRIMARY KEY,
  work_order_id uuid NOT NULL REFERENCES work_orders(id),
  user_id uuid NOT NULL REFERENCES users(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  left_reason text CHECK (left_reason IN ('finalizou', 'devolveu', 'passou', 'saiu'))
);
CREATE INDEX work_order_workers_wo_idx ON work_order_workers (work_order_id);
CREATE UNIQUE INDEX work_order_workers_active_uq ON work_order_workers (work_order_id, user_id) WHERE left_at IS NULL;

CREATE TABLE work_order_pauses (
  id bigserial PRIMARY KEY,
  work_order_id uuid NOT NULL REFERENCES work_orders(id),
  reason text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  started_by uuid NOT NULL REFERENCES users(id),
  ended_at timestamptz,
  ended_by uuid REFERENCES users(id)
);
CREATE INDEX work_order_pauses_wo_idx ON work_order_pauses (work_order_id);
CREATE UNIQUE INDEX work_order_pauses_open_uq ON work_order_pauses (work_order_id) WHERE ended_at IS NULL;

-- History of every step of the order (append-only).
CREATE TABLE work_order_events (
  id bigserial PRIMARY KEY,
  work_order_id uuid NOT NULL REFERENCES work_orders(id),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_order_events_wo_idx ON work_order_events (work_order_id, created_at);
CREATE TRIGGER work_order_events_immutable BEFORE UPDATE OR DELETE ON work_order_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER work_orders_no_delete BEFORE DELETE ON work_orders
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE work_order_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES work_orders(id),
  purpose text NOT NULL CHECK (purpose IN ('abertura', 'servico')),
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes integer NOT NULL,
  sha256 text NOT NULL,
  storage_path text NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_order_attachments_wo_idx ON work_order_attachments (work_order_id);

ALTER TABLE notifications ADD COLUMN work_order_id uuid REFERENCES work_orders(id);

ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_pauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_attachments ENABLE ROW LEVEL SECURITY;
