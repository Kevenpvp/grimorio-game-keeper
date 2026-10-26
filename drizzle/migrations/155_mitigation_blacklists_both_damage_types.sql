BEGIN;
ALTER TABLE public.battle_effects
  DROP CONSTRAINT IF EXISTS battle_effects_damage_reduction_scope_check;
ALTER TABLE public.battle_effects
  ADD CONSTRAINT battle_effects_damage_reduction_scope_check
  CHECK (damage_reduction_scope IN ('physical','magical','both'));

CREATE OR REPLACE FUNCTION public.mitigation_matches_damage(
  _settings jsonb, _category text, _physical_id uuid,
  _magical_id uuid, _magic_level text
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
 _scope text := COALESCE(_settings->>'damage_reduction_scope','physical');
 _allow jsonb;
 _blacklist jsonb;
 _grades jsonb;
 _excluded_grades jsonb;
 _id text;
BEGIN
 IF _category='physical' THEN
   IF _scope NOT IN ('physical','both') THEN RETURN false; END IF;
   _id := _physical_id::text;
   _allow := CASE
     WHEN jsonb_typeof(_settings->'damage_reduction_physical_type_ids')='array'
       THEN _settings->'damage_reduction_physical_type_ids'
     WHEN _scope='physical' AND jsonb_typeof(_settings->'damage_reduction_type_ids')='array'
       THEN _settings->'damage_reduction_type_ids'
     WHEN _scope='physical' AND _settings->>'damage_reduction_type_id' IS NOT NULL
       THEN jsonb_build_array(_settings->>'damage_reduction_type_id')
     ELSE '[]'::jsonb END;
   _blacklist := CASE
     WHEN jsonb_typeof(_settings->'damage_reduction_physical_blacklist_ids')='array'
       THEN _settings->'damage_reduction_physical_blacklist_ids'
     ELSE '[]'::jsonb END;
 ELSE
   IF _category<>'magical' OR _scope NOT IN ('magical','both') THEN RETURN false; END IF;
   _id := _magical_id::text;
   IF _id IS NULL OR _magic_level IS NULL THEN RETURN false; END IF;
   _allow := CASE
     WHEN jsonb_typeof(_settings->'damage_reduction_magic_type_ids')='array'
       THEN _settings->'damage_reduction_magic_type_ids'
     WHEN _scope='magical' AND jsonb_typeof(_settings->'damage_reduction_type_ids')='array'
       THEN _settings->'damage_reduction_type_ids'
     WHEN _scope='magical' AND _settings->>'damage_reduction_type_id' IS NOT NULL
       THEN jsonb_build_array(_settings->>'damage_reduction_type_id')
     ELSE '[]'::jsonb END;
   _blacklist := CASE
     WHEN jsonb_typeof(_settings->'damage_reduction_magic_blacklist_ids')='array'
       THEN _settings->'damage_reduction_magic_blacklist_ids'
     ELSE '[]'::jsonb END;
   _grades := CASE WHEN jsonb_typeof(_settings->'damage_reduction_magic_levels')='array'
       THEN _settings->'damage_reduction_magic_levels'
     WHEN _settings->>'damage_reduction_magic_level' IS NOT NULL
       THEN jsonb_build_array(_settings->>'damage_reduction_magic_level')
     ELSE '[]'::jsonb END;
   _excluded_grades := CASE WHEN jsonb_typeof(_settings->'damage_reduction_magic_level_blacklist')='array'
       THEN _settings->'damage_reduction_magic_level_blacklist' ELSE '[]'::jsonb END;
   IF (jsonb_array_length(_grades)>0 AND NOT _grades ? _magic_level)
      OR _excluded_grades ? _magic_level THEN RETURN false; END IF;
 END IF;
 -- jsonb ? queries only top-level string array values; empty include means all.
 RETURN (jsonb_array_length(_allow)=0 OR _allow ? _id)
    AND NOT (_blacklist ? _id);
END;
$function$;
REVOKE ALL ON FUNCTION public.mitigation_matches_damage(jsonb,text,uuid,uuid,text) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.apply_battle_damage(_battle_id uuid, _character_id uuid, _damage_kind text, _damage_type_id uuid, _damage_values jsonb, _magic_level text, _source_character_id uuid DEFAULT NULL::uuid, _physical_damage_type_id uuid DEFAULT NULL::uuid)
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
        AND (
          COALESCE(e.damage_scope, 'any') <> 'physical'
          OR jsonb_typeof(e.effect_data->'damage_dealt_physical_type_ids') IS DISTINCT FROM 'array'
          OR jsonb_array_length(e.effect_data->'damage_dealt_physical_type_ids') = 0
          OR (_physical_damage_type_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(e.effect_data->'damage_dealt_physical_type_ids') selected(value)
            WHERE selected.value = _physical_damage_type_id::text
          ))
        )

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
        AND (
          COALESCE(passive.effect->>'damage_scope', 'any') <> 'physical'
          OR jsonb_typeof(passive.effect->'damage_dealt_physical_type_ids') IS DISTINCT FROM 'array'
          OR jsonb_array_length(passive.effect->'damage_dealt_physical_type_ids') = 0
          OR (_physical_damage_type_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(passive.effect->'damage_dealt_physical_type_ids') selected(value)
            WHERE selected.value = _physical_damage_type_id::text
          ))
        )
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

  IF _physical_damage_type_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.damage_types dt
    WHERE dt.id = _physical_damage_type_id AND dt.category = 'physical'
  ) THEN
    RAISE EXCEPTION 'Selecione um tipo de dano físico válido';
  END IF;
  IF _damage_kind NOT IN ('physical', 'hybrid') AND _physical_damage_type_id IS NOT NULL THEN
    RAISE EXCEPTION 'Tipo físico só pode ser informado em dano físico ou híbrido';
  END IF;

  IF _damage_kind IN ('magical', 'hybrid') THEN
    IF _damage_type_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.damage_types WHERE id = _damage_type_id AND category = 'magical'
    ) THEN
      RAISE EXCEPTION 'Selecione um tipo de dano mágico válido';
    END IF;
    IF _magic_level IS NULL OR _magic_level NOT IN ('baixa', 'media', 'alta') THEN
      RAISE EXCEPTION 'Selecione o nível da magia: baixa, média ou alta';
    END IF;
  ELSIF _magic_level IS NOT NULL THEN
    RAISE EXCEPTION 'Nível de magia só pode ser usado em dano mágico ou híbrido';
  END IF;

  -- Resolve one physical/magical/both effect for each matching damage part.
  -- Blacklists always override the included types and grades.
  SELECT
    COALESCE(SUM(r.amount) FILTER (
      WHERE r.value_mode='fixed' AND _damage_kind IN ('physical','hybrid')
        AND public.mitigation_matches_damage(r.settings,'physical',_physical_damage_type_id,_damage_type_id,_magic_level)
    ),0),
    COALESCE(SUM(r.amount) FILTER (
      WHERE r.value_mode='percent' AND _damage_kind IN ('physical','hybrid')
        AND public.mitigation_matches_damage(r.settings,'physical',_physical_damage_type_id,_damage_type_id,_magic_level)
    ),0),
    COALESCE(SUM(r.amount) FILTER (
      WHERE r.value_mode='fixed' AND _damage_kind IN ('magical','hybrid')
        AND public.mitigation_matches_damage(r.settings,'magical',_physical_damage_type_id,_damage_type_id,_magic_level)
    ),0),
    COALESCE(SUM(r.amount) FILTER (
      WHERE r.value_mode='percent' AND _damage_kind IN ('magical','hybrid')
        AND public.mitigation_matches_damage(r.settings,'magical',_physical_damage_type_id,_damage_type_id,_magic_level)
    ),0)
  INTO _physical_reduction_fixed, _physical_reduction_percent,
       _magical_reduction_fixed, _magical_reduction_percent
  FROM (
    SELECT e.value_mode,e.amount,e.polarity,
      jsonb_strip_nulls(jsonb_build_object(
        'damage_reduction_scope',e.damage_reduction_scope,
        'damage_reduction_type_id',e.damage_reduction_type_id,
        'damage_reduction_magic_level',e.damage_reduction_magic_level,
        'damage_reduction_type_ids',to_jsonb(e.damage_reduction_type_ids),
        'damage_reduction_magic_levels',to_jsonb(e.damage_reduction_magic_levels)
      )) || COALESCE(e.effect_data,'{}'::jsonb) AS settings
    FROM public.battle_effects e
    WHERE e.character_id=_character_id AND e.effect_type='damage_reduction'
      AND e.duration>0 AND (e.battle_id IS NULL OR e.battle_id=_battle_id)
    UNION ALL
    SELECT COALESCE(passive.effect->>'value_mode','fixed'),
      COALESCE(NULLIF(passive.effect->>'amount','')::numeric,0),
      COALESCE(passive.effect->>'polarity','buff'),
      passive.effect
    FROM public.character_abilities ca
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(COALESCE(ca.passive_effects,'[]'::jsonb))='array'
        THEN COALESCE(ca.passive_effects,'[]'::jsonb) ELSE '[]'::jsonb END
    ) passive(effect)
    WHERE ca.character_id=_character_id AND passive.effect->>'effect_type'='damage_reduction'
  ) r WHERE r.polarity='buff';

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
      AND (
        CASE WHEN jsonb_typeof(r.config->'damage_received_physical_type_ids') = 'array' THEN
          jsonb_array_length(r.config->'damage_received_physical_type_ids') = 0
          OR (_physical_damage_type_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(r.config->'damage_received_physical_type_ids') selected(value)
            WHERE selected.value = _physical_damage_type_id::text
          ))
        ELSE true END
      )
      AND r.value_mode = 'fixed' THEN r.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN
      r.damage_received_scope = 'physical'
      AND _damage_kind IN ('physical', 'hybrid')
      AND (
        CASE WHEN jsonb_typeof(r.config->'damage_received_physical_type_ids') = 'array' THEN
          jsonb_array_length(r.config->'damage_received_physical_type_ids') = 0
          OR (_physical_damage_type_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(r.config->'damage_received_physical_type_ids') selected(value)
            WHERE selected.value = _physical_damage_type_id::text
          ))
        ELSE true END
      )
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

  -- Match the displayed effective defenses, including status effects,
  -- ability passives, class bonuses and physical point allocations.
  SELECT public.calculate_character_effective_defense(_character_id,'phys_def',_battle_id),
         public.calculate_character_effective_defense(_character_id,'mag_def',_battle_id)
  INTO _physical_defense,_magical_defense;
  SELECT public.defense_after_ignore(_physical_defense, COALESCE(NULLIF(current_setting('grimorio.attack_defense_ignore',true),'')::jsonb,'{}'::jsonb),'physical'),
         public.defense_after_ignore(_magical_defense, COALESCE(NULLIF(current_setting('grimorio.attack_defense_ignore',true),'')::jsonb,'{}'::jsonb),'magical')
  INTO _physical_defense,_magical_defense;

  SELECT
    EXISTS (
      SELECT 1
      FROM public.battle_effects e
      WHERE e.character_id = _character_id
        AND e.effect_type IN ('invincible','temporal_freeze')
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
        AND passive.effect->>'effect_type' IN ('invincible','temporal_freeze')
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
    'physical_damage_type_id', _physical_damage_type_id,
    'is_invincible', _is_invincible
  );
END;
$function$
;
NOTIFY pgrst,'reload schema';
COMMIT;