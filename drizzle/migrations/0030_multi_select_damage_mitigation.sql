-- Allow mitigation effects to target multiple magic types and grades.
ALTER TABLE public.battle_effects
  ADD COLUMN IF NOT EXISTS damage_reduction_type_ids uuid[],
  ADD COLUMN IF NOT EXISTS damage_reduction_magic_levels text[];

ALTER TABLE public.battle_effects DROP CONSTRAINT IF EXISTS battle_effects_check;
ALTER TABLE public.battle_effects ADD CONSTRAINT battle_effects_check CHECK (
  (effect_type = 'status' AND attribute_key IS NOT NULL)
  OR (effect_type = 'regeneration' AND attribute_key IN ('hp','mana'))
  OR effect_type IN ('no_regen_hp','no_regen_mana','stun','mana_used')
  OR (effect_type = 'magic_prohibition' AND attribute_key IS NULL AND polarity = 'debuff')
  OR (effect_type = 'damage_dealt' AND attribute_key IS NULL)
  OR (effect_type = 'no_mana' AND attribute_key IS NULL AND polarity = 'debuff')
  OR (
    effect_type = 'damage_reduction'
    AND attribute_key IS NULL
    AND polarity = 'buff'
    AND value_mode IN ('fixed','percent')
    AND (
      (damage_reduction_scope = 'physical'
        AND damage_reduction_type_id IS NULL
        AND damage_reduction_magic_level IS NULL
        AND damage_reduction_type_ids IS NULL
        AND damage_reduction_magic_levels IS NULL)
      OR
      (damage_reduction_scope = 'magical' AND (
        (damage_reduction_type_ids IS NULL
          AND damage_reduction_magic_levels IS NULL
          AND damage_reduction_type_id IS NOT NULL
          AND damage_reduction_magic_level IS NOT NULL
          AND damage_reduction_magic_level IN ('baixa','media','alta'))
        OR
        (damage_reduction_type_ids IS NOT NULL
          AND damage_reduction_magic_levels IS NOT NULL
          AND damage_reduction_type_id IS NULL
          AND damage_reduction_magic_level IS NULL
          AND array_position(damage_reduction_type_ids, NULL::uuid) IS NULL
          AND array_position(damage_reduction_magic_levels, NULL::text) IS NULL
          AND (cardinality(damage_reduction_magic_levels) = 0
            OR damage_reduction_magic_levels <@ ARRAY['baixa','media','alta']::text[]))
      ))
    )
  )
);

CREATE OR REPLACE FUNCTION public.apply_battle_damage(
  _battle_id uuid,
  _character_id uuid,
  _damage_kind text,
  _damage_type_id uuid,
  _damage_values jsonb,
  _magic_level text,
  _source_character_id uuid default null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  _physical_defense := GREATEST(0, COALESCE(_physical_defense, 0));
  _magical_defense := GREATEST(0, COALESCE(_magical_defense, 0));

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
    ELSIF _damage_kind = 'magical' THEN
      _rounded_raw := round(
        GREATEST(0, _raw + _damage_any_fixed + _damage_magical_fixed)
        * GREATEST(0, 1 + (_damage_any_percent + _damage_magical_percent) / 100)
      )::integer;
      _dealt := GREATEST(0, _rounded_raw - _magical_defense)::integer;
      _dealt := round(GREATEST(0, _dealt - _magical_reduction_fixed)
        * GREATEST(0, 1 - _magical_reduction_percent / 100))::integer;
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
      _dealt := (_physical_part + _magical_part)::integer;
    ELSE
      -- True damage is affected only by "any" modifiers and ignores both defenses.
      _rounded_raw := round(
        GREATEST(0, _raw + _damage_any_fixed)
        * GREATEST(0, 1 + _damage_any_percent / 100)
      )::integer;
      _dealt := _rounded_raw;
    END IF;

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
    'magical_reduction_percent', _magical_reduction_percent
  );
END;
$function$;

