CREATE OR REPLACE FUNCTION public.apply_ability_healing(
  _character_id uuid,
  _battle_id uuid,
  _config jsonb,
  _apply_resources boolean DEFAULT true,
  _apply_debuff_changes boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current numeric;
  _maximum numeric;
  _amount numeric;
  _body numeric;
  _sanity numeric;
  _body_restore numeric := 0;
  _sanity_restore numeric := 0;
  _blacklist jsonb := '[]'::jsonb;
  _name_blacklist text[] := ARRAY[]::text[];
  _fixed_turns integer := 0;
  _percent_turns numeric := 0;
  _debuff record;
  _new_duration integer;
  _reversal_effect jsonb;
  _reversal_mode text;
  _reversal_custom_damage numeric := 0;
  _reversal_base_damage numeric := 0;
  _reversal_damage numeric := 0;
  _runtime_healer_id uuid;
  _reversal_type_id uuid;
  _reversal_magic_level text;
  _reversed_healing boolean := false;
BEGIN
  IF _config IS NULL OR jsonb_typeof(_config) <> 'object' THEN
    RAISE EXCEPTION 'Configuração da cura inválida';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.characters WHERE id = _character_id) THEN
    RAISE EXCEPTION 'Personagem da cura não encontrado';
  END IF;

  IF jsonb_typeof(_config->'healing_debuff_blacklist') = 'array' THEN
    _blacklist := _config->'healing_debuff_blacklist';
  END IF;
  IF jsonb_typeof(_config->'healing_debuff_name_blacklist') = 'array' THEN
    SELECT coalesce(array_agg(lower(trim(value))), ARRAY[]::text[])
    INTO _name_blacklist
    FROM jsonb_array_elements_text(_config->'healing_debuff_name_blacklist') AS names(value)
    WHERE trim(value) <> '';
  END IF;

  -- Reversão de Cura: find the newest matching temporary/racial effect first.
  -- Empty type/grade arrays mean all magical types or all grades.
  IF _apply_resources THEN
    SELECT e.effect_data
    INTO _reversal_effect
    FROM public.battle_effects e
    WHERE e.character_id = _character_id
      AND e.effect_type = 'healing_blocked'
      AND e.effect_data->>'effect_type' = 'magic_healing_reversal'
      AND e.duration > 0
      AND (e.battle_id IS NULL OR e.battle_id = _battle_id)
      AND (
        CASE
          WHEN jsonb_typeof(e.effect_data->'magic_healing_type_ids') = 'array' THEN
            jsonb_array_length(e.effect_data->'magic_healing_type_ids') = 0
            OR (
              NULLIF(_config->>'healing_damage_type_id', '') IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(e.effect_data->'magic_healing_type_ids') selected(value)
                WHERE selected.value = _config->>'healing_damage_type_id'
              )
            )
          ELSE true
        END
      )
      AND (
        CASE
          WHEN jsonb_typeof(e.effect_data->'magic_healing_magic_levels') = 'array' THEN
            jsonb_array_length(e.effect_data->'magic_healing_magic_levels') = 0
            OR (
              NULLIF(_config->>'healing_magic_level', '') IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(e.effect_data->'magic_healing_magic_levels') selected(value)
                WHERE selected.value = _config->>'healing_magic_level'
              )
            )
          ELSE true
        END
      )
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT 1;

    IF _reversal_effect IS NULL THEN
      SELECT passive.effect
      INTO _reversal_effect
      FROM public.character_abilities ca
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(COALESCE(ca.passive_effects, '[]'::jsonb)) = 'array'
          THEN COALESCE(ca.passive_effects, '[]'::jsonb) ELSE '[]'::jsonb END
      ) AS passive(effect)
      WHERE ca.character_id = _character_id
        AND passive.effect->>'effect_type' = 'magic_healing_reversal'
        AND (
          CASE
            WHEN jsonb_typeof(passive.effect->'magic_healing_type_ids') = 'array' THEN
              jsonb_array_length(passive.effect->'magic_healing_type_ids') = 0
              OR (
                NULLIF(_config->>'healing_damage_type_id', '') IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(passive.effect->'magic_healing_type_ids') selected(value)
                  WHERE selected.value = _config->>'healing_damage_type_id'
                )
              )
            ELSE true
          END
        )
        AND (
          CASE
            WHEN jsonb_typeof(passive.effect->'magic_healing_magic_levels') = 'array' THEN
              jsonb_array_length(passive.effect->'magic_healing_magic_levels') = 0
              OR (
                NULLIF(_config->>'healing_magic_level', '') IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(passive.effect->'magic_healing_magic_levels') selected(value)
                  WHERE selected.value = _config->>'healing_magic_level'
                )
              )
            ELSE true
          END
        )
      ORDER BY ca.created_at DESC, ca.id
      LIMIT 1;
    END IF;

    IF _reversal_effect IS NOT NULL THEN
      SELECT c.body::numeric, c.sanity::numeric
      INTO _body, _sanity
      FROM public.characters c
      WHERE c.id = _character_id
      FOR UPDATE;

      -- Sum the configured recovery amount across enabled resources, using the same
      -- fixed/percentage calculations as normal healing, before resource caps.
      IF COALESCE((_config->>'healing_hp_enabled')::boolean, false) THEN
        _maximum := GREATEST(0, COALESCE(public.calculate_character_resource_max(_character_id, 'hp'), 0));
        _amount := GREATEST(0, COALESCE(NULLIF(_config->>'healing_hp_amount', '')::numeric, 0));
        IF COALESCE(_config->>'healing_hp_mode', 'fixed') = 'percent' THEN
          _amount := CEIL(_maximum * LEAST(100, _amount) / 100);
        ELSE
          _amount := FLOOR(_amount);
        END IF;
        _reversal_base_damage := _reversal_base_damage + _amount;
      END IF;
      IF COALESCE((_config->>'healing_mana_enabled')::boolean, false) THEN
        _maximum := GREATEST(0, COALESCE(public.calculate_character_resource_max(_character_id, 'mana'), 0));
        _amount := GREATEST(0, COALESCE(NULLIF(_config->>'healing_mana_amount', '')::numeric, 0));
        IF COALESCE(_config->>'healing_mana_mode', 'fixed') = 'percent' THEN
          _amount := CEIL(_maximum * LEAST(100, _amount) / 100);
        ELSE
          _amount := FLOOR(_amount);
        END IF;
        _reversal_base_damage := _reversal_base_damage + _amount;
      END IF;
      IF COALESCE((_config->>'healing_body_enabled')::boolean, false) THEN
        _amount := GREATEST(0, COALESCE(NULLIF(_config->>'healing_body_amount', '')::numeric, 0));
        IF COALESCE(_config->>'healing_body_mode', 'fixed') = 'percent' THEN
          _amount := CEIL(GREATEST(0, 100 - COALESCE(_body, 100)) * LEAST(100, _amount) / 100);
        ELSE
          _amount := FLOOR(_amount);
        END IF;
        _reversal_base_damage := _reversal_base_damage + _amount;
      END IF;
      IF COALESCE((_config->>'healing_sanity_enabled')::boolean, false) THEN
        _amount := GREATEST(0, COALESCE(NULLIF(_config->>'healing_sanity_amount', '')::numeric, 0));
        IF COALESCE(_config->>'healing_sanity_mode', 'fixed') = 'percent' THEN
          _amount := CEIL(GREATEST(0, 100 - COALESCE(_sanity, 100)) * LEAST(100, _amount) / 100);
        ELSE
          _amount := FLOOR(_amount);
        END IF;
        _reversal_base_damage := _reversal_base_damage + _amount;
      END IF;

      _reversal_mode := COALESCE(NULLIF(_reversal_effect->>'magic_healing_reversal_damage_mode', ''), 'healing_amount');
      _reversal_custom_damage := LEAST(1000000, GREATEST(0, COALESCE(NULLIF(_reversal_effect->>'magic_healing_reversal_custom_damage', '')::numeric, 0)));
      IF _reversal_mode = 'custom' THEN
        _reversal_damage := _reversal_custom_damage;
      ELSIF _reversal_mode = 'both' THEN
        _reversal_damage := _reversal_base_damage + _reversal_custom_damage;
      ELSE
        _reversal_damage := _reversal_base_damage;
      END IF;
      _reversal_damage := LEAST(1000000, GREATEST(0, ROUND(_reversal_damage)));
      _runtime_healer_id := NULLIF(_config->>'_runtime_healer_character_id', '')::uuid;
      IF _runtime_healer_id = _character_id OR (
        _runtime_healer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.characters c WHERE c.id = _runtime_healer_id)
      ) OR (
        _runtime_healer_id IS NOT NULL AND _battle_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.battle_participants bp
          WHERE bp.battle_id = _battle_id AND bp.character_id = _runtime_healer_id
        )
      ) THEN
        _runtime_healer_id := NULL;
      END IF;

      IF _reversal_damage > 0 THEN
        _reversal_type_id := NULLIF(_config->>'healing_damage_type_id', '')::uuid;
        _reversal_magic_level := NULLIF(_config->>'healing_magic_level', '');
        IF _reversal_type_id IS NOT NULL
           AND _reversal_magic_level IN ('baixa', 'media', 'alta')
           AND EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id = _reversal_type_id) THEN
          PERFORM public.apply_battle_damage(
            _battle_id, _character_id, 'magical', _reversal_type_id,
            jsonb_build_array(_reversal_damage), _reversal_magic_level, _runtime_healer_id
          );
        ELSE
          PERFORM public.apply_battle_damage(
            _battle_id, _character_id, 'true', NULL,
            jsonb_build_array(_reversal_damage), NULL, _runtime_healer_id
          );
        END IF;
      END IF;
      _reversed_healing := true;
    END IF;
  END IF;

  IF _apply_resources AND NOT _reversed_healing AND NOT (
    EXISTS (
      SELECT 1 FROM public.battle_effects e
      WHERE e.character_id = _character_id
        AND e.effect_type = 'healing_blocked'
        AND COALESCE(e.effect_data->>'effect_type', 'healing_blocked') <> 'magic_healing_reversal'
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
        AND passive.effect->>'effect_type' = 'healing_blocked'
    )
  ) THEN
    SELECT c.body::numeric, c.sanity::numeric
    INTO _body, _sanity
    FROM public.characters c
    WHERE c.id = _character_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Personagem da cura não encontrado'; END IF;

    IF coalesce((_config->>'healing_hp_enabled')::boolean, false) THEN
      SELECT ca.current_value INTO _current
      FROM public.character_attributes ca
      WHERE ca.character_id = _character_id AND ca.attribute_key = 'hp'
      FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Esta ficha não possui o atributo HP'; END IF;
      _maximum := greatest(0, coalesce(public.calculate_character_resource_max(_character_id, 'hp'), 0));
      _amount := greatest(0, coalesce(nullif(_config->>'healing_hp_amount', '')::numeric, 0));
      IF coalesce(_config->>'healing_hp_mode', 'fixed') = 'percent' THEN
        _amount := ceil(_maximum * least(100, _amount) / 100);
      ELSE
        _amount := floor(_amount);
      END IF;
      UPDATE public.character_attributes
      SET current_value = CASE WHEN _current >= _maximum THEN _current
        ELSE least(_maximum, greatest(0, _current + _amount))::integer END,
        updated_at = now()
      WHERE character_id = _character_id AND attribute_key = 'hp';
    END IF;

    IF coalesce((_config->>'healing_mana_enabled')::boolean, false) THEN
      SELECT ca.current_value INTO _current
      FROM public.character_attributes ca
      WHERE ca.character_id = _character_id AND ca.attribute_key = 'mana'
      FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Esta ficha não possui o atributo Mana'; END IF;
      _maximum := greatest(0, coalesce(public.calculate_character_resource_max(_character_id, 'mana'), 0));
      _amount := greatest(0, coalesce(nullif(_config->>'healing_mana_amount', '')::numeric, 0));
      IF coalesce(_config->>'healing_mana_mode', 'fixed') = 'percent' THEN
        _amount := ceil(_maximum * least(100, _amount) / 100);
      ELSE
        _amount := floor(_amount);
      END IF;
      UPDATE public.character_attributes
      SET current_value = CASE WHEN _current >= _maximum THEN _current
        ELSE least(_maximum, greatest(0, _current + _amount))::integer END,
        updated_at = now()
      WHERE character_id = _character_id AND attribute_key = 'mana';
    END IF;

    IF coalesce((_config->>'healing_body_enabled')::boolean, false) THEN
      _amount := greatest(0, coalesce(nullif(_config->>'healing_body_amount', '')::numeric, 0));
      IF coalesce(_config->>'healing_body_mode', 'fixed') = 'percent' THEN
        _body_restore := ceil(greatest(0, 100 - _body) * least(100, _amount) / 100);
      ELSE
        _body_restore := floor(_amount);
      END IF;
    END IF;
    IF coalesce((_config->>'healing_sanity_enabled')::boolean, false) THEN
      _amount := greatest(0, coalesce(nullif(_config->>'healing_sanity_amount', '')::numeric, 0));
      IF coalesce(_config->>'healing_sanity_mode', 'fixed') = 'percent' THEN
        _sanity_restore := ceil(greatest(0, 100 - _sanity) * least(100, _amount) / 100);
      ELSE
        _sanity_restore := floor(_amount);
      END IF;
    END IF;
    IF _body_restore > 0 OR _sanity_restore > 0 THEN
      UPDATE public.characters
      SET body = least(100, greatest(0, body + _body_restore::integer)),
          sanity = least(100, greatest(0, sanity + _sanity_restore::integer)),
          updated_at = now()
      WHERE id = _character_id;
    END IF;
  END IF;

  IF _apply_debuff_changes THEN
    IF coalesce((_config->>'healing_remove_debuffs')::boolean, false) THEN
      DELETE FROM public.battle_effects e
      WHERE e.character_id = _character_id
        AND e.duration > 0
        AND (e.battle_id IS NULL OR e.battle_id = _battle_id)
        AND (
          e.polarity = 'debuff'
          OR e.effect_type IN ('no_regen_hp','no_regen_mana','magic_prohibition','no_mana','stun')
        )
        AND NOT (_blacklist ? e.effect_type)
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(_name_blacklist) AS excluded(name)
          WHERE lower(e.name) = excluded.name
             OR right(lower(e.name), length(excluded.name) + 2) = ': ' || excluded.name
        );
    END IF;

    _fixed_turns := greatest(0, coalesce(nullif(_config->>'healing_reduce_debuff_turns_fixed', '')::integer, 0));
    _percent_turns := least(100, greatest(0, coalesce(nullif(_config->>'healing_reduce_debuff_turns_percent', '')::numeric, 0)));
    IF _fixed_turns > 0 OR _percent_turns > 0 THEN
      FOR _debuff IN
        SELECT e.id, e.duration
        FROM public.battle_effects e
        WHERE e.character_id = _character_id
          AND e.duration > 0
          AND (e.battle_id IS NULL OR e.battle_id = _battle_id)
          AND (
            e.polarity = 'debuff'
            OR e.effect_type IN ('no_regen_hp','no_regen_mana','magic_prohibition','no_mana','stun')
          )
        AND NOT (_blacklist ? e.effect_type)
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(_name_blacklist) AS excluded(name)
          WHERE lower(e.name) = excluded.name
             OR right(lower(e.name), length(excluded.name) + 2) = ': ' || excluded.name
        )
        ORDER BY e.created_at, e.id
        FOR UPDATE OF e
      LOOP
        _new_duration := floor(greatest(0, _debuff.duration - _fixed_turns) * (1 - _percent_turns / 100))::integer;
        IF _new_duration <= 0 THEN
          DELETE FROM public.battle_effects WHERE id = _debuff.id;
        ELSIF _new_duration < _debuff.duration THEN
          UPDATE public.battle_effects SET duration = _new_duration WHERE id = _debuff.id;
        END IF;
      END LOOP;
    END IF;
  END IF;
