-- All damage kinds (physical, magical, hybrid, critical) use the same
-- effective defenses displayed to players. Physical is further scaled by Corpo.
-- The helper accounts for race/class/virtue bonuses, personal class modifiers,
-- class/race/virtue physical allocations, and active & passive status effects.
CREATE OR REPLACE FUNCTION public.calculate_character_effective_defense(_character_id uuid, _attribute_key text, _battle_id uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _char record;
  _race_mechanics jsonb := '{}'::jsonb;
  _class_mechanics jsonb := '{}'::jsonb;
  _virtue_multiplier numeric := 1;
  _trait_points numeric := 0;
  _extra_physical_points numeric := 0;
  _base numeric := 0;
  _fixed numeric := 0;
  _percent numeric := 0;
  _result numeric := 0;
BEGIN
  IF _attribute_key NOT IN ('phys_def','mag_def') THEN
    RAISE EXCEPTION 'O cálculo de defesa só aceita phys_def ou mag_def';
  END IF;

  SELECT
    d.accepts_points, d.base_value, d.points_multiplier,
    a.points, a.max_value, a.bonus,
    c.body, c.virtue_id, c.class_id,
    COALESCE(c.class_custom_modifiers,'{}'::jsonb) AS custom_class,
    COALESCE(c.race_physical_allocations,'{}'::jsonb) AS physical_race,
    COALESCE(c.virtue_physical_allocations,'{}'::jsonb) AS physical_virtue,
    COALESCE(c.class_physical_allocations,'{}'::jsonb) AS physical_class,
    COALESCE(r.modifiers,'{}'::jsonb) AS race_mods,
    COALESCE(v.modifiers,'{}'::jsonb) AS virtue_mods,
    COALESCE(cl.modifiers,'{}'::jsonb) AS class_mods,
    COALESCE(r.special_mechanics,'{}'::jsonb) AS race_mechanics,
    COALESCE(cl.special_mechanics,'{}'::jsonb) AS class_mechanics
  INTO _char
  FROM public.characters c
  JOIN public.character_attributes a
    ON a.character_id=c.id AND a.attribute_key=_attribute_key
  JOIN public.attribute_definitions d ON d.key=a.attribute_key
  LEFT JOIN public.races r ON r.id=c.race_id
  LEFT JOIN public.virtues v ON v.id=c.virtue_id
  LEFT JOIN public.classes cl ON cl.id=c.class_id
  WHERE c.id=_character_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  _race_mechanics := _char.race_mechanics;
  _class_mechanics := _char.class_mechanics;

  -- Virtue trait modifiers may be multiplied by the race and/or class.
  IF _char.virtue_id IS NOT NULL THEN
    IF COALESCE((_race_mechanics->>'duplicate_virtue_effects')::boolean,FALSE)
       AND NOT COALESCE((_race_mechanics->'virtue_effect_blacklist') @>
           jsonb_build_array(_char.virtue_id::text),FALSE) THEN
      _virtue_multiplier := _virtue_multiplier *
        GREATEST(1,LEAST(10,COALESCE(NULLIF(_race_mechanics->>'virtue_effect_multiplier','')::numeric,2)));
    END IF;
    IF COALESCE((_class_mechanics->>'duplicate_virtue_effects')::boolean,FALSE)
       AND NOT COALESCE((_class_mechanics->'virtue_effect_blacklist') @>
           jsonb_build_array(_char.virtue_id::text),FALSE) THEN
      _virtue_multiplier := _virtue_multiplier *
        GREATEST(1,LEAST(10,COALESCE(NULLIF(_class_mechanics->>'virtue_effect_multiplier','')::numeric,2)));
    END IF;
    _virtue_multiplier := LEAST(100,_virtue_multiplier);
  END IF;

  _trait_points :=
      COALESCE(NULLIF(_char.race_mods->>_attribute_key,'')::numeric,0)
    + COALESCE(NULLIF(_char.virtue_mods->>_attribute_key,'')::numeric,0)*_virtue_multiplier
    + COALESCE(NULLIF(_char.class_mods->>_attribute_key,'')::numeric,0)
    + CASE WHEN _char.class_id IS NOT NULL
      THEN COALESCE(NULLIF(_char.custom_class->>_attribute_key,'')::numeric,0)
      ELSE 0 END;

  _extra_physical_points :=
      COALESCE(NULLIF(_char.physical_race->>_attribute_key,'')::numeric,0)
    + COALESCE(NULLIF(_char.physical_virtue->>_attribute_key,'')::numeric,0)
    + COALESCE(NULLIF(_char.physical_class->>_attribute_key,'')::numeric,0);

  IF _char.accepts_points THEN
    _base := ROUND((
      COALESCE(_char.base_value,0)
      + (COALESCE(_char.points,0) + _trait_points + _extra_physical_points)
          * COALESCE(_char.points_multiplier,1)
    ) * 100) / 100 + COALESCE(_char.bonus,0);
  ELSE
    _base := COALESCE(_char.max_value,0) + _trait_points + COALESCE(_char.bonus,0);
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN buffs.value_mode='fixed' THEN buffs.signed_amount ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN buffs.value_mode='percent' THEN buffs.signed_amount ELSE 0 END),0)
  INTO _fixed,_percent
  FROM (
    SELECT e.value_mode,
      CASE WHEN e.polarity='buff' THEN e.amount ELSE -e.amount END AS signed_amount
    FROM public.battle_effects e
    WHERE e.character_id=_character_id
      AND e.effect_type='status'
      AND e.attribute_key=_attribute_key
      AND e.duration>0
      AND (
        (e.battle_id IS NULL)
        OR (e.battle_id=_battle_id AND EXISTS (
          SELECT 1 FROM public.battles b WHERE b.id=e.battle_id AND b.active
        ))
      )
    UNION ALL
    SELECT
      COALESCE(passive.effect->>'value_mode','fixed') AS value_mode,
      CASE WHEN COALESCE(passive.effect->>'polarity','buff')='buff'
        THEN COALESCE(NULLIF(passive.effect->>'amount','')::numeric,0)
        ELSE -COALESCE(NULLIF(passive.effect->>'amount','')::numeric,0)
      END AS signed_amount
    FROM public.character_abilities ca
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(ca.passive_effects)='array'
        THEN ca.passive_effects ELSE '[]'::jsonb END
    ) passive(effect)
    WHERE ca.character_id=_character_id
      AND passive.effect->>'effect_type'='status'
      AND passive.effect->>'attribute_key'=_attribute_key
  ) buffs;

  -- Preserve the UI's order of operations: fixed buffs, percentage buffs,
  -- then the Corpo penalty (only for physical defense).
  _result := GREATEST(0,FLOOR((_base+_fixed)*(1+_percent/100)));
  IF _attribute_key='phys_def' THEN
    _result := GREATEST(0,ROUND(_result * GREATEST(0,LEAST(100,COALESCE(_char.body,100))))/100);
  END IF;
  RETURN _result;
