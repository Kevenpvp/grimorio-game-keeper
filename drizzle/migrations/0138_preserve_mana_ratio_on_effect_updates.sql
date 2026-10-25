-- Keep the base Mana maximum in sync for No Mana transitions, but never
-- clamp its current value on unrelated battle-effect changes. The existing
-- scale_resource_on_battle_effect_change trigger adjusts current Mana
-- proportionally to the effective maximum after each HP/Mana status effect.
-- Previously, adding a subsequent non-Mana buff reset 1620/1620 to 1600/1620.
CREATE OR REPLACE FUNCTION public.refresh_character_mana_for_no_mana(_character_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _base_max integer;
BEGIN
  IF public.character_has_no_mana(_character_id) THEN
    -- Preserve the original Sem Mana behavior, avoiding redundant updates.
    UPDATE public.character_attributes
    SET current_value = 0,
        max_value = 0,
        updated_at = now()
    WHERE character_id = _character_id AND attribute_key = 'mana'
      AND (current_value IS DISTINCT FROM 0 OR max_value IS DISTINCT FROM 0);
    RETURN;
  END IF;

  -- This is the stored *base* maximum, not the effective maximum with
  -- temporary status effects. Those effects are already accounted for by
  -- calculate_character_resource_max / scale_character_resource_current.
  SELECT GREATEST(0, ROUND(
    COALESCE(ad.base_value, 0)
      + (ca.points
         + COALESCE((r.modifiers->>'mana')::numeric, 0)
         + COALESCE((v.modifiers->>'mana')::numeric, 0))
          * COALESCE(ad.points_multiplier, 1)
      + ca.bonus
  ))::integer
  INTO _base_max
  FROM public.character_attributes ca
  JOIN public.attribute_definitions ad ON ad.key = ca.attribute_key
  JOIN public.characters c ON c.id = ca.character_id
  LEFT JOIN public.races r ON r.id = c.race_id
  LEFT JOIN public.virtues v ON v.id = c.virtue_id
  WHERE ca.character_id = _character_id AND ca.attribute_key = 'mana';

  IF _base_max IS NOT NULL THEN
    -- Do not change current_value or cap it to _base_max. On INSERT/DELETE of
    -- status effects, the resource-scaling trigger runs later in the same
    -- statement and needs the pre-change current value to preserve the ratio.
    -- Skip unchanged base maxima so unrelated buffs never touch Mana.
    UPDATE public.character_attributes
    SET max_value = _base_max, updated_at = now()
    WHERE character_id = _character_id AND attribute_key = 'mana'
      AND max_value IS DISTINCT FROM _base_max;
  END IF;
END;
$function$;
