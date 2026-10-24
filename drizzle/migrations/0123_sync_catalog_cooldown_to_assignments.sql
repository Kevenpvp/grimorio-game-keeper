-- Synchronize catalog cooldown edits to already-assigned abilities only if
-- their cooldown still matches the previous catalog value. Respect personal overrides.
CREATE OR REPLACE FUNCTION public.sync_catalog_ability_cooldown_to_assignments()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.cooldown_turns IS NOT DISTINCT FROM OLD.cooldown_turns THEN
    RETURN NEW;
  END IF;

  -- Only follow the catalog for sheets that still use its *previous* value.
  -- Preserve explicit character-specific cooldowns that differ from the model.
  UPDATE public.character_abilities ca
  SET cooldown_turns = CASE WHEN ca.can_activate THEN NEW.cooldown_turns ELSE 0 END,
      cooldown_remaining = CASE
        WHEN ca.can_activate THEN LEAST(ca.cooldown_remaining, NEW.cooldown_turns)
        ELSE 0
      END
  WHERE ca.ability_id = NEW.id
    AND ca.cooldown_turns = OLD.cooldown_turns
    AND (
      ca.cooldown_turns IS DISTINCT FROM CASE WHEN ca.can_activate THEN NEW.cooldown_turns ELSE 0 END
      OR ca.cooldown_remaining > NEW.cooldown_turns
    );
  RETURN NEW;
END;
$function$

DROP TRIGGER IF EXISTS abilities_sync_catalog_cooldown_to_assignments ON public.abilities;
CREATE TRIGGER abilities_sync_catalog_cooldown_to_assignments
AFTER UPDATE OF cooldown_turns ON public.abilities
FOR EACH ROW EXECUTE FUNCTION public.sync_catalog_ability_cooldown_to_assignments();
REVOKE ALL ON FUNCTION public.sync_catalog_ability_cooldown_to_assignments()
FROM PUBLIC, anon, authenticated;

-- Repair the stale 1-turn assignment of the existing Sedento por Sangue model,
-- whose catalog was already set to 0. No hardcoded character or ability UUIDs.
UPDATE public.character_abilities ca
SET cooldown_turns=0,cooldown_remaining=0
FROM public.abilities a
WHERE a.id=ca.ability_id
AND lower(a.name)='sedento por sangue'
AND a.toggle_mode IS TRUE
AND a.can_activate IS TRUE
AND a.cooldown_turns=0
AND ca.cooldown_turns=1;
NOTIFY pgrst, 'reload schema';
