-- Restore the DoT immunity predicate and apply it to all DoT entry points,
-- not only ability attacks. Does not modify modern DoT resistance mechanics.
BEGIN;
CREATE OR REPLACE FUNCTION public.character_is_immune_to_dot(_target_character_id uuid, _battle_id uuid, _dot jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.battle_effects e
    WHERE e.character_id = _target_character_id
      AND e.effect_type = 'dot_immunity'
      AND e.duration > 0
      AND (e.battle_id IS NULL OR e.battle_id = _battle_id)
      AND CASE COALESCE(e.effect_data->>'dot_immunity_scope','all')
        WHEN 'all' THEN true
        WHEN 'physical' THEN COALESCE(_dot->>'damage_kind',_dot->>'dot_damage_kind') = 'physical'
        WHEN 'magical' THEN COALESCE(_dot->>'damage_kind',_dot->>'dot_damage_kind') = 'magical'
        WHEN 'specific' THEN EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(e.effect_data->'dot_immunity_template_ids') = 'array'
              THEN e.effect_data->'dot_immunity_template_ids' ELSE '[]'::jsonb END
          ) selected(value)
          WHERE selected.value = COALESCE(_dot->>'dot_template_id',_dot->>'id',_dot->>'template_id')
        )
        ELSE false
      END
  ) OR EXISTS (
    SELECT 1 FROM public.character_abilities ca
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(ca.passive_effects) = 'array' THEN ca.passive_effects ELSE '[]'::jsonb END
    ) AS configured(effect)
    WHERE ca.character_id = _target_character_id
      AND configured.effect->>'effect_type' = 'dot_immunity'
      AND CASE COALESCE(configured.effect->>'dot_immunity_scope','all')
        WHEN 'all' THEN true
        WHEN 'physical' THEN COALESCE(_dot->>'damage_kind',_dot->>'dot_damage_kind') = 'physical'
        WHEN 'magical' THEN COALESCE(_dot->>'damage_kind',_dot->>'dot_damage_kind') = 'magical'
        WHEN 'specific' THEN EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(configured.effect->'dot_immunity_template_ids') = 'array'
              THEN configured.effect->'dot_immunity_template_ids' ELSE '[]'::jsonb END
          ) selected(value)
          WHERE selected.value = COALESCE(_dot->>'dot_template_id',_dot->>'id',_dot->>'template_id')
        )
        ELSE false
      END
  );
$function$
;
REVOKE ALL ON FUNCTION public.character_is_immune_to_dot(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.prevent_immune_dot_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.effect_type = 'damage_over_time' AND public.character_is_immune_to_dot(
    NEW.character_id, NEW.battle_id, COALESCE(NEW.effect_data, '{}'::jsonb)
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.prevent_immune_dot_insert() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS battle_effects_prevent_immune_dots ON public.battle_effects;
CREATE TRIGGER battle_effects_prevent_immune_dots BEFORE INSERT ON public.battle_effects
FOR EACH ROW EXECUTE FUNCTION public.prevent_immune_dot_insert();
COMMIT;
