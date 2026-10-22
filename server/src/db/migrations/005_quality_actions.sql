-- Decisions on actions suggested from the "Resposta Rápida" steps: approved (became an issue) or discarded.
-- One decision per NC step, so the same step is never suggested twice.
CREATE TABLE quality_actions (
  id bigserial PRIMARY KEY,
  nc_id bigint NOT NULL REFERENCES quality_ncs(id),
  step text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('criada', 'descartada')),
  issue_id uuid REFERENCES issues(id),
  area_id int REFERENCES areas(id),
  note text,
  decided_by uuid NOT NULL REFERENCES users(id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (nc_id, step)
);
CREATE INDEX quality_actions_issue_idx ON quality_actions (issue_id);
ALTER TABLE quality_actions ENABLE ROW LEVEL SECURITY;
