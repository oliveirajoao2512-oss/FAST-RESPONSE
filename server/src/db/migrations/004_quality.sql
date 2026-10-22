-- Quality module: "Resposta Rápida" non-conformities (customer, internal, supplier),
-- imported from the company spreadsheet and maintained in the system.

CREATE TABLE quality_imports (
  id bigserial PRIMARY KEY,
  filename text NOT NULL,
  sha256 text NOT NULL,
  imported_by uuid NOT NULL REFERENCES users(id),
  imported_at timestamptz NOT NULL DEFAULT now(),
  created_count int NOT NULL,
  updated_count int NOT NULL,
  unchanged_count int NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]'
);
CREATE TRIGGER quality_imports_immutable BEFORE UPDATE OR DELETE ON quality_imports
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE quality_ncs (
  id bigserial PRIMARY KEY,
  origin text NOT NULL CHECK (origin IN ('externa', 'interna', 'fornecedor')),
  number text NOT NULL,
  opened_on date NOT NULL,
  kind text,
  partner text,
  claim_type text,
  product text,
  internal_code text,
  customer_code text,
  customer_claim text,
  description text,
  primary_problem text,
  safety boolean NOT NULL DEFAULT false,
  recurrent boolean NOT NULL DEFAULT false,
  leader text,
  steps jsonb NOT NULL DEFAULT '{}',
  action_plan text,
  due_on date NOT NULL,
  on_hold boolean NOT NULL DEFAULT false,
  on_hold_reason text,
  procedente text CHECK (procedente IN ('SIM', 'NÃO', 'EM ANÁLISE')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'importacao')),
  last_import_id bigint REFERENCES quality_imports(id),
  version int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (origin, number)
);
CREATE INDEX quality_ncs_opened_idx ON quality_ncs (opened_on);

-- Lists of the spreadsheet's CADASTRO tab (types, customers, suppliers, problems, leaders) for suggestions.
CREATE TABLE quality_catalog (
  kind text NOT NULL CHECK (kind IN ('tipo', 'cliente', 'fornecedor', 'problema', 'lider')),
  value text NOT NULL,
  PRIMARY KEY (kind, value)
);

-- Same protection as the other tables: no access through Supabase's automatic REST API.
ALTER TABLE quality_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_ncs ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_catalog ENABLE ROW LEVEL SECURITY;
