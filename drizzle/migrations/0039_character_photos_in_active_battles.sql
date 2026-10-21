-- Let players load character portraits for opponents while sharing an active battle.
-- Resource values and active effects remain protected by their own separate policies.

CREATE OR REPLACE FUNCTION public.can_read_character_photo(_photo_character_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
    AND (
      public.has_role(auth.uid(), 'master')
      OR EXISTS (
        SELECT 1
        FROM public.characters c
        WHERE c.id::text = _photo_character_id
          AND c.owner_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.battle_participants photo_participant
        JOIN public.battles b
          ON b.id = photo_participant.battle_id
        WHERE photo_participant.character_id::text = _photo_character_id
          AND b.active = true
          AND EXISTS (
            SELECT 1
            FROM public.battle_participants viewer_participant
            JOIN public.characters viewer_character
              ON viewer_character.id = viewer_participant.character_id
            WHERE viewer_participant.battle_id = b.id
              AND viewer_character.owner_id = auth.uid()
          )
      )
    );
$$;

REVOKE ALL ON FUNCTION public.can_read_character_photo(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.can_read_character_photo(text) TO authenticated;

DROP POLICY IF EXISTS "player reads own photo" ON storage.objects;
CREATE POLICY "players read own and active battle photos"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'character-photos'
  AND public.can_read_character_photo((storage.foldername(storage.objects.name))[1])
);
