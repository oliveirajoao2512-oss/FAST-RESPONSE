-- Fast Response — initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('admin', 'gestor', 'lider', 'colaborador');
CREATE TYPE issue_status AS ENUM ('aberta','aguardando_responsavel','planejada','em_andamento','bloqueada','aguardando_validacao','concluida','cancelada');
CREATE TYPE issue_priority AS ENUM ('baixa','media','alta','critica');
CREATE TYPE issue_complexity AS ENUM ('simples','moderada','complexa');
CREATE TYPE issue_source AS ENUM ('fast_response','direto');
CREATE TYPE step_status AS ENUM ('pendente','em_andamento','bloqueada','concluida','cancelada');
CREATE TYPE approval_status AS ENUM ('pendente','aprovada','rejeitada');

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE areas (
  id serial PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#64748b',
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  registration text,
  password_hash text NOT NULL,
  role user_role NOT NULL DEFAULT 'colaborador',
  area_id integer REFERENCES areas(id),
  active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE UNIQUE INDEX users_registration_uq ON users (lower(registration)) WHERE registration IS NOT NULL;

CREATE TABLE sessions (
  id text PRIMARY KEY, -- sha256 of the cookie token
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip text,
  user_agent text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE categories (
  id serial PRIMARY KEY,
  name text NOT NULL,
  area_id integer REFERENCES areas(id),
  is_safety boolean NOT NULL DEFAULT false,
  requires_evidence boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX categories_name_uq ON categories (lower(name));

CREATE TABLE assets (
  id serial PRIMARY KEY,
  type text NOT NULL,
  code text NOT NULL,
  description text,
  area_id integer REFERENCES areas(id),
  active boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX assets_code_uq ON assets (type, lower(code));

CREATE SEQUENCE issue_code_seq;

CREATE TABLE issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  description text,
  area_id integer NOT NULL REFERENCES areas(id),
  origin_area_id integer NOT NULL REFERENCES areas(id),
  assignee_id uuid REFERENCES users(id),
  opened_by uuid NOT NULL REFERENCES users(id),
  priority issue_priority NOT NULL DEFAULT 'media',
  status issue_status NOT NULL,
  category_id integer REFERENCES categories(id),
  asset_type text,
  asset_ref text,
  expected_action text,
  next_action text,
  source issue_source NOT NULL DEFAULT 'fast_response',
  is_safety_critical boolean NOT NULL DEFAULT false,
  opened_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  original_due_at timestamptz NOT NULL,
  overdue_since timestamptz,
  due_soon_notified_at timestamptz,
  manager_escalated_at timestamptz,
  complexity issue_complexity NOT NULL DEFAULT 'simples',
  complexity_approved_by uuid REFERENCES users(id),
  completed_at timestamptz,
  completed_by uuid REFERENCES users(id),
  solution text,
  criteria_confirmed boolean NOT NULL DEFAULT false,
  validated_at timestamptz,
  validated_by uuid REFERENCES users(id),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES users(id),
  cancel_reason text,
  reopen_count integer NOT NULL DEFAULT 0,
  recurrence_of_id uuid REFERENCES issues(id),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('portuguese', coalesce(code,'') || ' ' || coalesce(title,'') || ' ' || coalesce(description,'') || ' ' || coalesce(asset_ref,''))
  ) STORED
);
CREATE INDEX issues_area_idx ON issues (area_id, status);
CREATE INDEX issues_origin_idx ON issues (origin_area_id);
CREATE INDEX issues_assignee_idx ON issues (assignee_id, status);
CREATE INDEX issues_status_due_idx ON issues (status, due_at);
CREATE INDEX issues_validated_idx ON issues (validated_at);
CREATE INDEX issues_search_idx ON issues USING gin (search);
CREATE INDEX issues_asset_idx ON issues (lower(asset_ref));

CREATE TABLE issue_status_history (
  id bigserial PRIMARY KEY,
  issue_id uuid NOT NULL REFERENCES issues(id),
  from_status issue_status,
  to_status issue_status NOT NULL,
  changed_by uuid REFERENCES users(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text
);
CREATE INDEX ish_issue_idx ON issue_status_history (issue_id, changed_at);

CREATE TABLE steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id),
  position integer NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  description text,
  assignee_id uuid REFERENCES users(id),
  due_at timestamptz,
  original_due_at timestamptz,
  status step_status NOT NULL DEFAULT 'pendente',
  mandatory boolean NOT NULL DEFAULT true,
  depends_on uuid[] NOT NULL DEFAULT '{}',
  completed_at timestamptz,
  completed_by uuid REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX steps_issue_idx ON steps (issue_id, position);
CREATE INDEX steps_assignee_idx ON steps (assignee_id, status);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id),
  step_id uuid REFERENCES steps(id),
  author_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL DEFAULT 'comentario', -- comentario | decisao_reuniao
  body text NOT NULL CHECK (length(trim(body)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_issue_idx ON comments (issue_id, created_at);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id),
  step_id uuid REFERENCES steps(id),
  purpose text NOT NULL DEFAULT 'anexo', -- anexo | evidencia | conclusao
  filename text NOT NULL,
  mime text NOT NULL,
  size_bytes integer NOT NULL,
  sha256 text NOT NULL,
  storage_path text NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_issue_idx ON attachments (issue_id);

CREATE TABLE impediments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id),
  step_id uuid REFERENCES steps(id),
  description text NOT NULL,
  blocking_area_id integer REFERENCES areas(id),
  previous_status issue_status,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id),
  resolution text
);
CREATE INDEX impediments_issue_idx ON impediments (issue_id) WHERE resolved_at IS NULL;

