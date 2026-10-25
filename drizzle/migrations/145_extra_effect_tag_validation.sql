BEGIN;
CREATE OR REPLACE FUNCTION public.apply_character_ability_end_effects()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      'no_regen_hp','no_regen_mana','stun','magic_prohibition','damage_dealt','damage_reduction','damage_received','no_mana','healing','invincible','healing_blocked','magic_healing_reversal','temporal_freeze','visual_tag'
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
    elsif _effect_type = 'damage_received' then
      _attribute_key := null;
      _polarity := 'debuff';
      IF COALESCE(NULLIF(_effect->>'damage_received_scope', ''), 'any') NOT IN ('any', 'physical', 'magical', 'race') THEN
        RAISE EXCEPTION 'Categoria de Dano Recebido inválida';
      END IF;
      IF _amount > 1000000 THEN
        RAISE EXCEPTION 'Dano Recebido deve ficar entre 0 e 1000000';
      END IF;
      IF COALESCE(NULLIF(_effect->>'damage_received_scope', ''), 'any') = 'race'
        AND (
          NULLIF(_effect->>'damage_received_race_id', '') IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.races r WHERE r.id::text = _effect->>'damage_received_race_id')
        ) THEN
        RAISE EXCEPTION 'Selecione uma raça válida para Dano Recebido';
      END IF;
      IF jsonb_typeof(_effect->'damage_received_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_received_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value)
      ) THEN
        RAISE EXCEPTION 'Dano Recebido contém um tipo mágico inválido';
      END IF;
      IF jsonb_typeof(_effect->'damage_received_magic_levels') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_received_magic_levels') selected(value)
        WHERE selected.value NOT IN ('baixa', 'media', 'alta')
      ) THEN
        RAISE EXCEPTION 'Dano Recebido contém um nível mágico inválido';
      END IF;
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
$function$
;