END;
$$;

-- Route the new definition through the existing persistent healing-block effect row.
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
  _until_combat_end boolean := false;
  _effect_name text;
  _damage_scope text;
  _damage_reduction_scope text;
  _damage_reduction_type_id uuid;
  _damage_reduction_magic_level text;
  _damage_reduction_type_ids uuid[];
  _damage_reduction_magic_levels text[];
  _caster_character_id uuid;
  _target_character_id uuid;
  _effect_character_id uuid;
  _target_scope text;
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

  select ca.end_effects, ca.name, ca.character_id
  into _end_effects, _ability_name, _caster_character_id
  from public.character_abilities ca
  where ca.id = old.source_character_ability_id;

  if not found or jsonb_typeof(coalesce(_end_effects, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(_end_effects, '[]'::jsonb)) = 0 then
    return old;
  end if;
  _target_character_id := coalesce(old.target_character_id, old.character_id);

  for _effect in select value from jsonb_array_elements(coalesce(_end_effects, '[]'::jsonb))
  loop
    _effect_type := _effect->>'effect_type';
    _attribute_key := nullif(_effect->>'attribute_key', '');
    _polarity := coalesce(nullif(_effect->>'polarity', ''), 'buff');
    _value_mode := coalesce(nullif(_effect->>'value_mode', ''), 'fixed');
    _amount := coalesce(nullif(_effect->>'amount', '')::numeric, 0);
    _until_combat_end := coalesce((_effect->>'until_combat_end')::boolean, false) AND old.battle_id IS NOT NULL;
    _duration := CASE WHEN _until_combat_end THEN 1
      ELSE greatest(1, coalesce(nullif(_effect->>'duration', '')::integer, 1)) END;
    _effect_name := coalesce(nullif(_effect->>'name', ''), _ability_name);
    _damage_scope := coalesce(nullif(_effect->>'damage_scope', ''), 'any');
    _damage_reduction_scope := coalesce(nullif(_effect->>'damage_reduction_scope', ''), 'physical');
    _damage_reduction_type_id := nullif(_effect->>'damage_reduction_type_id', '')::uuid;
    _damage_reduction_magic_level := nullif(_effect->>'damage_reduction_magic_level', '');
    _target_scope := coalesce(nullif(_effect->>'target_scope', ''), 'target');
    if _target_scope not in ('caster', 'target') then raise exception 'Destino de efeito de encerramento inválido'; end if;
    _effect_character_id := case when _target_scope = 'caster' then _caster_character_id else _target_character_id end;
    if jsonb_typeof(_effect->'damage_reduction_type_ids') = 'array' then
      select coalesce(array_agg(value::uuid), array[]::uuid[]) into _damage_reduction_type_ids
      from jsonb_array_elements_text(_effect->'damage_reduction_type_ids') as parsed(value);
    elsif _damage_reduction_type_id is not null then
      _damage_reduction_type_ids := array[_damage_reduction_type_id];
    else
      _damage_reduction_type_ids := null;
    end if;
    if jsonb_typeof(_effect->'damage_reduction_magic_levels') = 'array' then
      select coalesce(array_agg(value), array[]::text[]) into _damage_reduction_magic_levels
      from jsonb_array_elements_text(_effect->'damage_reduction_magic_levels') as parsed(value);
    elsif _damage_reduction_magic_level is not null then
      _damage_reduction_magic_levels := array[_damage_reduction_magic_level];
    else
      _damage_reduction_magic_levels := null;
    end if;
    IF _damage_scope NOT IN ('any', 'physical', 'magical') THEN
      RAISE EXCEPTION 'Escopo de Dano Causado inválido';
    END IF;

    if _effect_type is null or _effect_type not in (
      'status','regeneration','mana_regeneration','mana_used',
      'no_regen_hp','no_regen_mana','stun','magic_prohibition','damage_dealt','damage_reduction','no_mana','healing','invincible','healing_blocked','magic_healing_reversal'
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
        if _damage_reduction_type_ids is null then
          if _damage_reduction_type_id is not null then _damage_reduction_type_ids := array[_damage_reduction_type_id];
          else _damage_reduction_type_ids := array[]::uuid[]; end if;
        end if;
        if _damage_reduction_magic_levels is null then
          if _damage_reduction_magic_level is not null then _damage_reduction_magic_levels := array[_damage_reduction_magic_level];
          else _damage_reduction_magic_levels := array[]::text[]; end if;
        end if;
        if cardinality(_damage_reduction_type_ids) > 0 and exists (
          select 1 from unnest(_damage_reduction_type_ids) as selected(id)
          where not exists (select 1 from public.damage_types dt where dt.id = selected.id)
        ) then raise exception 'Selecione tipos mágicos válidos para a mitigação'; end if;
        if cardinality(_damage_reduction_magic_levels) > 0 and exists (
          select 1 from unnest(_damage_reduction_magic_levels) as selected(level)
          where selected.level not in ('baixa','media','alta')
        ) then raise exception 'Selecione graus mágicos válidos para a mitigação'; end if;
        _damage_reduction_type_id := null;
        _damage_reduction_magic_level := null;
      else
        raise exception 'Categoria de mitigação inválida';
      end if;
    elsif _effect_type = 'healing' then
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
    elsif _effect_type = 'invincible' then
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
    elsif _effect_type in ('healing_blocked', 'magic_healing_reversal') then
      IF _effect_type = 'magic_healing_reversal' THEN
        IF COALESCE(NULLIF(_effect->>'magic_healing_reversal_damage_mode', ''), 'healing_amount')
          NOT IN ('healing_amount', 'custom', 'both') THEN
          RAISE EXCEPTION 'Modo de dano da Reversão de Cura inválido';
        END IF;
        IF COALESCE(NULLIF(_effect->>'magic_healing_reversal_custom_damage', '')::numeric, 0) < 0
          OR COALESCE(NULLIF(_effect->>'magic_healing_reversal_custom_damage', '')::numeric, 0) > 1000000 THEN
          RAISE EXCEPTION 'Dano customizado da Reversão de Cura deve ficar entre 0 e 1000000';
        END IF;
        IF jsonb_typeof(_effect->'magic_healing_type_ids') = 'array' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(_effect->'magic_healing_type_ids') selected(value)
          WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id = selected.value::uuid)
        ) THEN
          RAISE EXCEPTION 'A Reversão de Cura contém um tipo mágico inválido';
        END IF;
        IF jsonb_typeof(_effect->'magic_healing_magic_levels') = 'array' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(_effect->'magic_healing_magic_levels') selected(value)
          WHERE selected.value NOT IN ('baixa', 'media', 'alta')
        ) THEN
          RAISE EXCEPTION 'A Reversão de Cura contém um nível mágico inválido';
        END IF;
        _effect_type := 'healing_blocked';
      END IF;
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'debuff';
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

    if _effect_type = 'healing' then
      perform public.apply_ability_healing(_effect_character_id, old.battle_id, _effect || jsonb_build_object('_runtime_healer_character_id', _caster_character_id), true, true);
      continue;
    end if;

    insert into public.battle_effects (
      battle_id, character_id, name, effect_type, attribute_key, polarity,
      value_mode, amount, duration, until_combat_end, duration_scope, source_character_ability_id,
      effect_group_id, is_end_effect, damage_scope,
      damage_reduction_scope, damage_reduction_type_id, damage_reduction_magic_level,
      damage_reduction_type_ids, damage_reduction_magic_levels,
      target_character_id, effect_data
    ) values (
      old.battle_id, _effect_character_id, _ability_name || ': ' || _effect_name,
      _effect_type, _attribute_key, _polarity, _value_mode, _amount, _duration, _until_combat_end,
      old.duration_scope, old.source_character_ability_id, old.effect_group_id, true, _damage_scope,
      _damage_reduction_scope, _damage_reduction_type_id, _damage_reduction_magic_level,
      _damage_reduction_type_ids, _damage_reduction_magic_levels, _target_character_id, _effect
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
  _until_combat_end boolean := false;
  _effect_name text;
  _damage_scope text;
  _damage_reduction_scope text;
  _damage_reduction_type_id uuid;
  _damage_reduction_magic_level text;
  _damage_reduction_type_ids uuid[];
  _damage_reduction_magic_levels text[];
  _target_scope text;
  _effect_character_id uuid;
  _effect_character_ids uuid[];
  _healing_timing text;
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
  if not _is_master then
    raise exception 'Apenas o mestre pode ativar habilidades';
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
    _until_combat_end := coalesce((_effect->>'until_combat_end')::boolean, false);
    IF _effect_type = 'healing'
       AND coalesce(_effect->>'healing_timing', 'instant') <> 'per_turn' THEN
      _until_combat_end := false;
    END IF;
    IF _until_combat_end AND _effective_battle_id IS NULL THEN
      RAISE EXCEPTION 'Efeitos até o fim do combate só podem ser aplicados durante uma batalha ativa';
    END IF;
    _duration := CASE WHEN _until_combat_end THEN 1
      ELSE coalesce(nullif(_effect->>'duration', '')::integer, 1) END;
    _effect_name := coalesce(nullif(_effect->>'name', ''), _assignment.name);
    _damage_scope := coalesce(nullif(_effect->>'damage_scope', ''), 'any');
    _damage_reduction_scope := coalesce(nullif(_effect->>'damage_reduction_scope', ''), 'physical');
    _damage_reduction_type_id := nullif(_effect->>'damage_reduction_type_id', '')::uuid;
    _damage_reduction_magic_level := nullif(_effect->>'damage_reduction_magic_level', '');
    _target_scope := coalesce(nullif(_effect->>'target_scope', ''), 'target');
    if _target_scope not in ('caster', 'target', 'both') then raise exception 'Destino de efeito inválido'; end if;
    if coalesce((_effect->>'apply_both_on_activation')::boolean, false) then
      if _assignment.character_id = _target_character_id then
        _effect_character_ids := array[_assignment.character_id];
      else
        _effect_character_ids := array[_assignment.character_id, _target_character_id];
      end if;
    elsif _assignment.character_id = _target_character_id then
      if _target_scope in ('caster', 'both') then _effect_character_ids := array[_assignment.character_id];
      else _effect_character_ids := array[]::uuid[]; end if;
    elsif _target_scope in ('target', 'both') then
      _effect_character_ids := array[_target_character_id];
    else
      _effect_character_ids := array[]::uuid[];
    end if;
    if jsonb_typeof(_effect->'damage_reduction_type_ids') = 'array' then
      select coalesce(array_agg(value::uuid), array[]::uuid[]) into _damage_reduction_type_ids
      from jsonb_array_elements_text(_effect->'damage_reduction_type_ids') as parsed(value);
    elsif _damage_reduction_type_id is not null then
      _damage_reduction_type_ids := array[_damage_reduction_type_id];
    else
      _damage_reduction_type_ids := null;
    end if;
    if jsonb_typeof(_effect->'damage_reduction_magic_levels') = 'array' then
      select coalesce(array_agg(value), array[]::text[]) into _damage_reduction_magic_levels
      from jsonb_array_elements_text(_effect->'damage_reduction_magic_levels') as parsed(value);
    elsif _damage_reduction_magic_level is not null then
      _damage_reduction_magic_levels := array[_damage_reduction_magic_level];
    else
      _damage_reduction_magic_levels := null;
    end if;
    IF _damage_scope NOT IN ('any', 'physical', 'magical') THEN
      RAISE EXCEPTION 'Escopo de Dano Causado inválido';
    END IF;

    if _effect_type is null or _effect_type not in (
      'status','regeneration','mana_regeneration','mana_used',
      'no_regen_hp','no_regen_mana','stun','magic_prohibition','damage_dealt','damage_reduction','no_mana','healing','invincible','healing_blocked','magic_healing_reversal'
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
        if _damage_reduction_type_ids is null then
          if _damage_reduction_type_id is not null then _damage_reduction_type_ids := array[_damage_reduction_type_id];
          else _damage_reduction_type_ids := array[]::uuid[]; end if;
        end if;
        if _damage_reduction_magic_levels is null then
          if _damage_reduction_magic_level is not null then _damage_reduction_magic_levels := array[_damage_reduction_magic_level];
          else _damage_reduction_magic_levels := array[]::text[]; end if;
        end if;
        if cardinality(_damage_reduction_type_ids) > 0 and exists (
          select 1 from unnest(_damage_reduction_type_ids) as selected(id)
          where not exists (select 1 from public.damage_types dt where dt.id = selected.id)
        ) then raise exception 'Selecione tipos mágicos válidos para a mitigação'; end if;
        if cardinality(_damage_reduction_magic_levels) > 0 and exists (
          select 1 from unnest(_damage_reduction_magic_levels) as selected(level)
          where selected.level not in ('baixa','media','alta')
        ) then raise exception 'Selecione graus mágicos válidos para a mitigação'; end if;
        _damage_reduction_type_id := null;
        _damage_reduction_magic_level := null;
      else
        raise exception 'Categoria de mitigação inválida';
      end if;
    elsif _effect_type = 'healing' then
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
      _damage_reduction_scope := 'physical';
      _damage_reduction_type_id := null;
      _damage_reduction_magic_level := null;
      _damage_reduction_type_ids := null;
      _damage_reduction_magic_levels := null;
    elsif _effect_type = 'invincible' then
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
    elsif _effect_type in ('healing_blocked', 'magic_healing_reversal') then
      IF _effect_type = 'magic_healing_reversal' THEN
        IF COALESCE(NULLIF(_effect->>'magic_healing_reversal_damage_mode', ''), 'healing_amount')
          NOT IN ('healing_amount', 'custom', 'both') THEN
          RAISE EXCEPTION 'Modo de dano da Reversão de Cura inválido';
        END IF;
        IF COALESCE(NULLIF(_effect->>'magic_healing_reversal_custom_damage', '')::numeric, 0) < 0
          OR COALESCE(NULLIF(_effect->>'magic_healing_reversal_custom_damage', '')::numeric, 0) > 1000000 THEN
          RAISE EXCEPTION 'Dano customizado da Reversão de Cura deve ficar entre 0 e 1000000';
        END IF;
        IF jsonb_typeof(_effect->'magic_healing_type_ids') = 'array' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(_effect->'magic_healing_type_ids') selected(value)
          WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id = selected.value::uuid)
        ) THEN
          RAISE EXCEPTION 'A Reversão de Cura contém um tipo mágico inválido';
        END IF;
        IF jsonb_typeof(_effect->'magic_healing_magic_levels') = 'array' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(_effect->'magic_healing_magic_levels') selected(value)
          WHERE selected.value NOT IN ('baixa', 'media', 'alta')
        ) THEN
          RAISE EXCEPTION 'A Reversão de Cura contém um nível mágico inválido';
        END IF;
        _effect_type := 'healing_blocked';
      END IF;
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'debuff';
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

    if cardinality(_effect_character_ids) = 0 then continue; end if;
    foreach _effect_character_id in array _effect_character_ids loop
      if _effect_type = 'healing' then
        _healing_timing := coalesce(nullif(_effect->>'healing_timing', ''), 'instant');
        if _healing_timing not in ('instant', 'per_turn') then raise exception 'Modo de cura inválido'; end if;
        if coalesce((_effect->>'healing_hp_enabled')::boolean, false)
           or coalesce((_effect->>'healing_mana_enabled')::boolean, false)
           or coalesce((_effect->>'healing_body_enabled')::boolean, false)
           or coalesce((_effect->>'healing_sanity_enabled')::boolean, false)
           or coalesce((_effect->>'healing_remove_debuffs')::boolean, false)
           or coalesce(nullif(_effect->>'healing_reduce_debuff_turns_fixed','')::integer, 0) > 0
           or coalesce(nullif(_effect->>'healing_reduce_debuff_turns_percent','')::numeric, 0) > 0 then
          perform public.apply_ability_healing(
            _effect_character_id, _effective_battle_id, _effect || jsonb_build_object('_runtime_healer_character_id', _assignment.character_id), _healing_timing <> 'per_turn', true
          );
        else
          raise exception 'Configure pelo menos uma ação para a cura';
        end if;
        if nullif(_effect->>'healing_damage_type_id','') is not null and not exists (
          select 1 from public.damage_types where id = (_effect->>'healing_damage_type_id')::uuid
        ) then raise exception 'Tipo mágico da cura inválido'; end if;
        if nullif(_effect->>'healing_magic_level','') is not null
           and _effect->>'healing_magic_level' not in ('baixa','media','alta') then
          raise exception 'Grau mágico da cura inválido';
        end if;
        if _healing_timing = 'per_turn' then
          insert into public.battle_effects (
            battle_id, character_id, name, effect_type, attribute_key, polarity,
            value_mode, amount, duration, until_combat_end, duration_scope, source_character_ability_id,
            effect_group_id, is_end_effect, damage_scope, target_character_id, effect_data
          ) values (
            _effective_battle_id, _effect_character_id, _assignment.name || ': ' || _effect_name,
            'healing', null, 'buff', 'fixed', 0, _duration, _until_combat_end, 'global', _assignment.id,
            _effect_group_id, false, 'any', _target_character_id, _effect || jsonb_build_object('_runtime_healer_character_id', _assignment.character_id)
          );
        end if;
        continue;
      end if;

      insert into public.battle_effects (
        battle_id, character_id, name, effect_type, attribute_key, polarity,
        value_mode, amount, duration, until_combat_end, duration_scope, source_character_ability_id,
        effect_group_id, is_end_effect, damage_scope,
        damage_reduction_scope, damage_reduction_type_id, damage_reduction_magic_level,
        damage_reduction_type_ids, damage_reduction_magic_levels,
        target_character_id, effect_data
      ) values (
        _effective_battle_id, _effect_character_id, _assignment.name || ': ' || _effect_name,
        _effect_type, _attribute_key, _polarity, _value_mode, _amount,
        _duration, _until_combat_end, 'global', _assignment.id, _effect_group_id, false, _damage_scope,
        _damage_reduction_scope, _damage_reduction_type_id, _damage_reduction_magic_level,
        _damage_reduction_type_ids, _damage_reduction_magic_levels,
        _target_character_id, _effect
      );
    end loop;
  end loop;

  -- Queue a custom script callback after the normal activation has committed its effects.
  perform public.queue_ability_script_event(
    'habilidade_ativada',
    _assignment.id,
    _assignment.character_id,
    _effective_battle_id,
    _target_character_id,
    null,
    jsonb_build_object('ability_name', _assignment.name, 'mana_cost_spent', _effective_mana_cost)
  );

  return _effective_mana_cost;
