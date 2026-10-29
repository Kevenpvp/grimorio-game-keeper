-- Let players see portraits of creatures legitimately granted to their sheets,
-- without granting access to unrelated character photos.
-- The details RPC already authorizes the same grants for the player.
CREATE OR REPLACE FUNCTION public.can_read_character_photo(_photo_character_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT auth.uid() IS NOT NULL AND (
    public.has_role(auth.uid(),'master')
    OR EXISTS (
      SELECT 1 FROM public.characters c
      WHERE c.id::text=_photo_character_id AND c.owner_id=auth.uid()
    )
    OR EXISTS (
      SELECT 1
      FROM public.summon_grants g
      WHERE g.template_character_id::text=_photo_character_id
        AND (
          EXISTS (
            SELECT 1 FROM public.characters summoner
            WHERE summoner.id=g.summoner_character_id
              AND summoner.owner_id=auth.uid()
          )
          OR EXISTS (
            SELECT 1
            FROM public.character_abilities ability
            JOIN public.characters summoner ON summoner.id=ability.character_id
            WHERE ability.ability_id=g.ability_id
              AND summoner.owner_id=auth.uid()
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.battle_participants photo_participant
      JOIN public.battles b ON b.id=photo_participant.battle_id
      WHERE photo_participant.character_id::text=_photo_character_id
        AND b.active=true
        AND EXISTS (
          SELECT 1
          FROM public.battle_participants viewer_participant
          JOIN public.characters viewer_character
            ON viewer_character.id=viewer_participant.character_id
          WHERE viewer_participant.battle_id=b.id
            AND viewer_character.owner_id=auth.uid()
        )
    )
  );
$fn$;

-- Include the creature's registered portrait with the previously authorized
-- detail response. Use the template's photograph even while a live summoned
-- snapshot is displayed (snapshots may not own a photo).
DO $patch$
DECLARE
  _definition text;
  _old text := '''description'',_creature.description,';
  _new text := '''description'',_creature.description,' || chr(10) ||
    '      ''photo_path'',(SELECT template.photo_path FROM public.characters template WHERE template.id=_grant.template_character_id),';
BEGIN
  SELECT pg_get_functiondef('public.get_summon_details(uuid)'::regprocedure)
  INTO _definition;
  IF strpos(_definition,_old)=0 THEN
    RAISE EXCEPTION 'Estrutura do detalhe de invocação mudou. Revise a imagem.';
  END IF;
  EXECUTE replace(_definition,_old,_new);
END;
$patch$;