END;
$function$
;
REVOKE ALL ON FUNCTION public.calculate_character_effective_defense(uuid,text,uuid)
FROM PUBLIC,anon,authenticated;
-- Replace only the legacy defense lookup; preserve the rest of damage mechanics.
DO $patch$
DECLARE
  _definition text;
  _start_marker text := '  -- Compute physical and magical defense once; hybrid damage uses both.';
  _end_marker text := '  _magical_defense := GREATEST(0, COALESCE(_magical_defense, 0));';
  _start int;
  _finish int;
  _replacement text := E'  -- Use effective defense including buffs, passives, class/race/virtue bonuses.\n'
    || E'  SELECT public.calculate_character_effective_defense(_character_id,\'phys_def\',_battle_id),\n'
    || E'         public.calculate_character_effective_defense(_character_id,\'mag_def\',_battle_id)\n'
    || E'  INTO _physical_defense,_magical_defense;';
BEGIN
  SELECT pg_get_functiondef(
    'public.apply_battle_damage(uuid,uuid,text,uuid,jsonb,text,uuid,uuid)'::regprocedure
  ) INTO _definition;
  _start := POSITION(_start_marker IN _definition);
  _finish := POSITION(_end_marker IN _definition);
  IF _start>0 AND _finish>_start THEN
    _finish := _finish + LENGTH(_end_marker);
    _definition := SUBSTRING(_definition,1,_start-1)
      || _replacement || SUBSTRING(_definition,_finish);
    EXECUTE _definition;
  ELSIF POSITION('calculate_character_effective_defense(_character_id' IN _definition)=0 THEN
    RAISE EXCEPTION 'Não encontrei a rotina de defesa esperada em apply_battle_damage';
  END IF;
END;
$patch$;
