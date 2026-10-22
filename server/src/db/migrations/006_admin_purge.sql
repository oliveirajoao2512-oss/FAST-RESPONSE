-- History tables stay immutable. The only exception is the administrator's permanent deletion of
-- test records, which runs in its own transaction with SET LOCAL fr.purge = 'on'.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('fr.purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Registros de histórico são imutáveis (%).', TG_TABLE_NAME;
END $$;
