-- Protect battle-script event insertion from stale battle IDs during deletion.
-- Keep post-defense damage available to scripts when Invencível prevents HP loss.
-- Read the Coração Corrompido's ForcaBonus attribute instead of hard-coding +20.

-- queue_ability_script_event
CREATE OR REPLACE FUNCTION public.queue_ability_script_event(_event_type text, _character_ability_id uuid, _character_id uuid, _battle_id uuid DEFAULT NULL::uuid, _target_character_id uuid DEFAULT NULL::uuid, _effect_id uuid DEFAULT NULL::uuid, _payload jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _ability_id uuid;
  _script_key text;
  _event_id uuid;
  _valid_battle_id uuid;
BEGIN
  SELECT a.id, a.custom_script_key
  INTO _ability_id, _script_key
  FROM public.character_abilities ca
  JOIN public.abilities a ON a.id = ca.ability_id
  WHERE ca.id = _character_ability_id;

  IF NOT FOUND OR NULLIF(trim(_script_key), '') IS NULL THEN
    RETURN NULL;
  END IF;

  IF _battle_id IS NOT NULL THEN
    SELECT b.id INTO _valid_battle_id
    FROM public.battles b WHERE b.id = _battle_id FOR KEY SHARE;
    _battle_id := _valid_battle_id;
  END IF;

  INSERT INTO public.ability_script_events (
    event_type, script_key, ability_id, character_ability_id, battle_id,
    character_id, target_character_id, effect_id, payload
  ) VALUES (
    _event_type, _script_key, _ability_id, _character_ability_id, _battle_id,
    _character_id, _target_character_id, _effect_id, COALESCE(_payload, '{}'::jsonb)
  )
  RETURNING id INTO _event_id;

  RETURN _event_id;
END;
$function$
;

-- apply_battle_damage
CREATE OR REPLACE FUNCTION public.apply_battle_damage(_battle_id uuid, _character_id uuid, _damage_kind text, _damage_type_id uuid, _damage_values jsonb, _magic_level text, _source_character_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _physical_defense numeric := 0;
  _magical_defense numeric := 0;
  _hp_before integer;
  _hp_after integer;
  _total_damage integer := 0;
  _hits integer := 0;
  _raw numeric;
  _rounded_raw integer;
  _dealt integer;
  _physical_part integer;
  _magical_part integer;
  _item jsonb;
  _damage_fixed_modifier numeric := 0;
  _damage_percent_modifier numeric := 0;
  _damage_any_fixed numeric := 0;
  _damage_any_percent numeric := 0;
  _damage_physical_fixed numeric := 0;
  _damage_physical_percent numeric := 0;
  _damage_magical_fixed numeric := 0;
  _damage_magical_percent numeric := 0;
  _physical_reduction_fixed numeric := 0;
  _physical_reduction_percent numeric := 0;
  _magical_reduction_fixed numeric := 0;
  _magical_reduction_percent numeric := 0;
  _final_damage_by_hit jsonb := '[]'::jsonb;
  _damage_without_invincible_by_hit jsonb := '[]'::jsonb;
  _is_invincible boolean := false;
  _source_race_id uuid;
  _damage_received_any_fixed numeric := 0;
  _damage_received_any_percent numeric := 0;
  _damage_received_physical_fixed numeric := 0;
  _damage_received_physical_percent numeric := 0;
  _damage_received_magical_fixed numeric := 0;
  _damage_received_magical_percent numeric := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode aplicar dano';
  END IF;

  IF _damage_kind IS NULL OR _damage_kind NOT IN ('physical', 'magical', 'hybrid', 'true') THEN
    RAISE EXCEPTION 'Tipo de dano inválido';
  END IF;

  IF _damage_values IS NULL
     OR jsonb_typeof(_damage_values) IS DISTINCT FROM 'array'
     OR jsonb_array_length(_damage_values) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Informe de 1 a 200 valores de dano';
  END IF;

  IF _battle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.battle_participants
    WHERE battle_id = _battle_id AND character_id = _character_id
  ) THEN
    RAISE EXCEPTION 'O alvo não participa desta batalha';
  END IF;

  IF _source_character_id IS NOT NULL THEN
    IF _source_character_id = _character_id THEN
      RAISE EXCEPTION 'A origem do dano precisa ser diferente do alvo';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.characters WHERE id = _source_character_id) THEN
      RAISE EXCEPTION 'Personagem de origem do dano não encontrado';
    END IF;
    SELECT c.race_id INTO _source_race_id
    FROM public.characters c
    WHERE c.id = _source_character_id;
    IF _battle_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.battle_participants
      WHERE battle_id = _battle_id AND character_id = _source_character_id
    ) THEN
      RAISE EXCEPTION 'A origem do dano não participa desta batalha';
    END IF;

    -- Read temporary modifiers from effects and persistent modifiers from passive abilities.
    SELECT
      COALESCE(SUM(CASE WHEN modifiers.damage_scope = 'any' AND modifiers.value_mode = 'fixed' THEN modifiers.signed_amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN modifiers.damage_scope = 'any' AND modifiers.value_mode = 'percent' THEN modifiers.signed_amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN modifiers.damage_scope = 'physical' AND modifiers.value_mode = 'fixed' THEN modifiers.signed_amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN modifiers.damage_scope = 'physical' AND modifiers.value_mode = 'percent' THEN modifiers.signed_amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN modifiers.damage_scope = 'magical' AND modifiers.value_mode = 'fixed' THEN modifiers.signed_amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN modifiers.damage_scope = 'magical' AND modifiers.value_mode = 'percent' THEN modifiers.signed_amount ELSE 0 END), 0)
    INTO
      _damage_any_fixed, _damage_any_percent,
      _damage_physical_fixed, _damage_physical_percent,
      _damage_magical_fixed, _damage_magical_percent
    FROM (
      SELECT
        e.value_mode,
        COALESCE(e.damage_scope, 'any') AS damage_scope,
        CASE WHEN e.polarity = 'buff' THEN e.amount ELSE -e.amount END AS signed_amount
      FROM public.battle_effects e
      WHERE e.character_id = _source_character_id
        AND e.effect_type = 'damage_dealt'
        AND e.duration > 0
        AND (e.battle_id IS NULL OR e.battle_id = _battle_id)

      UNION ALL

      SELECT
        COALESCE(passive.effect->>'value_mode', 'fixed') AS value_mode,
        CASE WHEN COALESCE(passive.effect->>'damage_scope', 'any') IN ('physical', 'magical')
          THEN passive.effect->>'damage_scope' ELSE 'any' END AS damage_scope,
        CASE WHEN COALESCE(passive.effect->>'polarity', 'buff') = 'buff'
          THEN COALESCE(NULLIF(passive.effect->>'amount', '')::numeric, 0)
          ELSE -COALESCE(NULLIF(passive.effect->>'amount', '')::numeric, 0)
        END AS signed_amount
      FROM public.character_abilities ca
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ca.passive_effects, '[]'::jsonb)) AS passive(effect)
      WHERE ca.character_id = _source_character_id
        AND passive.effect->>'effect_type' = 'damage_dealt'
    ) AS modifiers;

    -- Report the modifiers relevant to the selected damage category.
    IF _damage_kind = 'physical' THEN
      _damage_fixed_modifier := _damage_any_fixed + _damage_physical_fixed;
      _damage_percent_modifier := _damage_any_percent + _damage_physical_percent;
    ELSIF _damage_kind = 'magical' THEN
      _damage_fixed_modifier := _damage_any_fixed + _damage_magical_fixed;
      _damage_percent_modifier := _damage_any_percent + _damage_magical_percent;
    ELSIF _damage_kind = 'hybrid' THEN
      _damage_fixed_modifier := _damage_any_fixed + _damage_physical_fixed + _damage_magical_fixed;
      _damage_percent_modifier := _damage_any_percent + _damage_physical_percent + _damage_magical_percent;
    ELSE
      -- True damage is its own category; only "any" modifiers apply to it.
      _damage_fixed_modifier := _damage_any_fixed;
      _damage_percent_modifier := _damage_any_percent;
    END IF;
  END IF;

  IF _damage_kind IN ('magical', 'hybrid') THEN
    IF _damage_type_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.damage_types WHERE id = _damage_type_id
    ) THEN
      RAISE EXCEPTION 'Selecione um tipo de dano mágico válido';
    END IF;
    IF _magic_level IS NULL OR _magic_level NOT IN ('baixa', 'media', 'alta') THEN
      RAISE EXCEPTION 'Selecione o nível da magia: baixa, média ou alta';
    END IF;
  ELSIF _magic_level IS NOT NULL THEN
    RAISE EXCEPTION 'Nível de magia só pode ser usado em dano mágico ou híbrido';
  END IF;

  -- Incoming mitigation supports multiple selected types/grades; empty arrays mean "all".
  SELECT
    COALESCE(SUM(CASE WHEN r.damage_reduction_scope = 'physical'
      AND _damage_kind IN ('physical','hybrid') AND r.value_mode = 'fixed' THEN r.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN r.damage_reduction_scope = 'physical'
      AND _damage_kind IN ('physical','hybrid') AND r.value_mode = 'percent' THEN r.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN r.damage_reduction_scope = 'magical'
      AND _damage_kind IN ('magical','hybrid')
      AND _damage_type_id IS NOT NULL AND _magic_level IS NOT NULL
      AND COALESCE(
        cardinality(r.damage_reduction_type_ids) = 0 OR _damage_type_id = ANY(r.damage_reduction_type_ids),
        r.damage_reduction_type_id = _damage_type_id
      )
      AND COALESCE(
        cardinality(r.damage_reduction_magic_levels) = 0 OR _magic_level = ANY(r.damage_reduction_magic_levels),
        r.damage_reduction_magic_level = _magic_level
      )
      AND r.value_mode = 'fixed' THEN r.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN r.damage_reduction_scope = 'magical'
      AND _damage_kind IN ('magical','hybrid')
      AND _damage_type_id IS NOT NULL AND _magic_level IS NOT NULL
      AND COALESCE(
        cardinality(r.damage_reduction_type_ids) = 0 OR _damage_type_id = ANY(r.damage_reduction_type_ids),
        r.damage_reduction_type_id = _damage_type_id
      )
      AND COALESCE(
        cardinality(r.damage_reduction_magic_levels) = 0 OR _magic_level = ANY(r.damage_reduction_magic_levels),
        r.damage_reduction_magic_level = _magic_level
      )
      AND r.value_mode = 'percent' THEN r.amount ELSE 0 END), 0)
  INTO _physical_reduction_fixed, _physical_reduction_percent,
       _magical_reduction_fixed, _magical_reduction_percent
  FROM (
    SELECT e.damage_reduction_scope, e.damage_reduction_type_id, e.damage_reduction_magic_level,
           e.damage_reduction_type_ids, e.damage_reduction_magic_levels,
           e.value_mode, e.amount, e.polarity
    FROM public.battle_effects e
    WHERE e.character_id = _character_id
      AND e.effect_type = 'damage_reduction'
      AND e.duration > 0
      AND (e.battle_id IS NULL OR e.battle_id = _battle_id)

    UNION ALL

    SELECT
      COALESCE(passive.effect->>'damage_reduction_scope', 'physical') AS damage_reduction_scope,
      NULLIF(passive.effect->>'damage_reduction_type_id', '')::uuid AS damage_reduction_type_id,
      passive.effect->>'damage_reduction_magic_level' AS damage_reduction_magic_level,
      CASE
        WHEN jsonb_typeof(passive.effect->'damage_reduction_type_ids') = 'array'
          THEN ARRAY(SELECT jsonb_array_elements_text(passive.effect->'damage_reduction_type_ids')::uuid)
        WHEN NULLIF(passive.effect->>'damage_reduction_type_id', '') IS NOT NULL
          THEN ARRAY[NULLIF(passive.effect->>'damage_reduction_type_id', '')::uuid]
        ELSE NULL::uuid[]
      END AS damage_reduction_type_ids,
      CASE
        WHEN jsonb_typeof(passive.effect->'damage_reduction_magic_levels') = 'array'
          THEN ARRAY(SELECT jsonb_array_elements_text(passive.effect->'damage_reduction_magic_levels'))
        WHEN NULLIF(passive.effect->>'damage_reduction_magic_level', '') IS NOT NULL
          THEN ARRAY[passive.effect->>'damage_reduction_magic_level']
        ELSE NULL::text[]
      END AS damage_reduction_magic_levels,
      COALESCE(passive.effect->>'value_mode', 'fixed') AS value_mode,
      COALESCE(NULLIF(passive.effect->>'amount', '')::numeric, 0) AS amount,
      COALESCE(passive.effect->>'polarity', 'buff') AS polarity
    FROM public.character_abilities ca
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(COALESCE(ca.passive_effects, '[]'::jsonb)) = 'array'
        THEN COALESCE(ca.passive_effects, '[]'::jsonb) ELSE '[]'::jsonb END
    ) AS passive(effect)
    WHERE ca.character_id = _character_id
      AND passive.effect->>'effect_type' = 'damage_reduction'
  ) AS r
  WHERE r.polarity = 'buff'
    AND (
      (r.damage_reduction_scope = 'physical' AND _damage_kind IN ('physical','hybrid'))
      OR (
        r.damage_reduction_scope = 'magical'
        AND _damage_kind IN ('magical','hybrid')
        AND _damage_type_id IS NOT NULL
        AND _magic_level IS NOT NULL
        AND COALESCE(
          cardinality(r.damage_reduction_type_ids) = 0 OR _damage_type_id = ANY(r.damage_reduction_type_ids),
          r.damage_reduction_type_id = _damage_type_id
        )
        AND COALESCE(
          cardinality(r.damage_reduction_magic_levels) = 0 OR _magic_level = ANY(r.damage_reduction_magic_levels),
          r.damage_reduction_magic_level = _magic_level
        )
      )
    );


  -- Dano Recebido adds vulnerability after the target's defense and mitigation.
  -- "any" and matching "race" effects modify the whole final hit, while physical
  -- and magical effects modify only the corresponding component of hybrid damage.
  SELECT
    COALESCE(SUM(CASE WHEN
      (r.damage_received_scope = 'any'
        OR (r.damage_received_scope = 'race'
          AND _source_race_id IS NOT NULL
          AND r.damage_received_race_id = _source_race_id::text))
      AND r.value_mode = 'fixed' THEN r.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN
      (r.damage_received_scope = 'any'
        OR (r.damage_received_scope = 'race'
          AND _source_race_id IS NOT NULL
          AND r.damage_received_race_id = _source_race_id::text))
      AND r.value_mode = 'percent' THEN r.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN
      r.damage_received_scope = 'physical'
      AND _damage_kind IN ('physical', 'hybrid')
      AND r.value_mode = 'fixed' THEN r.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN
      r.damage_received_scope = 'physical'
      AND _damage_kind IN ('physical', 'hybrid')
      AND r.value_mode = 'percent' THEN r.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN
      r.damage_received_scope = 'magical'
      AND _damage_kind IN ('magical', 'hybrid')
      AND (
        CASE WHEN jsonb_typeof(r.config->'damage_received_type_ids') = 'array' THEN
          jsonb_array_length(r.config->'damage_received_type_ids') = 0
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(r.config->'damage_received_type_ids') selected(value)
            WHERE selected.value = _damage_type_id::text
          )
        ELSE true END
      )
      AND (
        CASE WHEN jsonb_typeof(r.config->'damage_received_magic_levels') = 'array' THEN
          jsonb_array_length(r.config->'damage_received_magic_levels') = 0
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(r.config->'damage_received_magic_levels') selected(value)
            WHERE selected.value = _magic_level
          )
        ELSE true END
      )
      AND r.value_mode = 'fixed' THEN r.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN
      r.damage_received_scope = 'magical'
      AND _damage_kind IN ('magical', 'hybrid')
      AND (
        CASE WHEN jsonb_typeof(r.config->'damage_received_type_ids') = 'array' THEN
          jsonb_array_length(r.config->'damage_received_type_ids') = 0
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(r.config->'damage_received_type_ids') selected(value)
            WHERE selected.value = _damage_type_id::text
          )
        ELSE true END
      )
      AND (
        CASE WHEN jsonb_typeof(r.config->'damage_received_magic_levels') = 'array' THEN
          jsonb_array_length(r.config->'damage_received_magic_levels') = 0
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(r.config->'damage_received_magic_levels') selected(value)
            WHERE selected.value = _magic_level
          )
        ELSE true END
      )
      AND r.value_mode = 'percent' THEN r.amount ELSE 0 END), 0)
  INTO
    _damage_received_any_fixed, _damage_received_any_percent,
    _damage_received_physical_fixed, _damage_received_physical_percent,
    _damage_received_magical_fixed, _damage_received_magical_percent
  FROM (
    SELECT
      COALESCE(e.effect_data->>'damage_received_scope', 'any') AS damage_received_scope,
      COALESCE(e.effect_data->>'value_mode', e.value_mode) AS value_mode,
      COALESCE(NULLIF(e.effect_data->>'amount', '')::numeric, e.amount) AS amount,
      e.effect_data->>'damage_received_race_id' AS damage_received_race_id,
      COALESCE(e.effect_data, '{}'::jsonb) AS config
    FROM public.battle_effects e
    WHERE e.character_id = _character_id
      AND e.effect_type = 'damage_received'
      AND e.duration > 0
      AND (e.battle_id IS NULL OR e.battle_id = _battle_id)

    UNION ALL

    SELECT
      COALESCE(passive.effect->>'damage_received_scope', 'any') AS damage_received_scope,
      COALESCE(passive.effect->>'value_mode', 'fixed') AS value_mode,
      COALESCE(NULLIF(passive.effect->>'amount', '')::numeric, 0) AS amount,
      passive.effect->>'damage_received_race_id' AS damage_received_race_id,
      passive.effect AS config
    FROM public.character_abilities ca
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(COALESCE(ca.passive_effects, '[]'::jsonb)) = 'array'
        THEN COALESCE(ca.passive_effects, '[]'::jsonb) ELSE '[]'::jsonb END
    ) AS passive(effect)
    WHERE ca.character_id = _character_id
      AND passive.effect->>'effect_type' = 'damage_received'
  ) AS r;

  SELECT ca.current_value INTO _hp_before
  FROM public.character_attributes ca
  WHERE ca.character_id = _character_id AND ca.attribute_key = 'hp'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'O alvo não possui atributo de HP';
  END IF;

  -- Compute physical and magical defense once; hybrid damage uses both.
  SELECT
    COALESCE(MAX(CASE WHEN ad.key = 'phys_def' THEN
      CASE
        WHEN ad.accepts_points THEN
          round(ad.base_value + (ca.points + COALESCE((r.modifiers ->> ad.key)::numeric, 0) + COALESCE((v.modifiers ->> ad.key)::numeric, 0) + CASE WHEN ad.key = 'phys_def' THEN COALESCE((c.race_physical_allocations ->> 'phys_def')::numeric, 0) + COALESCE((c.virtue_physical_allocations ->> 'phys_def')::numeric, 0) ELSE 0 END) * ad.points_multiplier + ca.bonus)
        ELSE
          ca.max_value + COALESCE((r.modifiers ->> ad.key)::numeric, 0) + COALESCE((v.modifiers ->> ad.key)::numeric, 0) + ca.bonus
      END
    END), 0),
    COALESCE(MAX(CASE WHEN ad.key = 'mag_def' THEN
      CASE
        WHEN ad.accepts_points THEN
          round(ad.base_value + (ca.points + COALESCE((r.modifiers ->> ad.key)::numeric, 0) + COALESCE((v.modifiers ->> ad.key)::numeric, 0) + CASE WHEN ad.key = 'phys_def' THEN COALESCE((c.race_physical_allocations ->> 'phys_def')::numeric, 0) + COALESCE((c.virtue_physical_allocations ->> 'phys_def')::numeric, 0) ELSE 0 END) * ad.points_multiplier + ca.bonus)
        ELSE
          ca.max_value + COALESCE((r.modifiers ->> ad.key)::numeric, 0) + COALESCE((v.modifiers ->> ad.key)::numeric, 0) + ca.bonus
      END
    END), 0)
  INTO _physical_defense, _magical_defense
  FROM public.attribute_definitions ad
  JOIN public.character_attributes ca
    ON ca.attribute_key = ad.key AND ca.character_id = _character_id
  JOIN public.characters c ON c.id = ca.character_id
  LEFT JOIN public.races r ON r.id = c.race_id
  LEFT JOIN public.virtues v ON v.id = c.virtue_id
  WHERE ad.key IN ('phys_def', 'mag_def');

  -- Body applies a proportional penalty to physical defense: 100% Body = full defense.
  -- A character at 80% Body keeps 80% of their effective physical defense.
  _physical_defense := GREATEST(
    0,
    COALESCE(_physical_defense, 0)
    * COALESCE(
        (SELECT c.body::numeric FROM public.characters c WHERE c.id = _character_id),
        100::numeric
      ) / 100
  );
  _magical_defense := GREATEST(0, COALESCE(_magical_defense, 0));

  SELECT
    EXISTS (
      SELECT 1
      FROM public.battle_effects e
      WHERE e.character_id = _character_id
        AND e.effect_type = 'invincible'
        AND e.duration > 0
        AND (e.battle_id IS NULL OR e.battle_id = _battle_id)
    )
    OR EXISTS (
      SELECT 1
      FROM public.character_abilities ca
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(COALESCE(ca.passive_effects, '[]'::jsonb)) = 'array'
          THEN COALESCE(ca.passive_effects, '[]'::jsonb) ELSE '[]'::jsonb END
      ) AS passive(effect)
      WHERE ca.character_id = _character_id
        AND passive.effect->>'effect_type' = 'invincible'
    )
  INTO _is_invincible;

  FOR _item IN SELECT elem FROM jsonb_array_elements(_damage_values) AS items(elem) LOOP
    IF jsonb_typeof(_item) <> 'number' THEN
      RAISE EXCEPTION 'Cada dano precisa ser um número';
    END IF;
    _raw := (_item #>> '{}')::numeric;
    IF _raw < 0 OR _raw > 1000000 THEN
      RAISE EXCEPTION 'Cada dano deve ficar entre 0 e 1000000';
    END IF;

    IF _damage_kind = 'physical' THEN
      _rounded_raw := round(
        GREATEST(0, _raw + _damage_any_fixed + _damage_physical_fixed)
        * GREATEST(0, 1 + (_damage_any_percent + _damage_physical_percent) / 100)
      )::integer;
      _dealt := GREATEST(0, _rounded_raw - _physical_defense)::integer;
      _dealt := round(GREATEST(0, _dealt - _physical_reduction_fixed)
        * GREATEST(0, 1 - _physical_reduction_percent / 100))::integer;
      _dealt := round(GREATEST(0, _dealt + _damage_received_physical_fixed + _damage_received_any_fixed)
        * GREATEST(0, 1 + (_damage_received_physical_percent + _damage_received_any_percent) / 100))::integer;
    ELSIF _damage_kind = 'magical' THEN
      _rounded_raw := round(
        GREATEST(0, _raw + _damage_any_fixed + _damage_magical_fixed)
        * GREATEST(0, 1 + (_damage_any_percent + _damage_magical_percent) / 100)
      )::integer;
      _dealt := GREATEST(0, _rounded_raw - _magical_defense)::integer;
      _dealt := round(GREATEST(0, _dealt - _magical_reduction_fixed)
        * GREATEST(0, 1 - _magical_reduction_percent / 100))::integer;
      _dealt := round(GREATEST(0, _dealt + _damage_received_magical_fixed + _damage_received_any_fixed)
        * GREATEST(0, 1 + (_damage_received_magical_percent + _damage_received_any_percent) / 100))::integer;
    ELSIF _damage_kind = 'hybrid' THEN
      -- Apply the universal flat bonus once to the full hit before splitting it.
      -- Then apply type-specific flat bonuses to their own half, with universal and
      -- matching type-specific percentages. Odd damage assigns its extra point to magic.
      _rounded_raw := round(GREATEST(0, _raw + _damage_any_fixed))::integer;
      _physical_part := floor(_rounded_raw / 2.0)::integer;
      _magical_part := _rounded_raw - _physical_part;
      _physical_part := round(
        GREATEST(0, _physical_part + _damage_physical_fixed)
        * GREATEST(0, 1 + (_damage_any_percent + _damage_physical_percent) / 100)
      )::integer;
      _magical_part := round(
        GREATEST(0, _magical_part + _damage_magical_fixed)
        * GREATEST(0, 1 + (_damage_any_percent + _damage_magical_percent) / 100)
      )::integer;
      _physical_part := GREATEST(0, _physical_part - _physical_defense)::integer;
      _magical_part := GREATEST(0, _magical_part - _magical_defense)::integer;
      _physical_part := round(GREATEST(0, _physical_part - _physical_reduction_fixed)
        * GREATEST(0, 1 - _physical_reduction_percent / 100))::integer;
      _magical_part := round(GREATEST(0, _magical_part - _magical_reduction_fixed)
        * GREATEST(0, 1 - _magical_reduction_percent / 100))::integer;
      _physical_part := round(GREATEST(0, _physical_part + _damage_received_physical_fixed)
        * GREATEST(0, 1 + _damage_received_physical_percent / 100))::integer;
      _magical_part := round(GREATEST(0, _magical_part + _damage_received_magical_fixed)
        * GREATEST(0, 1 + _damage_received_magical_percent / 100))::integer;
      _dealt := round(GREATEST(0, _physical_part + _magical_part + _damage_received_any_fixed)
        * GREATEST(0, 1 + _damage_received_any_percent / 100))::integer;
    ELSE
      -- True damage is affected only by "any" modifiers and ignores both defenses.
      _rounded_raw := round(
        GREATEST(0, _raw + _damage_any_fixed)
        * GREATEST(0, 1 + _damage_any_percent / 100)
      )::integer;
      _dealt := round(GREATEST(0, _rounded_raw + _damage_received_any_fixed)
        * GREATEST(0, 1 + _damage_received_any_percent / 100))::integer;
    END IF;

    _damage_without_invincible_by_hit := _damage_without_invincible_by_hit || to_jsonb(_dealt);
    IF _is_invincible THEN
      _dealt := 0;
    END IF;
    _final_damage_by_hit := _final_damage_by_hit || to_jsonb(_dealt);
    _total_damage := _total_damage + _dealt;
    _hits := _hits + 1;
  END LOOP;

  _hp_after := GREATEST(0, _hp_before - _total_damage);
  UPDATE public.character_attributes
  SET current_value = _hp_after, updated_at = now()
  WHERE character_id = _character_id AND attribute_key = 'hp';

  RETURN jsonb_build_object(
    'hits', _hits,
    'physical_defense', _physical_defense,
    'magical_defense', _magical_defense,
    'total_damage', _total_damage,
    'final_damage_by_hit', _final_damage_by_hit,
    'damage_without_invincible_by_hit', _damage_without_invincible_by_hit,
    'hp_before', _hp_before,
    'hp_after', _hp_after,
    'damage_kind', _damage_kind,
    'magic_level', _magic_level,
    'damage_source_character_id', _source_character_id,
    'damage_fixed_modifier', _damage_fixed_modifier,
    'damage_percent_modifier', _damage_percent_modifier,
    'damage_any_fixed_modifier', _damage_any_fixed,
    'damage_any_percent_modifier', _damage_any_percent,
    'damage_physical_fixed_modifier', _damage_physical_fixed,
    'damage_physical_percent_modifier', _damage_physical_percent,
    'damage_magical_fixed_modifier', _damage_magical_fixed,
    'damage_magical_percent_modifier', _damage_magical_percent,
    'physical_reduction_fixed', _physical_reduction_fixed,
    'physical_reduction_percent', _physical_reduction_percent,
    'magical_reduction_fixed', _magical_reduction_fixed,
    'magical_reduction_percent', _magical_reduction_percent,
    'damage_received_any_fixed', _damage_received_any_fixed,
    'damage_received_any_percent', _damage_received_any_percent,
    'damage_received_physical_fixed', _damage_received_physical_fixed,
    'damage_received_physical_percent', _damage_received_physical_percent,
    'damage_received_magical_fixed', _damage_received_magical_fixed,
    'damage_received_magical_percent', _damage_received_magical_percent,
    'is_invincible', _is_invincible
  );
END;
$function$
;

-- apply_battle_damage_critical
CREATE OR REPLACE FUNCTION public.apply_battle_damage_critical(_battle_id uuid, _character_id uuid, _damage_kind text, _damage_type_id uuid, _damage_values jsonb, _magic_level text, _source_character_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _result jsonb;
  _critical_values jsonb := '[]'::jsonb;
  _critical_potential_values jsonb := '[]'::jsonb;
  _critical_total integer := 0;
  _hp_before integer := 0;
  _hp_after integer := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode aplicar dano crítico';
  END IF;

  -- Reuse the complete combat calculation, including attacker modifiers,
  -- defense, mitigation, Dano Recebido, and Invencível.
  _result := public.apply_battle_damage(
    _battle_id,
    _character_id,
    _damage_kind,
    _damage_type_id,
    _damage_values,
    _magic_level,
    _source_character_id
  );

  IF jsonb_typeof(_result->'final_damage_by_hit') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'O cálculo de dano não retornou os valores finais por golpe';
  END IF;

  SELECT
    COALESCE(jsonb_agg(to_jsonb(hit.critical_damage) ORDER BY hit.ordinality), '[]'::jsonb),
    COALESCE(SUM(hit.critical_damage), 0)::integer
  INTO _critical_values, _critical_total
  FROM (
    SELECT
      item.ordinality,
      LEAST(2000000, GREATEST(0, ROUND((item.value #>> '{}')::numeric * 2)))::integer AS critical_damage
    FROM jsonb_array_elements(_result->'final_damage_by_hit') WITH ORDINALITY AS item(value, ordinality)
  ) AS hit;

  SELECT COALESCE(jsonb_agg(
    to_jsonb(LEAST(2000000, GREATEST(0, ROUND((item.value #>> '{}')::numeric * 2)))::integer)
    ORDER BY item.ordinality
  ), '[]'::jsonb)
  INTO _critical_potential_values
  FROM jsonb_array_elements(COALESCE(_result->'damage_without_invincible_by_hit', '[]'::jsonb))
    WITH ORDINALITY AS item(value, ordinality);

  _hp_before := COALESCE(NULLIF(_result->>'hp_before', '')::integer, 0);
  _hp_after := GREATEST(0, _hp_before - _critical_total);

  -- Apply the final HP in this same transaction. If anything fails, base damage
  -- rolls back too; a failed critical request can never leave only normal damage.
  UPDATE public.character_attributes
  SET current_value = _hp_after,
      updated_at = now()
  WHERE character_id = _character_id
    AND attribute_key = 'hp';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'O alvo não possui atributo de HP';
  END IF;

  RETURN _result || jsonb_build_object(
    'total_damage', _critical_total,
    'hp_after', _hp_after,
    'final_damage_by_hit', _critical_values,
    'damage_without_invincible_by_hit', _critical_potential_values,
    'critical_damage', true
  );
END;
$function$
;

-- sync_coracao_corrompido_strength_effect_internal
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
  _effective_bonus numeric := _bonus_strength;
BEGIN
  IF _character_id IS NULL THEN
    RETURN;
  END IF;

  IF _effective_bonus IS NULL THEN
    SELECT COALESCE(MAX(
      CASE
        WHEN lower(attr.value->>'key') IN ('forcabonus', 'forçabonus')
          AND attr.value->>'type' = 'number'
          AND COALESCE(attr.value->>'value', '') ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN (attr.value->>'value')::numeric
        ELSE NULL
      END
    ), 0)
    INTO _effective_bonus
    FROM public.abilities a
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(COALESCE(a.custom_attributes, '[]'::jsonb)) = 'array'
        THEN COALESCE(a.custom_attributes, '[]'::jsonb) ELSE '[]'::jsonb END
    ) AS attr(value)
    WHERE a.custom_script_key = 'coracao_corrompido';
  END IF;
  _effective_bonus := LEAST(1000000, GREATEST(0, COALESCE(_effective_bonus, 0)));

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
    SELECT ca.id, ca.cooldown_remaining, ca.passive_effects
    FROM public.character_abilities ca
    JOIN public.abilities a ON a.id = ca.ability_id
    WHERE ca.character_id = _character_id
      AND (a.custom_script_key = 'coracao_corrompido' OR lower(btrim(a.name)) = lower('Coração Corrompido'))
  LOOP
    _current_effects := CASE
      WHEN jsonb_typeof(COALESCE(_heart.passive_effects, '[]'::jsonb)) = 'array'
        THEN COALESCE(_heart.passive_effects, '[]'::jsonb)
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
        'effect_type', 'status',
        'attribute_key', 'strength',
        'polarity', 'buff',
        'value_mode', 'fixed',
        'amount', _effective_bonus,
        'duration', 1,
        'damage_scope', 'any',
        'special_modifier_key', 'coracao_corrompido_demonio_strength'
      ));
    END IF;

    IF _current_effects IS DISTINCT FROM _next_effects THEN
      UPDATE public.character_abilities
      SET passive_effects = _next_effects
      WHERE id = _heart.id;
    END IF;
  END LOOP;
END;
$function$
;

-- sync_coracao_corrompido_strength_effect
CREATE OR REPLACE FUNCTION public.sync_coracao_corrompido_strength_effect(_character_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.sync_coracao_corrompido_strength_effect_internal(_character_id, NULL);
END;
$function$
;

-- sync_coracao_corrompido_strength_effect_with_bonus
CREATE OR REPLACE FUNCTION public.sync_coracao_corrompido_strength_effect_with_bonus(_character_id uuid, _bonus_strength numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.sync_coracao_corrompido_strength_effect_internal(_character_id, _bonus_strength);
END;
$function$
;

REVOKE ALL ON FUNCTION public.sync_coracao_corrompido_strength_effect_internal(uuid,numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_coracao_corrompido_strength_effect_internal(uuid,numeric)
  TO service_role;
REVOKE ALL ON FUNCTION public.sync_coracao_corrompido_strength_effect_with_bonus(uuid,numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_coracao_corrompido_strength_effect_with_bonus(uuid,numeric)
  TO service_role;
REVOKE ALL ON FUNCTION public.sync_coracao_corrompido_strength_effect(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_coracao_corrompido_strength_effect(uuid)
  TO service_role;
