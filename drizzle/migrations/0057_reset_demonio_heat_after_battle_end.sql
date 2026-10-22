CREATE OR REPLACE FUNCTION public.reset_demonio_interno_heat_on_battle_end()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _battle_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    _battle_id := OLD.id;
  ELSE
    IF OLD.active IS DISTINCT FROM TRUE OR NEW.active IS DISTINCT FROM FALSE THEN
      RETURN NEW;
    END IF;
    _battle_id := NEW.id;
  END IF;

  -- State is stored on the ability assignment, not a battle. Remove only the
  -- Demonio Interno heat key after combat, preserving unrelated custom state.
  UPDATE public.character_abilities ca
  SET custom_state = COALESCE(ca.custom_state, '{}'::jsonb) - 'dano_superaquecimento'
  FROM public.abilities a
  WHERE a.id = ca.ability_id
    AND a.custom_script_key = 'demonio_interno'
    AND ca.custom_state ? 'dano_superaquecimento'
    AND EXISTS (
      SELECT 1
      FROM public.battle_participants bp
      WHERE bp.battle_id = _battle_id
        AND bp.character_id = ca.character_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.battle_participants bp2
      JOIN public.battles b2 ON b2.id = bp2.battle_id AND b2.active IS TRUE
      WHERE bp2.character_id = ca.character_id
        AND b2.id <> _battle_id
    );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS battles_reset_demonio_heat_after_end ON public.battles;
CREATE TRIGGER battles_reset_demonio_heat_after_end
AFTER UPDATE OF active ON public.battles
FOR EACH ROW
WHEN (OLD.active IS TRUE AND NEW.active IS FALSE)
EXECUTE FUNCTION public.reset_demonio_interno_heat_on_battle_end();

DROP TRIGGER IF EXISTS battles_reset_demonio_heat_before_delete ON public.battles;
CREATE TRIGGER battles_reset_demonio_heat_before_delete
BEFORE DELETE ON public.battles
FOR EACH ROW
EXECUTE FUNCTION public.reset_demonio_interno_heat_on_battle_end();

-- Clear stale heat from characters that are not in an active battle right now.
UPDATE public.character_abilities ca
SET custom_state = COALESCE(ca.custom_state, '{}'::jsonb) - 'dano_superaquecimento'
FROM public.abilities a
WHERE a.id = ca.ability_id
  AND a.custom_script_key = 'demonio_interno'
  AND ca.custom_state ? 'dano_superaquecimento'
  AND NOT EXISTS (
    SELECT 1
    FROM public.battle_participants bp
    JOIN public.battles b ON b.id = bp.battle_id AND b.active IS TRUE
    WHERE bp.character_id = ca.character_id
  );
