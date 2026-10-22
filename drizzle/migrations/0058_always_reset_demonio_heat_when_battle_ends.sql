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

  -- Reset the heat belonging to characters who participated in this battle.
  -- The state is stored on the ability assignment, so remove only this key and
  -- preserve all unrelated custom state on the ability.
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
    );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;
