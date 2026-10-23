-- Cooldown ticks should not recompute Mana and Coracao effects for unrelated ability-row updates.
DROP TRIGGER IF EXISTS character_abilities_refresh_mana_no_mana ON public.character_abilities;
DROP TRIGGER IF EXISTS character_abilities_refresh_mana_no_mana_insert_delete ON public.character_abilities;
DROP TRIGGER IF EXISTS character_abilities_refresh_mana_no_mana_update ON public.character_abilities;

CREATE TRIGGER character_abilities_refresh_mana_no_mana_insert_delete
AFTER INSERT OR DELETE ON public.character_abilities
FOR EACH ROW EXECUTE FUNCTION public.refresh_mana_after_character_ability_change();

CREATE TRIGGER character_abilities_refresh_mana_no_mana_update
AFTER UPDATE OF character_id, ability_id, can_activate, passive_effects ON public.character_abilities
FOR EACH ROW EXECUTE FUNCTION public.refresh_mana_after_character_ability_change();

CREATE OR REPLACE FUNCTION public.handle_coracao_corrompido_strength_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _character_id uuid;
  _old_character_id uuid;
  _ability_id uuid;
  _script_key text;
  _ability_name text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    _character_id := OLD.character_id;
    _ability_id := OLD.ability_id;
  ELSE
    _character_id := NEW.character_id;
    _ability_id := NEW.ability_id;
  END IF;

  SELECT a.custom_script_key, a.name
  INTO _script_key, _ability_name
  FROM public.abilities a
  WHERE a.id = _ability_id;

  -- This trigger also observes cooldown updates on ordinary abilities. Those do not
  -- affect Coracao Corrompido, so skip the expensive character-wide sync for them.
  IF COALESCE(_script_key, '') <> 'coracao_corrompido'
     AND lower(COALESCE(_ability_name, '')) NOT IN ('coração corrompido', 'coracao corrompido') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.character_id IS DISTINCT FROM NEW.character_id THEN
    _old_character_id := OLD.character_id;
    PERFORM public.sync_coracao_corrompido_strength_effect(_old_character_id);
  END IF;

  PERFORM public.sync_coracao_corrompido_strength_effect(_character_id);

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
