-- Hosted Postgres providers (e.g. Supabase) expose the public schema through an automatic REST API.
-- Enabling RLS without policies denies that API every row; the application connects as the table
-- owner, which is not subject to RLS, so its behaviour is unchanged.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
