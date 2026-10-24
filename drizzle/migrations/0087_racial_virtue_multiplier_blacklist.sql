-- Exclude configured virtues from a race's numeric effect multiplier.
-- Virtues are stored by UUID so name changes do not break the exclusion.

CREATE OR REPLACE FUNCTION public.apply_racial_virtue_effect_scaling()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _base public.abilities%ROWTYPE;
  _mechanics jsonb;
  _multiplier numeric := 1;
BEGIN
  IF NEW.ability_id IS NULL OR NEW.granted_by_virtue_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT a.* INTO _base FROM public.abilities a WHERE a.id = NEW.ability_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT coalesce(r.special_mechanics, '{}'::jsonb) INTO _mechanics
  FROM public.characters c
  LEFT JOIN public.races r ON r.id = c.race_id
  WHERE c.id = NEW.character_id;

  IF coalesce((_mechanics ->> 'duplicate_virtue_effects')::boolean, false)
     AND NOT coalesce((_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(NEW.granted_by_virtue_id::text), false) THEN
    _multiplier := greatest(1, least(10, coalesce(nullif(_mechanics ->> 'virtue_effect_multiplier', '')::numeric, 2)));
  END IF;

  IF _multiplier > 1 THEN
    NEW.effects := public.scale_racial_virtue_effect_json(coalesce(_base.effects, '[]'::jsonb), _multiplier);
    NEW.passive_effects := public.scale_racial_virtue_effect_json(coalesce(_base.passive_effects, '[]'::jsonb), _multiplier);
    NEW.end_effects := public.scale_racial_virtue_effect_json(coalesce(_base.end_effects, '[]'::jsonb), _multiplier);
  ELSE
    NEW.effects := coalesce(_base.effects, '[]'::jsonb);
    NEW.passive_effects := coalesce(_base.passive_effects, '[]'::jsonb);
    NEW.end_effects := coalesce(_base.end_effects, '[]'::jsonb);
  END IF;
  RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.sync_coracao_corrompido_strength_effect_internal(_character_id uuid, _bonus_strength numeric DEFAULT NULL::numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _heat numeric := 0;
  _heart record;
  _current_effects jsonb;
  _next_effects jsonb;
  _should_apply boolean;
  _attributes jsonb;
  _configured_bonus numeric;
  _effective_bonus numeric;
  _racial_multiplier numeric;
  _bonus_scales_with_race boolean := true;
BEGIN
  IF _character_id IS NULL THEN RETURN; END IF;

  SELECT COALESCE(MAX(
    CASE
      WHEN ca.custom_state->>'dano_superaquecimento' ~ '^-?[0-9]+([.][0-9]+)?$'
        THEN GREATEST(0, (ca.custom_state->>'dano_superaquecimento')::numeric)
      ELSE 0
    END
  ), 0)
  INTO _heat
  FROM public.character_abilities ca
  JOIN public.abilities a ON a.id = ca.ability_id
  WHERE ca.character_id = _character_id
    AND (a.custom_script_key = 'demonio_interno' OR lower(btrim(a.name)) = lower('Demônio Interno'));

  FOR _heart IN
    SELECT ca.id, ca.cooldown_remaining, ca.passive_effects,
           ca.custom_attributes AS character_custom_attributes,
           ca.granted_by_virtue_id,
           a.custom_attributes AS catalog_custom_attributes,
           r.special_mechanics
    FROM public.character_abilities ca
    JOIN public.abilities a ON a.id = ca.ability_id
    JOIN public.characters c ON c.id = ca.character_id
    LEFT JOIN public.races r ON r.id = c.race_id
    WHERE ca.character_id = _character_id
      AND (a.custom_script_key = 'coracao_corrompido' OR lower(btrim(a.name)) = lower('Coração Corrompido'))
  LOOP
    _attributes := CASE
      WHEN jsonb_typeof(_heart.character_custom_attributes) = 'array' THEN _heart.character_custom_attributes
      WHEN jsonb_typeof(_heart.catalog_custom_attributes) = 'array' THEN _heart.catalog_custom_attributes
      ELSE '[]'::jsonb
    END;

    IF _bonus_strength IS NOT NULL THEN
      _effective_bonus := _bonus_strength; -- The trusted Edge Function already applies the racial multiplier.
    ELSE
      SELECT COALESCE(MAX(
        CASE
          WHEN lower(regexp_replace(coalesce(attr.value->>'key', ''), '[^a-zA-Z0-9]', '', 'g')) = 'forcabonus'
            AND attr.value->>'type' = 'number'
            AND COALESCE(attr.value->>'value', '') ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN (attr.value->>'value')::numeric
          ELSE NULL
        END
      ), 0)
      INTO _configured_bonus
      FROM jsonb_array_elements(_attributes) AS attr(value);

      SELECT COALESCE(bool_or(coalesce((attr.value->>'scale_with_race')::boolean, true)), true)
      INTO _bonus_scales_with_race
      FROM jsonb_array_elements(_attributes) AS attr(value)
      WHERE lower(regexp_replace(coalesce(attr.value->>'key', ''), '[^a-zA-Z0-9]', '', 'g')) = 'forcabonus'
        AND attr.value->>'type' = 'number';

      _racial_multiplier := 1;
      IF _heart.granted_by_virtue_id IS NOT NULL
         AND _bonus_scales_with_race
         AND coalesce((_heart.special_mechanics->>'duplicate_virtue_effects')::boolean, false)
         AND NOT coalesce((_heart.special_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_heart.granted_by_virtue_id::text), false) THEN
        _racial_multiplier := greatest(1, least(10, coalesce(nullif(_heart.special_mechanics->>'virtue_effect_multiplier', '')::numeric, 2)));
      END IF;
      _effective_bonus := coalesce(_configured_bonus, 0) * _racial_multiplier;
    END IF;
    _effective_bonus := LEAST(1000000, GREATEST(0, COALESCE(_effective_bonus, 0)));

    _current_effects := CASE
      WHEN jsonb_typeof(COALESCE(_heart.passive_effects, '[]'::jsonb)) = 'array' THEN COALESCE(_heart.passive_effects, '[]'::jsonb)
      ELSE '[]'::jsonb
    END;

    SELECT COALESCE(jsonb_agg(item.effect ORDER BY item.ordinality), '[]'::jsonb)
    INTO _next_effects
    FROM jsonb_array_elements(_current_effects) WITH ORDINALITY AS item(effect, ordinality)
    WHERE item.effect->>'special_modifier_key' IS DISTINCT FROM 'coracao_corrompido_demonio_strength';

    _should_apply := COALESCE(_heart.cooldown_remaining, 0) > 0 AND _heat > 0 AND _effective_bonus > 0;
    IF _should_apply THEN
      _next_effects := _next_effects || jsonb_build_array(jsonb_build_object(
        'name', 'Coração Corrompido — Força do Demônio Interno',
        'effect_type', 'status', 'attribute_key', 'strength', 'polarity', 'buff',
        'value_mode', 'fixed', 'amount', _effective_bonus, 'duration', 1,
        'damage_scope', 'any', 'special_modifier_key', 'coracao_corrompido_demonio_strength'
      ));
    END IF;

    IF _current_effects IS DISTINCT FROM _next_effects THEN
      UPDATE public.character_abilities SET passive_effects = _next_effects WHERE id = _heart.id;
    END IF;
  END LOOP;
END;
$function$;


-- Servers should multiply every virtue except Corpo by default.
UPDATE public.races r
SET special_mechanics = coalesce(r.special_mechanics, '{}'::jsonb)
  || jsonb_build_object(
    'virtue_effect_blacklist',
    coalesce(
      (SELECT jsonb_agg(v.id::text) FROM public.virtues v WHERE lower(btrim(v.name)) = 'corpo'),
      '[]'::jsonb
    )
  )
WHERE lower(btrim(r.name)) = 'servers';

-- Re-run the trait grant trigger after applying the exclusion to existing Servers characters.
UPDATE public.character_abilities ca
SET granted_by_virtue_id = ca.granted_by_virtue_id
FROM public.characters c
JOIN public.races r ON r.id = c.race_id
WHERE ca.character_id = c.id
  AND lower(btrim(r.name)) = 'servers'
  AND ca.granted_by_virtue_id = c.virtue_id
  AND ca.ability_id IS NOT NULL;