end;
$$;

CREATE OR REPLACE FUNCTION public.sync_character_race_effects(_character_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _race_id uuid;
  _starting_effects jsonb := '[]'::jsonb;
  _effect jsonb;
  _effect_index integer;
  _effect_type text;
  _stored_type text;
  _attribute_key text;
  _polarity text;
  _value_mode text;
  _amount numeric;
  _damage_scope text;
  _reduction_scope text;
  _type_ids uuid[];
  _magic_levels text[];
  _effect_name text;
BEGIN
  SELECT c.race_id
  INTO _race_id
  FROM public.characters c
  WHERE c.id = _character_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Remove only effects supplied by a previous race. Ability and manual effects remain untouched.
  DELETE FROM public.battle_effects e
  WHERE e.character_id = _character_id
    AND e.source_race_id IS NOT NULL
    AND e.source_race_id IS DISTINCT FROM _race_id;

  IF _race_id IS NULL THEN
    RETURN;
  END IF;

  SELECT r.starting_effects
  INTO _starting_effects
  FROM public.races r
  WHERE r.id = _race_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF jsonb_typeof(COALESCE(_starting_effects, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Os efeitos iniciais da raça precisam ser uma lista.';
  END IF;

  FOR _effect, _effect_index IN
    SELECT item.value, (item.ordinality - 1)::integer
    FROM jsonb_array_elements(COALESCE(_starting_effects, '[]'::jsonb))
      WITH ORDINALITY AS item(value, ordinality)
  LOOP
    _effect_type := COALESCE(NULLIF(_effect ->> 'effect_type', ''), 'status');
    IF _effect_type NOT IN (
      'status', 'regeneration', 'mana_regeneration', 'mana_used',
      'no_regen_hp', 'no_regen_mana', 'magic_prohibition', 'stun',
      'damage_dealt', 'no_mana', 'damage_reduction', 'invincible', 'healing_blocked', 'magic_healing_reversal'
    ) THEN
      RAISE EXCEPTION 'Tipo de efeito racial inválido: %', _effect_type;
    END IF;

    -- Mana regeneration uses the existing battle-effect regeneration implementation.
    _stored_type := CASE WHEN _effect_type = 'mana_regeneration' THEN 'regeneration' WHEN _effect_type = 'magic_healing_reversal' THEN 'healing_blocked' ELSE _effect_type END;
    _attribute_key := CASE
      WHEN _stored_type = 'status' THEN NULLIF(_effect ->> 'attribute_key', '')
      WHEN _stored_type = 'regeneration' THEN
        CASE WHEN _effect_type = 'mana_regeneration' THEN 'mana' ELSE NULLIF(_effect ->> 'attribute_key', '') END
      ELSE NULL
    END;
    IF _stored_type = 'status' AND _attribute_key IS NULL THEN
      RAISE EXCEPTION 'Efeito racial de status precisa escolher um atributo.';
    END IF;
    IF _stored_type = 'regeneration' AND _attribute_key NOT IN ('hp', 'mana') THEN
      RAISE EXCEPTION 'Efeito racial de regeneração precisa usar HP ou Mana.';
    END IF;

    _polarity := CASE
      WHEN _stored_type IN ('magic_prohibition', 'no_mana', 'healing_blocked') OR _effect_type = 'magic_healing_reversal' THEN 'debuff'
      WHEN _stored_type IN ('damage_reduction', 'invincible') THEN 'buff'
      ELSE COALESCE(NULLIF(_effect ->> 'polarity', ''), 'buff')
    END;
    _value_mode := CASE WHEN _effect ->> 'value_mode' = 'percent' THEN 'percent' ELSE 'fixed' END;
    _amount := GREATEST(0, COALESCE(NULLIF(_effect ->> 'amount', '')::numeric, 0));
    _damage_scope := CASE WHEN _effect ->> 'damage_scope' IN ('physical', 'magical') THEN _effect ->> 'damage_scope' ELSE 'any' END;
    _reduction_scope := CASE WHEN _effect ->> 'damage_reduction_scope' = 'magical' THEN 'magical' ELSE 'physical' END;
    _effect_name := LEFT(COALESCE(NULLIF(BTRIM(_effect ->> 'name'), ''), 'Efeito racial'), 160);
    IF _effect_type = 'magic_healing_reversal' THEN
      IF COALESCE(NULLIF(_effect->>'magic_healing_reversal_damage_mode', ''), 'healing_amount') NOT IN ('healing_amount', 'custom', 'both') THEN
        RAISE EXCEPTION 'Modo de dano da Reversão de Cura inválido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'magic_healing_reversal_custom_damage', '')::numeric, 0) < 0 OR COALESCE(NULLIF(_effect->>'magic_healing_reversal_custom_damage', '')::numeric, 0) > 1000000 THEN
        RAISE EXCEPTION 'Dano customizado da Reversão de Cura deve ficar entre 0 e 1000000';
      END IF;
    END IF;
    IF _effect_type = 'magic_healing_reversal' THEN _amount := 0; END IF;

    _type_ids := NULL;
    _magic_levels := NULL;
    IF _stored_type = 'damage_reduction' AND _reduction_scope = 'magical' THEN
      IF jsonb_typeof(_effect -> 'damage_reduction_type_ids') = 'array' THEN
        SELECT COALESCE(array_agg(value::uuid), ARRAY[]::uuid[])
        INTO _type_ids
        FROM jsonb_array_elements_text(_effect -> 'damage_reduction_type_ids') AS ids(value);
      ELSE
        _type_ids := ARRAY[]::uuid[];
      END IF;

      IF jsonb_typeof(_effect -> 'damage_reduction_magic_levels') = 'array' THEN
        SELECT COALESCE(array_agg(value), ARRAY[]::text[])
        INTO _magic_levels
        FROM jsonb_array_elements_text(_effect -> 'damage_reduction_magic_levels') AS levels(value);
      ELSE
        _magic_levels := ARRAY[]::text[];
      END IF;
    END IF;

    INSERT INTO public.battle_effects (
      battle_id, character_id, name, effect_type, attribute_key, polarity, value_mode, amount,
      duration, duration_scope, damage_scope, damage_reduction_scope,
      damage_reduction_type_id, damage_reduction_magic_level,
      damage_reduction_type_ids, damage_reduction_magic_levels,
      source_character_ability_id, target_character_id, effect_data, effect_group_id,
      is_end_effect, until_combat_end, source_race_id, source_race_effect_index
    ) VALUES (
      NULL, _character_id, _effect_name, _stored_type, _attribute_key, _polarity, _value_mode, _amount,
      1, 'individual', _damage_scope, _reduction_scope,
      NULL, NULL, _type_ids, _magic_levels,
      NULL, NULL, CASE WHEN _effect_type = 'magic_healing_reversal' THEN _effect ELSE '{}'::jsonb END, NULL,
      false, false, _race_id, _effect_index
    )
    ON CONFLICT ON CONSTRAINT battle_effects_race_effect_key
    DO UPDATE SET
      name = EXCLUDED.name,
      effect_type = EXCLUDED.effect_type,
      attribute_key = EXCLUDED.attribute_key,
      polarity = EXCLUDED.polarity,
      value_mode = EXCLUDED.value_mode,
      amount = EXCLUDED.amount,
      duration = 1,
      duration_scope = EXCLUDED.duration_scope,
      damage_scope = EXCLUDED.damage_scope,
      damage_reduction_scope = EXCLUDED.damage_reduction_scope,
      damage_reduction_type_id = EXCLUDED.damage_reduction_type_id,
      damage_reduction_magic_level = EXCLUDED.damage_reduction_magic_level,
      damage_reduction_type_ids = EXCLUDED.damage_reduction_type_ids,
      damage_reduction_magic_levels = EXCLUDED.damage_reduction_magic_levels,
      target_character_id = NULL,
      effect_data = EXCLUDED.effect_data,
      effect_group_id = NULL,
      is_end_effect = false,
      until_combat_end = false;
  END LOOP;

  -- Delete removed trailing effects from the race template.
  DELETE FROM public.battle_effects e
  WHERE e.character_id = _character_id
    AND e.source_race_id = _race_id
    AND e.source_race_effect_index >= jsonb_array_length(COALESCE(_starting_effects, '[]'::jsonb));
END;
$function$;