CREATE TABLE transfers (
  id bigserial PRIMARY KEY,
  issue_id uuid NOT NULL REFERENCES issues(id),
  from_area_id integer REFERENCES areas(id),
  to_area_id integer REFERENCES areas(id),
  from_user_id uuid REFERENCES users(id),
  to_user_id uuid REFERENCES users(id),
  reason text,
  transferred_by uuid NOT NULL REFERENCES users(id),
  transferred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transfers_issue_idx ON transfers (issue_id);

CREATE TABLE deadline_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id uuid NOT NULL REFERENCES issues(id),
  step_id uuid REFERENCES steps(id),
  old_due_at timestamptz,
  new_due_at timestamptz NOT NULL,
  reason text NOT NULL,
  status approval_status NOT NULL DEFAULT 'pendente',
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text
);
CREATE INDEX deadline_changes_issue_idx ON deadline_changes (issue_id);

CREATE TABLE validations (
  id bigserial PRIMARY KEY,
  issue_id uuid NOT NULL REFERENCES issues(id),
  approved boolean NOT NULL,
  note text,
  validated_by uuid NOT NULL REFERENCES users(id),
  validated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reopenings (
  id bigserial PRIMARY KEY,
  issue_id uuid NOT NULL REFERENCES issues(id),
  kind text NOT NULL, -- validacao_rejeitada | solucao_ineficaz
  reason text NOT NULL,
  previous_completed_by uuid REFERENCES users(id),
  reopened_by uuid NOT NULL REFERENCES users(id),
  reopened_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_date date NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  started_by uuid NOT NULL REFERENCES users(id),
  ended_at timestamptz,
  notes text
);
CREATE INDEX meetings_started_idx ON meetings (started_at DESC);

CREATE TABLE meeting_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid NOT NULL REFERENCES meetings(id),
  issue_id uuid REFERENCES issues(id),
  decision text NOT NULL,
  owner_id uuid REFERENCES users(id),
  due_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meeting_decisions_meeting_idx ON meeting_decisions (meeting_id);

CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL,
  title text NOT NULL,
  body text,
  issue_id uuid REFERENCES issues(id),
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE UNIQUE INDEX notifications_dedupe_uq ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE notification_deliveries (
  id bigserial PRIMARY KEY,
  notification_id bigint NOT NULL REFERENCES notifications(id),
  channel text NOT NULL,
  status text NOT NULL, -- pendente | enviado | falhou
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX notification_deliveries_pending_idx ON notification_deliveries (status) WHERE status = 'pendente';

CREATE TABLE monthly_scores (
  month text NOT NULL, -- YYYY-MM
  user_id uuid NOT NULL REFERENCES users(id),
  area_id integer REFERENCES areas(id),
  points numeric(10,1) NOT NULL,
  validated_count integer NOT NULL,
  on_time_count integer NOT NULL,
  reopen_count integer NOT NULL,
  steps_count integer NOT NULL,
  breakdown jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, user_id)
);

CREATE TABLE monthly_area_scores (
  month text NOT NULL,
  area_id integer NOT NULL REFERENCES areas(id),
  points numeric(10,1) NOT NULL,
  validated_count integer NOT NULL,
  on_time_pct numeric(5,1),
  avg_resolution_hours numeric(10,1),
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, area_id)
);

CREATE TABLE ranking_months (
  month text PRIMARY KEY,
  finalized_at timestamptz,
  finalized_by uuid REFERENCES users(id),
  config_snapshot jsonb
);

-- Append-only audit trail. UPDATE/DELETE are rejected by trigger, for every role.
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  issue_id uuid REFERENCES issues(id),
  data jsonb NOT NULL DEFAULT '{}',
  ip text
);
CREATE INDEX audit_issue_idx ON audit_events (issue_id, at);
CREATE INDEX audit_at_idx ON audit_events (at DESC);
CREATE INDEX audit_actor_idx ON audit_events (actor_id, at DESC);

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Registros de histórico são imutáveis (%).', TG_TABLE_NAME;
END $$;

CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER status_history_immutable BEFORE UPDATE OR DELETE ON issue_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER transfers_immutable BEFORE UPDATE OR DELETE ON transfers
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER validations_immutable BEFORE UPDATE OR DELETE ON validations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER reopenings_immutable BEFORE UPDATE OR DELETE ON reopenings
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER comments_immutable BEFORE UPDATE OR DELETE ON comments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- Issues are never deleted: they are cancelled.
CREATE TRIGGER issues_no_delete BEFORE DELETE ON issues
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- original_due_at may never change.
CREATE FUNCTION keep_original_due() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.original_due_at IS DISTINCT FROM OLD.original_due_at THEN
    RAISE EXCEPTION 'O prazo original não pode ser alterado.';
  END IF;
  IF NEW.origin_area_id IS DISTINCT FROM OLD.origin_area_id THEN
    RAISE EXCEPTION 'A área de origem não pode ser alterada.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER issues_keep_original BEFORE UPDATE ON issues
  FOR EACH ROW EXECUTE FUNCTION keep_original_due();
