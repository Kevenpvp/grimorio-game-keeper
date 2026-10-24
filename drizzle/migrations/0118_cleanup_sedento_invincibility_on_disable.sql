-- End scripted invincibility together with its sustained source.
DO $patch$
DECLARE
  _definition text;
  _anchor text := E' END LOOP;\n\n UPDATE public.character_abilities';
  _insert text := E' END LOOP;\n\n -- The bloodthirst script can create a short-lived Invencível outside\n -- the ordinary activation group. Turning off the sustained ability\n -- must remove only that ability\'s own scripted shield.\n DELETE FROM public.battle_effects e\n WHERE e.source_character_ability_id=_a.id\n   AND e.battle_id=_battle_id\n   AND e.effect_type=\'invincible\'\n   AND e.effect_data->>\'sedento_invencibilidade\'=\'true\';\n\n UPDATE public.character_abilities';
BEGIN
  SELECT pg_get_functiondef('public.turn_off_character_ability(uuid,uuid)'::regprocedure) INTO _definition;
  IF position(_anchor IN _definition) = 0 THEN RAISE EXCEPTION 'Deactivation cleanup anchor changed'; END IF;
  _definition := replace(_definition, _anchor, _insert);
  EXECUTE _definition;
END;
$patch$;

CREATE OR REPLACE FUNCTION public.remove_sedento_shield_when_leaving_battle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
BEGIN
  DELETE FROM public.battle_effects e
  WHERE e.character_id=OLD.character_id
    AND e.battle_id=OLD.battle_id
    AND e.effect_type='invincible'
    AND e.effect_data->>'sedento_invencibilidade'='true';
  RETURN OLD;
END;
$fn$;
DROP TRIGGER IF EXISTS participants_cleanup_sedento_shield ON public.battle_participants;
CREATE TRIGGER participants_cleanup_sedento_shield
AFTER DELETE ON public.battle_participants
FOR EACH ROW EXECUTE FUNCTION public.remove_sedento_shield_when_leaving_battle();
REVOKE ALL ON FUNCTION public.remove_sedento_shield_when_leaving_battle() FROM PUBLIC,anon,authenticated;