create or replace function public.apply_character_ability_end_effects()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _end_effects jsonb;
  _ability_name text;
  _effect jsonb;
  _effect_type text;
  _attribute_key text;
  _polarity text;
  _value_mode text;
  _amount numeric;
  _duration integer;
  _effect_name text;
  _damage_scope text;
  _damage_reduction_scope text;
  _damage_reduction_type_id uuid;
  _damage_reduction_magic_level text;
  _damage_reduction_type_ids uuid[];
  _damage_reduction_magic_levels text[];
begin
  if old.is_end_effect or old.effect_group_id is null or old.source_character_ability_id is null then
    return old;
  end if;

  -- Ending an entire combat is not the same as a skill's effects expiring.
  if old.battle_id is not null and not exists (
    select 1 from public.battles b where b.id = old.battle_id and b.active
  ) then
    return old;
  end if;

  if exists (
    select 1 from public.battle_effects e
    where e.effect_group_id = old.effect_group_id and not e.is_end_effect
  ) then
    return old;
  end if;

  select ca.end_effects, ca.name
  into _end_effects, _ability_name
  from public.character_abilities ca
  where ca.id = old.source_character_ability_id;

  if not found or jsonb_typeof(coalesce(_end_effects, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(_end_effects, '[]'::jsonb)) = 0 then
    return old;
  end if;

  for _effect in select value from jsonb_array_elements(coalesce(_end_effects, '[]'::jsonb))
  loop
    _effect_type := _effect->>'effect_type';
    _attribute_key := nullif(_effect->>'attribute_key', '');
    _polarity := coalesce(nullif(_effect->>'polarity', ''), 'buff');
    _value_mode := coalesce(nullif(_effect->>'value_mode', ''), 'fixed');
    _amount := coalesce(nullif(_effect->>'amount', '')::numeric, 0);
    _duration := greatest(1, coalesce(nullif(_effect->>'duration', '')::integer, 1));
    _effect_name := coalesce(nullif(_effect->>'name', ''), _ability_name);
    _damage_scope := coalesce(nullif(_effect->>'damage_scope', ''), 'any');
    _damage_reduction_scope := coalesce(nullif(_effect->>'damage_reduction_scope', ''), 'physical');
    _damage_reduction_type_id := nullif(_effect->>'damage_reduction_type_id', '')::uuid;
    _damage_reduction_magic_level := nullif(_effect->>'damage_reduction_magic_level', '');
    IF jsonb_typeof(_effect->'damage_reduction_type_ids') = 'array' THEN
      SELECT ARRAY(SELECT jsonb_array_elements_text(_effect->'damage_reduction_type_ids')::uuid)
      INTO _damage_reduction_type_ids;
    ELSE
      _damage_reduction_type_ids := NULL;
    END IF;
    IF jsonb_typeof(_effect->'damage_reduction_magic_levels') = 'array' THEN
      SELECT ARRAY(SELECT jsonb_array_elements_text(_effect->'damage_reduction_magic_levels'))
      INTO _damage_reduction_magic_levels;
    ELSE
      _damage_reduction_magic_levels := NULL;
    END IF;
    IF _damage_scope NOT IN ('any', 'physical', 'magical') THEN
      RAISE EXCEPTION 'Escopo de Dano Causado inválido';
    END IF;

    if _effect_type is null or _effect_type not in (
      'status','regeneration','mana_regeneration','mana_used',
      'no_regen_hp','no_regen_mana','stun','magic_prohibition','damage_dealt','damage_reduction','no_mana'
    ) then
      raise exception 'Tipo de efeito de encerramento inválido na habilidade %', _ability_name;
    end if;
    if _polarity not in ('buff','debuff') or _value_mode not in ('percent','fixed') then
      raise exception 'Configuração de efeito de encerramento inválida';
    end if;
    if _amount < 0 then raise exception 'Valor de efeito de encerramento inválido'; end if;

    if _effect_type = 'status' then
      if _attribute_key is null or not exists (
        select 1 from public.attribute_definitions where key = _attribute_key
      ) then
        raise exception 'Efeito de encerramento de status precisa de atributo válido';
      end if;
    elsif _effect_type = 'regeneration' then
      if _attribute_key is null or _attribute_key not in ('hp','mana') then
        raise exception 'Regeneração de encerramento só pode afetar HP ou Mana';
      end if;
    elsif _effect_type = 'mana_regeneration' then
      _effect_type := 'regeneration';
      _attribute_key := 'mana';
    elsif _effect_type in ('mana_used', 'damage_dealt') then
      _attribute_key := null;
    elsif _effect_type = 'damage_reduction' then
      if _polarity <> 'buff' then raise exception 'Mitigação de dano só pode ser um buff'; end if;
      _attribute_key := null;
      if _damage_reduction_scope = 'physical' then
        _damage_reduction_type_id := null;
        _damage_reduction_magic_level := null;
        _damage_reduction_type_ids := null;
        _damage_reduction_magic_levels := null;
      elsif _damage_reduction_scope = 'magical' then
        if _damage_reduction_type_ids is null and _damage_reduction_magic_levels is null then
          -- Keep compatibility with abilities saved before multi-select was introduced.
          if _damage_reduction_type_id is null or not exists (
            select 1 from public.damage_types where id = _damage_reduction_type_id
          ) then
            raise exception 'Selecione um tipo mágico válido para a mitigação';
          end if;
          if _damage_reduction_magic_level is null or _damage_reduction_magic_level not in ('baixa','media','alta') then
            raise exception 'Selecione um grau mágico válido para a mitigação';
          end if;
        else
          if _damage_reduction_type_ids is null or _damage_reduction_magic_levels is null then
            raise exception 'Seleção de tipos e graus da mitigação incompleta';
          end if;
          if cardinality(_damage_reduction_type_ids) > 0 and exists (
            select 1 from unnest(_damage_reduction_type_ids) selected_type(id)
            where not exists (select 1 from public.damage_types dt where dt.id = selected_type.id)
          ) then
            raise exception 'A mitigação contém um tipo mágico inválido';
          end if;
          if cardinality(_damage_reduction_magic_levels) > 0 and (
            array_position(_damage_reduction_magic_levels, null::text) is not null
            or not (_damage_reduction_magic_levels <@ ARRAY['baixa','media','alta']::text[])
          ) then
            raise exception 'A mitigação contém um grau mágico inválido';
          end if;
          _damage_reduction_type_id := null;
          _damage_reduction_magic_level := null;
        end if;
      else
        raise exception 'Categoria de mitigação inválida';
      end if;
    elsif _effect_type = 'no_mana' then
      if _polarity <> 'debuff' then raise exception 'Sem Mana só pode ser um debuff'; end if;
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _damage_scope := 'any';
    elsif _effect_type = 'magic_prohibition' then
      if _polarity <> 'debuff' then raise exception 'Proibição de magia só pode ser um debuff'; end if;
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
    else
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
    end if;

    insert into public.battle_effects (
      battle_id, character_id, name, effect_type, attribute_key, polarity,
      value_mode, amount, duration, duration_scope, source_character_ability_id,
      effect_group_id, is_end_effect, damage_scope,
      damage_reduction_scope, damage_reduction_type_id, damage_reduction_magic_level,
      damage_reduction_type_ids, damage_reduction_magic_levels
    ) values (
      old.battle_id, old.character_id, _ability_name || ': ' || _effect_name,
      _effect_type, _attribute_key, _polarity, _value_mode, _amount, _duration,
      old.duration_scope, old.source_character_ability_id, old.effect_group_id, true, _damage_scope,
      _damage_reduction_scope, _damage_reduction_type_id, _damage_reduction_magic_level,
      _damage_reduction_type_ids, _damage_reduction_magic_levels
    );
  end loop;

  return old;
end;
$$;

create or replace function public.activate_character_ability(
  _character_ability_id uuid,
  _target_character_id uuid,
  _battle_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  _assignment public.character_abilities;
  _owner_id uuid;
  _mana integer;
  _effective_battle_id uuid := _battle_id;
  _effect jsonb;
  _effect_type text;
  _attribute_key text;
  _polarity text;
  _value_mode text;
  _amount numeric;
  _duration integer;
  _effect_name text;
  _damage_scope text;
  _damage_reduction_scope text;
  _damage_reduction_type_id uuid;
  _damage_reduction_magic_level text;
  _damage_reduction_type_ids uuid[];
  _damage_reduction_magic_levels text[];
  _mana_fixed_modifier numeric := 0;
  _mana_percent_modifier numeric := 0;
  _effective_mana_cost integer := 0;
  _effect_group_id uuid := gen_random_uuid();
  _is_master boolean := public.has_role(auth.uid(), 'master');
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;

  select * into _assignment
  from public.character_abilities
  where id = _character_ability_id
  for update;
  if not found then raise exception 'Habilidade não encontrada nesta ficha'; end if;

  select owner_id into _owner_id
  from public.characters where id = _assignment.character_id;
  if not found then raise exception 'Ficha do personagem não encontrada'; end if;
  if not _is_master and _owner_id is distinct from auth.uid() then
    raise exception 'Sem permissão para usar esta habilidade';
  end if;

  if not _assignment.can_activate or _assignment.cooldown_turns <= 0 then
    raise exception 'Esta habilidade não pode ser ativada';
  end if;
  if _assignment.cooldown_remaining > 0 then
    raise exception 'Habilidade em cooldown: faltam % turno(s)', _assignment.cooldown_remaining;
  end if;
  if _assignment.self_target_only and _target_character_id <> _assignment.character_id then
    raise exception 'Esta habilidade só pode ser usada no próprio personagem';
  end if;
  if not exists (select 1 from public.characters where id = _target_character_id) then
    raise exception 'Alvo não encontrado'; 
  end if;

  if _effective_battle_id is not null then
    if not exists (select 1 from public.battles where id = _effective_battle_id and active) then
      raise exception 'Batalha não encontrada ou encerrada';
    end if;
    if not exists (
      select 1 from public.battle_participants
      where battle_id = _effective_battle_id and character_id = _assignment.character_id
    ) or not exists (
      select 1 from public.battle_participants
      where battle_id = _effective_battle_id and character_id = _target_character_id
    ) then
      raise exception 'O personagem e o alvo precisam estar na mesma batalha';
    end if;
  else
    if _target_character_id <> _assignment.character_id then
      raise exception 'Fora do combate, a habilidade só pode ser usada no próprio personagem';
    end if;
    select b.id into _effective_battle_id
    from public.battles b
    join public.battle_participants bp on bp.battle_id = b.id
    where b.active and bp.character_id = _target_character_id
    order by b.created_at desc
    limit 1;
  end if;

  -- Passive mana-use modifiers: a buff lowers cost, a debuff raises it.
  select
    coalesce(sum((case when effect->>'polarity' = 'buff' then -1 else 1 end)
      * coalesce(nullif(effect->>'amount','')::numeric, 0))
      filter (where effect->>'effect_type' = 'mana_used' and coalesce(effect->>'value_mode','fixed') = 'fixed'), 0),
    coalesce(sum((case when effect->>'polarity' = 'buff' then -1 else 1 end)
      * coalesce(nullif(effect->>'amount','')::numeric, 0))
      filter (where effect->>'effect_type' = 'mana_used' and coalesce(effect->>'value_mode','fixed') = 'percent'), 0)
  into _mana_fixed_modifier, _mana_percent_modifier
  from public.character_abilities ca
  cross join lateral jsonb_array_elements(ca.passive_effects) as passive_effect(effect)
  where ca.character_id = _assignment.character_id;

  -- Temporary mana-use modifiers on the caster apply only to standalone effects
  -- and effects in the battle in which the activation is happening.
  select
    _mana_fixed_modifier + coalesce(sum((case when e.polarity = 'buff' then -1 else 1 end) * e.amount)
      filter (where e.value_mode = 'fixed'), 0),
    _mana_percent_modifier + coalesce(sum((case when e.polarity = 'buff' then -1 else 1 end) * e.amount)
      filter (where e.value_mode = 'percent'), 0)
  into _mana_fixed_modifier, _mana_percent_modifier
  from public.battle_effects e
  where e.character_id = _assignment.character_id
    and e.effect_type = 'mana_used'
    and e.duration > 0
    and (e.battle_id is null or e.battle_id = _effective_battle_id);

  _effective_mana_cost := greatest(
    0,
    floor(greatest(0, _assignment.mana_cost + _mana_fixed_modifier)
      * greatest(0, 1 + _mana_percent_modifier / 100))::integer
  );

  if ((_assignment.is_magical or _assignment.mana_cost > 0 or _effective_mana_cost > 0)
      and public.character_has_no_mana(_assignment.character_id)) then
    raise exception 'Sem Mana: habilidades mágicas ou que consomem Mana não podem ser usadas enquanto o efeito durar';
  end if;

  if (
    (_assignment.is_magical or _assignment.mana_cost > 0 or _effective_mana_cost > 0)
    and exists (
      select 1 from public.battle_effects e
      where e.character_id = _assignment.character_id
        and e.effect_type = 'magic_prohibition'
        and e.polarity = 'debuff'
        and e.duration > 0
        and (e.battle_id is null or e.battle_id = _effective_battle_id)
    )
  ) then
    raise exception 'Proibição de magia: habilidades mágicas ou que consomem Mana não podem ser usadas enquanto o efeito durar';
  end if;

  if _effective_mana_cost > 0 then
    select current_value into _mana
    from public.character_attributes
    where character_id = _assignment.character_id and attribute_key = 'mana'
    for update;
    if not found then raise exception 'Esta ficha não possui o atributo Mana'; end if;
    if _mana < _effective_mana_cost then
      raise exception 'Mana insuficiente: precisa de %, possui %', _effective_mana_cost, _mana;
    end if;
    update public.character_attributes
      set current_value = _mana - _effective_mana_cost, updated_at = now()
      where character_id = _assignment.character_id and attribute_key = 'mana';
  end if;

  update public.character_abilities
  set cooldown_remaining = cooldown_turns
  where id = _assignment.id;

  if jsonb_typeof(coalesce(_assignment.effects, '[]'::jsonb)) <> 'array' then
    raise exception 'Configuração de efeitos ativos inválida';
  end if;

  for _effect in select value from jsonb_array_elements(coalesce(_assignment.effects, '[]'::jsonb))
  loop
    _effect_type := _effect->>'effect_type';
    _attribute_key := nullif(_effect->>'attribute_key', '');
    _polarity := coalesce(nullif(_effect->>'polarity', ''), 'buff');
    _value_mode := coalesce(nullif(_effect->>'value_mode', ''), 'fixed');
    _amount := coalesce(nullif(_effect->>'amount', '')::numeric, 0);
    _duration := coalesce(nullif(_effect->>'duration', '')::integer, 1);
    _effect_name := coalesce(nullif(_effect->>'name', ''), _assignment.name);
    _damage_scope := coalesce(nullif(_effect->>'damage_scope', ''), 'any');
    _damage_reduction_scope := coalesce(nullif(_effect->>'damage_reduction_scope', ''), 'physical');
    _damage_reduction_type_id := nullif(_effect->>'damage_reduction_type_id', '')::uuid;
    _damage_reduction_magic_level := nullif(_effect->>'damage_reduction_magic_level', '');
    IF jsonb_typeof(_effect->'damage_reduction_type_ids') = 'array' THEN
      SELECT ARRAY(SELECT jsonb_array_elements_text(_effect->'damage_reduction_type_ids')::uuid)
      INTO _damage_reduction_type_ids;
    ELSE
      _damage_reduction_type_ids := NULL;
    END IF;
    IF jsonb_typeof(_effect->'damage_reduction_magic_levels') = 'array' THEN
      SELECT ARRAY(SELECT jsonb_array_elements_text(_effect->'damage_reduction_magic_levels'))
      INTO _damage_reduction_magic_levels;
    ELSE
      _damage_reduction_magic_levels := NULL;
    END IF;
    IF _damage_scope NOT IN ('any', 'physical', 'magical') THEN
      RAISE EXCEPTION 'Escopo de Dano Causado inválido';
    END IF;

    if _effect_type is null or _effect_type not in (
      'status','regeneration','mana_regeneration','mana_used',
      'no_regen_hp','no_regen_mana','stun','magic_prohibition','damage_dealt','damage_reduction','no_mana'
    ) then
      raise exception 'Tipo de efeito inválido na habilidade';
    end if;
    if _polarity not in ('buff','debuff') or _value_mode not in ('percent','fixed') then
      raise exception 'Configuração de efeito inválida';
    end if;
    if _amount < 0 or _duration < 1 then raise exception 'Valor ou duração do efeito inválido'; end if;

    if _effect_type = 'status' then
      if _attribute_key is null or not exists (select 1 from public.attribute_definitions where key = _attribute_key) then
        raise exception 'Buff/debuff de status precisa de um atributo válido';
      end if;
    elsif _effect_type = 'regeneration' then
      if _attribute_key is null or _attribute_key not in ('hp','mana') then raise exception 'Regeneração só pode afetar HP ou Mana'; end if;
    elsif _effect_type = 'mana_regeneration' then
      _effect_type := 'regeneration';
      _attribute_key := 'mana';
    elsif _effect_type in ('mana_used', 'damage_dealt') then
      _attribute_key := null;
    elsif _effect_type = 'damage_reduction' then
      if _polarity <> 'buff' then raise exception 'Mitigação de dano só pode ser um buff'; end if;
      _attribute_key := null;
      if _damage_reduction_scope = 'physical' then
        _damage_reduction_type_id := null;
        _damage_reduction_magic_level := null;
        _damage_reduction_type_ids := null;
        _damage_reduction_magic_levels := null;
      elsif _damage_reduction_scope = 'magical' then
        if _damage_reduction_type_ids is null and _damage_reduction_magic_levels is null then
          -- Keep compatibility with abilities saved before multi-select was introduced.
          if _damage_reduction_type_id is null or not exists (
            select 1 from public.damage_types where id = _damage_reduction_type_id
          ) then
            raise exception 'Selecione um tipo mágico válido para a mitigação';
          end if;
          if _damage_reduction_magic_level is null or _damage_reduction_magic_level not in ('baixa','media','alta') then
            raise exception 'Selecione um grau mágico válido para a mitigação';
          end if;
        else
          if _damage_reduction_type_ids is null or _damage_reduction_magic_levels is null then
            raise exception 'Seleção de tipos e graus da mitigação incompleta';
          end if;
          if cardinality(_damage_reduction_type_ids) > 0 and exists (
            select 1 from unnest(_damage_reduction_type_ids) selected_type(id)
            where not exists (select 1 from public.damage_types dt where dt.id = selected_type.id)
          ) then
            raise exception 'A mitigação contém um tipo mágico inválido';
          end if;
          if cardinality(_damage_reduction_magic_levels) > 0 and (
            array_position(_damage_reduction_magic_levels, null::text) is not null
            or not (_damage_reduction_magic_levels <@ ARRAY['baixa','media','alta']::text[])
          ) then
            raise exception 'A mitigação contém um grau mágico inválido';
          end if;
          _damage_reduction_type_id := null;
          _damage_reduction_magic_level := null;
        end if;
      else
        raise exception 'Categoria de mitigação inválida';
      end if;
    elsif _effect_type = 'no_mana' then
      if _polarity <> 'debuff' then raise exception 'Sem Mana só pode ser um debuff'; end if;
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _damage_scope := 'any';
    elsif _effect_type = 'magic_prohibition' then
      if _polarity <> 'debuff' then raise exception 'Proibição de magia só pode ser um debuff'; end if;
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
    else
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
    end if;

    insert into public.battle_effects (
      battle_id, character_id, name, effect_type, attribute_key, polarity,
      value_mode, amount, duration, duration_scope, source_character_ability_id,
      effect_group_id, is_end_effect, damage_scope,
      damage_reduction_scope, damage_reduction_type_id, damage_reduction_magic_level,
      damage_reduction_type_ids, damage_reduction_magic_levels
    ) values (
      _effective_battle_id, _target_character_id, _assignment.name || ': ' || _effect_name,
      _effect_type, _attribute_key, _polarity, _value_mode, _amount,
      _duration, 'global', _assignment.id, _effect_group_id, false, _damage_scope,
      _damage_reduction_scope, _damage_reduction_type_id, _damage_reduction_magic_level,
      _damage_reduction_type_ids, _damage_reduction_magic_levels
    );
  end loop;

  return _effective_mana_cost;
end;
$$;
