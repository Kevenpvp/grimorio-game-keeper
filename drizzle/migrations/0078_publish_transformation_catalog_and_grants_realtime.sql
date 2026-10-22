-- Update open combat sheets immediately when transformation templates or race/virtue
-- grants are created, renamed, edited, or removed.
DO $publication$
DECLARE
  _table text;
BEGIN
  FOREACH _table IN ARRAY ARRAY['transformations','race_transformations','virtue_transformations'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename=_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', _table);
    END IF;
  END LOOP;
END;
$publication$;