CREATE OR REPLACE FUNCTION public.trigger_damage_vulnerability_effects(_battle_id uuid, _character_id uuid, _damage_kind text, _physical_damage_type_id uuid, _damage_type_id uuid, _magic_level text, _damage_total integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _trigger record;
  _config jsonb;
  _effects jsonb;
  _spawn_effect jsonb;
  _effect_data jsonb;
  _scope text;
  _physical_types jsonb;
  _magic_types jsonb;
  _magic_levels jsonb;
  _matches boolean;
  _physical_match boolean;
  _magic_match boolean;
  _effect_type text;
  _insert_effect_type text;
  _attribute_key text;
  _polarity text;
  _value_mode text;
  _amount numeric;
  _spawn_duration integer;
  _damage_scope text;
  _damage_reduction_scope text;
  _damage_reduction_type_id uuid;
  _damage_reduction_magic_level text;
  _damage_reduction_type_ids uuid[];
  _damage_reduction_magic_levels text[];
  _healing_timing text;
  _configured_healing boolean;
  _trigger_name text;
  _spawn_name text;
  _effect_group_id uuid;
  _applied_count integer := 0;
BEGIN
  -- The Edge Function calls this with the authenticated master's JWT, so instant
  -- healing can safely run normal Reversão de Cura damage using the same auth context.
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode processar Vulnerabilidade de Dano';
  END IF;
  IF _damage_total IS NULL OR _damage_total <= 0 OR _character_id IS NULL THEN
    RETURN 0;
  END IF;
  IF _damage_kind NOT IN ('physical','magical','hybrid') THEN
    RETURN 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.characters c WHERE c.id = _character_id) THEN
    RETURN 0;
  END IF;
  IF _battle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.battles b WHERE b.id = _battle_id AND b.active IS TRUE
  ) THEN
    RETURN 0;
  END IF;

  FOR _trigger IN
    SELECT e.id AS trigger_id, e.name AS trigger_name, e.effect_data AS config
    FROM public.battle_effects e
    WHERE e.character_id = _character_id
      AND e.effect_type = 'damage_vulnerability'
      AND e.duration > 0
      AND (e.battle_id IS NULL OR e.battle_id = _battle_id)
    UNION ALL
    SELECT ca.id AS trigger_id, ca.name AS trigger_name, passive.effect AS config
    FROM public.character_abilities ca
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(COALESCE(ca.passive_effects, '[]'::jsonb)) = 'array'
        THEN COALESCE(ca.passive_effects, '[]'::jsonb) ELSE '[]'::jsonb END
    ) AS passive(effect)
    WHERE ca.character_id = _character_id
      AND passive.effect->>'effect_type' = 'damage_vulnerability'
  LOOP
    _config := COALESCE(_trigger.config, '{}'::jsonb);
    _scope := COALESCE(NULLIF(_config->>'damage_vulnerability_scope',''), 'any');
    _physical_types := CASE WHEN jsonb_typeof(_config->'damage_vulnerability_physical_type_ids') = 'array'
      THEN _config->'damage_vulnerability_physical_type_ids' ELSE '[]'::jsonb END;
    _magic_types := CASE WHEN jsonb_typeof(_config->'damage_vulnerability_magic_type_ids') = 'array'
      THEN _config->'damage_vulnerability_magic_type_ids' ELSE '[]'::jsonb END;
    _magic_levels := CASE WHEN jsonb_typeof(_config->'damage_vulnerability_magic_levels') = 'array'
      THEN _config->'damage_vulnerability_magic_levels' ELSE '[]'::jsonb END;
    _physical_match := false;
    _magic_match := false;

    IF _scope IN ('physical','any') AND _damage_kind IN ('physical','hybrid') THEN
      _physical_match := jsonb_array_length(_physical_types) = 0
        OR (_physical_damage_type_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(_physical_types) selected(value)
          WHERE selected.value = _physical_damage_type_id::text
        ));
    END IF;
    IF _scope IN ('magical','any') AND _damage_kind IN ('magical','hybrid') THEN
      _magic_match := (
        jsonb_array_length(_magic_types) = 0
        OR (_damage_type_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(_magic_types) selected(value)
          WHERE selected.value = _damage_type_id::text
        ))
      ) AND (
        jsonb_array_length(_magic_levels) = 0
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(_magic_levels) selected(value)
          WHERE selected.value = _magic_level
        )
      );
    END IF;
    _matches := _physical_match OR _magic_match;
    IF NOT _matches THEN CONTINUE; END IF;

    -- Existing vulnerability configs without a nested array stay compatible:
    -- they are treated as the original status buff/debuff.
    IF jsonb_typeof(_config->'damage_vulnerability_effects') = 'array' THEN
      _effects := _config->'damage_vulnerability_effects';
    ELSE
      _effects := jsonb_build_array(jsonb_build_object(
        'name', COALESCE(NULLIF(_config->>'name',''), _trigger.trigger_name, 'Efeito aplicado'),
        'effect_type', 'status',
        'attribute_key', _config->>'attribute_key',
        'polarity', COALESCE(NULLIF(_config->>'polarity',''), 'debuff'),
        'value_mode', COALESCE(NULLIF(_config->>'value_mode',''), 'fixed'),
        'amount', COALESCE(NULLIF(_config->>'amount','')::numeric, 0),
        'duration', 1
      ));
    END IF;

    _effect_group_id := gen_random_uuid();
    _trigger_name := COALESCE(NULLIF(_config->>'name',''), _trigger.trigger_name, 'Vulnerabilidade de Dano');

    FOR _spawn_effect IN
      SELECT value FROM jsonb_array_elements(COALESCE(_effects, '[]'::jsonb))
    LOOP
      _effect_type := NULLIF(_spawn_effect->>'effect_type','');
      -- A vulnerability cannot spawn another vulnerability trigger: that would allow
      -- recursive chains whenever the newly-created trigger is hit.
      IF _effect_type IS NULL OR _effect_type = 'damage_vulnerability' OR _effect_type NOT IN (
        'status','regeneration','mana_regeneration','mana_used','no_regen_hp','no_regen_mana',
        'magic_prohibition','stun','damage_dealt','damage_reduction','damage_received',
        'no_mana','healing','invincible','healing_blocked','magic_healing_reversal','dot_resistance','temporal_freeze','visual_tag'
      ) THEN
        CONTINUE;
      END IF;

      _insert_effect_type := _effect_type;
      _attribute_key := NULLIF(_spawn_effect->>'attribute_key','');
      _polarity := COALESCE(NULLIF(_spawn_effect->>'polarity',''), 'buff');
      _value_mode := COALESCE(NULLIF(_spawn_effect->>'value_mode',''), 'fixed');
      _amount := LEAST(1000000, GREATEST(0, COALESCE(NULLIF(_spawn_effect->>'amount','')::numeric, 0)));
      _damage_scope := COALESCE(NULLIF(_spawn_effect->>'damage_scope',''), 'any');
      _damage_reduction_scope := COALESCE(NULLIF(_spawn_effect->>'damage_reduction_scope',''), 'physical');
      _damage_reduction_type_id := NULL;
      _damage_reduction_magic_level := NULL;
      _damage_reduction_type_ids := ARRAY[]::uuid[];
      _damage_reduction_magic_levels := ARRAY[]::text[];
      _healing_timing := COALESCE(NULLIF(_spawn_effect->>'healing_timing',''), 'instant');
      _spawn_name := COALESCE(NULLIF(_spawn_effect->>'name',''), _effect_type);

      _spawn_duration := CASE
        WHEN COALESCE(_config->>'damage_vulnerability_applied_duration','') ~ '^[0-9]+$'
          THEN LEAST(1000, GREATEST(1, (_config->>'damage_vulnerability_applied_duration')::integer))
        WHEN COALESCE(_spawn_effect->>'duration','') ~ '^[0-9]+$'
          THEN LEAST(1000, GREATEST(1, (_spawn_effect->>'duration')::integer))
        ELSE 1
      END;

      IF _polarity NOT IN ('buff','debuff') OR _value_mode NOT IN ('fixed','percent') OR _damage_scope NOT IN ('any','physical','magical') THEN
        CONTINUE;
      END IF;

      IF _effect_type = 'status' THEN
        IF _attribute_key IS NULL OR NOT EXISTS (
          SELECT 1 FROM public.attribute_definitions ad WHERE ad.key = _attribute_key
        ) THEN CONTINUE; END IF;
      ELSIF _effect_type = 'regeneration' THEN
        IF _attribute_key IS NULL OR _attribute_key NOT IN ('hp','mana') THEN CONTINUE; END IF;
      ELSIF _effect_type = 'mana_regeneration' THEN
        _insert_effect_type := 'regeneration';
        _attribute_key := 'mana';
      ELSIF _effect_type = 'mana_used' THEN
        _attribute_key := NULL;
      ELSIF _effect_type = 'damage_dealt' THEN
        _attribute_key := NULL;
        IF jsonb_typeof(_spawn_effect->'damage_dealt_physical_type_ids') = 'array' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(_spawn_effect->'damage_dealt_physical_type_ids') selected(value)
          WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value AND dt.category='physical')
        ) THEN CONTINUE; END IF;
      ELSIF _effect_type = 'damage_reduction' THEN
        IF _polarity <> 'buff' OR _damage_reduction_scope NOT IN ('physical','magical') THEN CONTINUE; END IF;
        _attribute_key := NULL;

        IF jsonb_typeof(_spawn_effect->'damage_reduction_type_ids') = 'array' THEN
          IF EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(_spawn_effect->'damage_reduction_type_ids') selected(value)
            WHERE NOT EXISTS (
              SELECT 1 FROM public.damage_types dt
              WHERE dt.id::text = selected.value AND dt.category = _damage_reduction_scope
            )
          ) THEN CONTINUE; END IF;
          SELECT COALESCE(array_agg(selected.value::uuid), ARRAY[]::uuid[])
          INTO _damage_reduction_type_ids
          FROM jsonb_array_elements_text(_spawn_effect->'damage_reduction_type_ids') selected(value);
        ELSIF NULLIF(_spawn_effect->>'damage_reduction_type_id','') IS NOT NULL THEN
          IF NOT EXISTS (
            SELECT 1 FROM public.damage_types dt
            WHERE dt.id::text = _spawn_effect->>'damage_reduction_type_id'
              AND dt.category = _damage_reduction_scope
          ) THEN CONTINUE; END IF;
          _damage_reduction_type_ids := ARRAY[(_spawn_effect->>'damage_reduction_type_id')::uuid];
        END IF;

        IF jsonb_typeof(_spawn_effect->'damage_reduction_magic_levels') = 'array' THEN
          IF EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(_spawn_effect->'damage_reduction_magic_levels') selected(value)
            WHERE selected.value NOT IN ('baixa','media','alta')
          ) THEN CONTINUE; END IF;
          SELECT COALESCE(array_agg(selected.value), ARRAY[]::text[])
          INTO _damage_reduction_magic_levels
          FROM jsonb_array_elements_text(_spawn_effect->'damage_reduction_magic_levels') selected(value);
        ELSIF NULLIF(_spawn_effect->>'damage_reduction_magic_level','') IN ('baixa','media','alta') THEN
          _damage_reduction_magic_levels := ARRAY[_spawn_effect->>'damage_reduction_magic_level'];
        END IF;

        -- The singular legacy columns stay NULL when using the multi-select columns.
        IF _damage_reduction_scope = 'physical' THEN
          -- The table CHECK requires NULL, not an empty array, for physical mitigation levels.
          _damage_reduction_magic_levels := NULL;
        END IF;
      ELSIF _effect_type = 'damage_received' THEN
        _attribute_key := NULL;
        _polarity := 'debuff';
        IF COALESCE(NULLIF(_spawn_effect->>'damage_received_scope',''),'any') NOT IN ('any','physical','magical','race') THEN CONTINUE; END IF;
        IF COALESCE(NULLIF(_spawn_effect->>'damage_received_scope',''),'any') = 'race'
          AND NOT EXISTS (SELECT 1 FROM public.races r WHERE r.id::text = _spawn_effect->>'damage_received_race_id') THEN
          CONTINUE;
        END IF;
      ELSIF _effect_type = 'healing' THEN
        _attribute_key := NULL;
        _polarity := 'buff';
        _amount := 0;
        _value_mode := 'fixed';
        _configured_healing := (
          COALESCE((_spawn_effect->>'healing_hp_enabled')::boolean,false)
          OR COALESCE((_spawn_effect->>'healing_mana_enabled')::boolean,false)
          OR COALESCE((_spawn_effect->>'healing_body_enabled')::boolean,false)
          OR COALESCE((_spawn_effect->>'healing_sanity_enabled')::boolean,false)
          OR COALESCE((_spawn_effect->>'healing_remove_debuffs')::boolean,false)
          OR COALESCE(NULLIF(_spawn_effect->>'healing_reduce_debuff_turns_fixed','')::integer,0) > 0
          OR COALESCE(NULLIF(_spawn_effect->>'healing_reduce_debuff_turns_percent','')::numeric,0) > 0
        );
        IF NOT _configured_healing THEN CONTINUE; END IF;
        IF _healing_timing NOT IN ('instant','per_turn') THEN CONTINUE; END IF;

        _effect_data := _spawn_effect || jsonb_build_object(
          '_runtime_healer_character_id', _character_id,
          'triggered_by', 'damage_vulnerability',
          'trigger_id', _trigger.trigger_id,
          'triggered_by_damage_kind', _damage_kind,
          'triggered_by_physical_damage_type_id', _physical_damage_type_id,
          'triggered_by_magic_type_id', _damage_type_id,
          'triggered_by_magic_level', _magic_level
        );
        PERFORM public.apply_ability_healing(
          _character_id, _battle_id, _effect_data,
          _healing_timing <> 'per_turn', true
        );
        IF _healing_timing = 'per_turn' THEN
          INSERT INTO public.battle_effects (
            battle_id, character_id, name, effect_type, attribute_key, polarity,
            value_mode, amount, duration, until_combat_end, duration_scope,
            source_character_ability_id, effect_group_id, is_end_effect, damage_scope,
            target_character_id, effect_data
          ) VALUES (
            _battle_id, _character_id, 'Vulnerabilidade: ' || _trigger_name || ' — ' || _spawn_name,
            'healing', NULL, 'buff', 'fixed', 0, _spawn_duration, false, 'global',
            NULL, _effect_group_id, false, 'any', _character_id, _effect_data
          );
        END IF;
        _applied_count := _applied_count + 1;
        CONTINUE;
      ELSIF _effect_type = 'magic_healing_reversal' THEN
        _insert_effect_type := 'healing_blocked';
        _attribute_key := NULL;
        _polarity := 'debuff';
        _value_mode := 'fixed';
        _amount := 0;
      ELSIF _effect_type = 'healing_blocked' THEN
        _attribute_key := NULL;
        _polarity := 'debuff';
        _value_mode := 'fixed';
        _amount := 0;
      ELSIF _effect_type = 'invincible' THEN
        _attribute_key := NULL;
        _polarity := 'buff';
        _value_mode := 'fixed';
        _amount := 0;
      ELSIF _effect_type = 'no_mana' THEN
        _attribute_key := NULL;
        _polarity := 'debuff';
        _value_mode := 'fixed';
        _amount := 0;
        _damage_scope := 'any';
      ELSIF _effect_type = 'magic_prohibition' THEN
        _attribute_key := NULL;
        _polarity := 'debuff';
        _value_mode := 'fixed';
        _amount := 0;
      ELSE
        -- no-regeneration and stun effects use their effect_type directly.
        _attribute_key := NULL;
        _value_mode := 'fixed';
        _amount := 0;
      END IF;

      _effect_data := _spawn_effect || jsonb_build_object(
        'triggered_by', 'damage_vulnerability',
        'trigger_id', _trigger.trigger_id,
        'triggered_by_damage_kind', _damage_kind,
        'triggered_by_physical_damage_type_id', _physical_damage_type_id,
        'triggered_by_magic_type_id', _damage_type_id,
        'triggered_by_magic_level', _magic_level
      );

      INSERT INTO public.battle_effects (
        battle_id, character_id, name, effect_type, attribute_key, polarity,
        value_mode, amount, duration, until_combat_end, duration_scope,
        source_character_ability_id, effect_group_id, is_end_effect, damage_scope,
        damage_reduction_scope, damage_reduction_type_id, damage_reduction_magic_level,
        damage_reduction_type_ids, damage_reduction_magic_levels,
        target_character_id, effect_data
      ) VALUES (
        _battle_id, _character_id, 'Vulnerabilidade: ' || _trigger_name || ' — ' || _spawn_name,
        _insert_effect_type, _attribute_key, _polarity, _value_mode, _amount,
        _spawn_duration, false, 'global', NULL, _effect_group_id, false, _damage_scope,
        _damage_reduction_scope,
        _damage_reduction_type_id, _damage_reduction_magic_level,
        CASE WHEN _insert_effect_type = 'damage_reduction' THEN _damage_reduction_type_ids ELSE NULL END,
        CASE WHEN _insert_effect_type = 'damage_reduction' THEN _damage_reduction_magic_levels ELSE NULL END,
        _character_id, _effect_data
      );
      _applied_count := _applied_count + 1;
    END LOOP;
  END LOOP;
  RETURN _applied_count;
END;
$function$
;
NOTIFY pgrst,'reload schema';
COMMIT;