-- Qualify storage.objects.name in the correlated policy expressions. Otherwise the
-- inner characters.name can shadow the object path and block replacing/removing images.
DROP POLICY IF EXISTS players_update_own_transformation_images ON storage.objects;
CREATE POLICY players_update_own_transformation_images ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'character-photos'
    AND split_part(objects.name, '/', 2) = 'transformations'
    AND EXISTS (
      SELECT 1
      FROM public.characters c
      WHERE c.id::text = split_part(objects.name, '/', 1)
        AND c.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    bucket_id = 'character-photos'
    AND split_part(objects.name, '/', 2) = 'transformations'
    AND EXISTS (
      SELECT 1
      FROM public.characters c
      WHERE c.id::text = split_part(objects.name, '/', 1)
        AND c.owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS players_delete_own_transformation_images ON storage.objects;
CREATE POLICY players_delete_own_transformation_images ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'character-photos'
    AND split_part(objects.name, '/', 2) = 'transformations'
    AND EXISTS (
      SELECT 1
      FROM public.characters c
      WHERE c.id::text = split_part(objects.name, '/', 1)
        AND c.owner_id = auth.uid()
    )
  );
