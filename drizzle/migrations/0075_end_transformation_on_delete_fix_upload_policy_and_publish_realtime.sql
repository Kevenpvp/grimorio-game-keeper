-- End active transforms before deleting their templates. This restores the modified
-- attributes/Body/Sanidade while the template's configured ending effects still exist.
CREATE OR REPLACE FUNCTION public.end_transformation_before_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _state record;
BEGIN
  FOR _state IN
    SELECT character_id, transformation_id
    FROM public.character_transformations
    WHERE transformation_id = OLD.id AND active IS TRUE
  LOOP
    PERFORM public.end_character_transformation_internal(
      _state.character_id,
      _state.transformation_id,
      false
    );
  END LOOP;
  RETURN OLD;
END;
$function$;

REVOKE ALL ON FUNCTION public.end_transformation_before_delete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_transformation_before_delete() TO service_role;

DROP TRIGGER IF EXISTS transformations_end_active_before_delete ON public.transformations;
CREATE TRIGGER transformations_end_active_before_delete
BEFORE DELETE ON public.transformations
FOR EACH ROW
EXECUTE FUNCTION public.end_transformation_before_delete();

-- Qualify the outer objects.name to avoid accidentally resolving the inner
-- transformations.name column in the EXISTS subquery.
DROP POLICY IF EXISTS players_upload_own_transformation_images ON storage.objects;
CREATE POLICY players_upload_own_transformation_images ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'character-photos'
    AND split_part(objects.name, '/', 2) = 'transformations'
    AND EXISTS (
      SELECT 1 FROM public.characters c
      WHERE c.id::text = split_part(objects.name, '/', 1)
        AND c.owner_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM public.transformations t
      WHERE t.id::text = split_part(objects.name, '/', 3)
    )
  );

-- Transformation state is used to change portrait paths in realtime during combat.
DO $publication$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'character_transformations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.character_transformations;
  END IF;
END;
$publication$;
