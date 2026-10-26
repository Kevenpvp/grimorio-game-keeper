BEGIN;
CREATE OR REPLACE FUNCTION public.validate_mitigation_configuration(_settings jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  _field text;
  _expected text;
  _entry text;
  _grade text;
  _scope text := COALESCE(_settings->>'damage_reduction_scope','physical');
BEGIN
  IF _scope NOT IN ('physical','magical','both') THEN
    RAISE EXCEPTION 'Categoria de mitigação inválida';
  END IF;
  FOR _field,_expected IN SELECT * FROM (VALUES
    ('damage_reduction_physical_type_ids','physical'),
    ('damage_reduction_magic_type_ids','magical'),
    ('damage_reduction_physical_blacklist_ids','physical'),
    ('damage_reduction_magic_blacklist_ids','magical')
  ) AS v(field,category) LOOP
    IF _settings ? _field AND jsonb_typeof(_settings->_field) <> 'array' THEN
      RAISE EXCEPTION 'Seleção inválida na mitigação: %',_field;
    END IF;
    IF jsonb_typeof(_settings->_field)='array' THEN
      FOR _entry IN SELECT jsonb_array_elements_text(_settings->_field) LOOP
        IF NOT EXISTS(SELECT 1 FROM public.damage_types dt
          WHERE dt.id::text=_entry AND dt.category=_expected) THEN
          RAISE EXCEPTION 'Tipo de dano inválido na mitigação (%): %',_field,_entry;
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  IF _settings ? 'damage_reduction_magic_level_blacklist'
      AND jsonb_typeof(_settings->'damage_reduction_magic_level_blacklist') <> 'array' THEN
    RAISE EXCEPTION 'Blacklist de graus mágicos inválida';
  END IF;
  IF jsonb_typeof(_settings->'damage_reduction_magic_level_blacklist')='array' THEN
    FOR _grade IN SELECT jsonb_array_elements_text(_settings->'damage_reduction_magic_level_blacklist') LOOP
      IF _grade NOT IN ('baixa','media','alta') THEN
        RAISE EXCEPTION 'Grau mágico não registrado na blacklist: %',_grade;
      END IF;
    END LOOP;
  END IF;
END $fn$;
REVOKE ALL ON FUNCTION public.validate_mitigation_configuration(jsonb) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.activate_character_ability(_character_ability_id uuid, _target_character_id uuid, _battle_id uuid DEFAULT NULL::uuid, _extra_mana_cost integer DEFAULT 0, _dot_target_selections jsonb DEFAULT NULL::jsonb, _dot_attribute_values jsonb DEFAULT '{}'::jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  _effective_cooldown integer := 0;
  _cooldown_factor numeric := 1;
  _cooldown_virtue_id uuid;
  _race_mechanics jsonb := '{}'::jsonb;
  _class_mechanics jsonb := '{}'::jsonb;
  _virtue_multiplier numeric := 1;
  _once_use_inserted integer := 0;
  _effect_group_id uuid := gen_random_uuid();
  _is_master boolean := public.has_role(auth.uid(), 'master');
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;

  select * into _assignment
  from public.character_abilities
  where id = _character_ability_id
  for update;
  if not found then raise exception 'Habilidade não encontrada nesta ficha'; end if;

  _cooldown_virtue_id := COALESCE(_assignment.granted_by_virtue_id, _assignment.linked_by_virtue_id);
  SELECT COALESCE(r.special_mechanics, '{}'::jsonb), COALESCE(cl.special_mechanics, '{}'::jsonb)
  INTO _race_mechanics, _class_mechanics
  FROM public.characters c
  LEFT JOIN public.races r ON r.id = c.race_id
  LEFT JOIN public.classes cl ON cl.id = c.class_id
  WHERE c.id = _assignment.character_id;
  IF _cooldown_virtue_id IS NOT NULL THEN
    IF COALESCE(NULLIF(_race_mechanics->>'virtue_cooldown_reduction_percent', '')::numeric, 0) > 0 AND NOT COALESCE((_race_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_cooldown_virtue_id::text), false) THEN
      _cooldown_factor := _cooldown_factor * (1 - LEAST(100, GREATEST(0, (_race_mechanics->>'virtue_cooldown_reduction_percent')::numeric)) / 100);
    END IF;
    IF COALESCE(NULLIF(_class_mechanics->>'virtue_cooldown_reduction_percent', '')::numeric, 0) > 0 AND NOT COALESCE((_class_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_cooldown_virtue_id::text), false) THEN
      _cooldown_factor := _cooldown_factor * (1 - LEAST(100, GREATEST(0, (_class_mechanics->>'virtue_cooldown_reduction_percent')::numeric)) / 100);
    END IF;
  END IF;
  _effective_cooldown := GREATEST(0, FLOOR(_assignment.cooldown_turns * _cooldown_factor)::integer);

  IF _assignment.ability_id IS NULL AND _assignment.linked_by_virtue_id IS NOT NULL THEN
    IF COALESCE((_race_mechanics->>'duplicate_virtue_effects')::boolean, false) AND NOT COALESCE((_race_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_assignment.linked_by_virtue_id::text), false) THEN
      _virtue_multiplier := _virtue_multiplier * GREATEST(1, LEAST(10, COALESCE(NULLIF(_race_mechanics->>'virtue_effect_multiplier', '')::numeric, 2)));
    END IF;
    IF COALESCE((_class_mechanics->>'duplicate_virtue_effects')::boolean, false) AND NOT COALESCE((_class_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_assignment.linked_by_virtue_id::text), false) THEN
      _virtue_multiplier := _virtue_multiplier * GREATEST(1, LEAST(10, COALESCE(NULLIF(_class_mechanics->>'virtue_effect_multiplier', '')::numeric, 2)));
    END IF;
    _virtue_multiplier := GREATEST(1, LEAST(100, _virtue_multiplier));
    IF _virtue_multiplier > 1 THEN
      _assignment.effects := public.scale_racial_virtue_effect_json(COALESCE(_assignment.effects, '[]'::jsonb), _virtue_multiplier);
      _assignment.passive_effects := public.scale_racial_virtue_effect_json(COALESCE(_assignment.passive_effects, '[]'::jsonb), _virtue_multiplier);
      _assignment.end_effects := public.scale_racial_virtue_effect_json(COALESCE(_assignment.end_effects, '[]'::jsonb), _virtue_multiplier);
    END IF;
  END IF;

  select owner_id into _owner_id
  from public.characters where id = _assignment.character_id;
  if not found then raise exception 'Ficha do personagem não encontrada'; end if;
  if not _is_master then
    raise exception 'Apenas o mestre pode ativar habilidades';
  end if;

  IF _assignment.toggle_mode THEN
    IF _assignment.toggle_active THEN RAISE EXCEPTION 'Habilidade sustentada já está ligada'; END IF;
    IF _battle_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.battles WHERE id=_battle_id AND active) THEN
      RAISE EXCEPTION 'Habilidade sustentada só pode ser ligada em combate ativo';
    END IF;
    IF ((_assignment.ability_id IS NULL AND
      (_assignment.attack_enabled OR jsonb_array_length(COALESCE(_assignment.dot_effects,'[]'::jsonb))>0))
      OR EXISTS(SELECT 1 FROM public.abilities a WHERE a.id=_assignment.ability_id AND
      (a.attack_enabled OR jsonb_array_length(COALESCE(a.dot_effects,'[]'::jsonb))>0))) THEN
      RAISE EXCEPTION 'Habilidade sustentada não pode ter ataque ou DoTs de ativação';
    END IF;
  END IF;
  if not _assignment.can_activate or _assignment.cooldown_turns < 0 then
    raise exception 'Esta habilidade não pode ser ativada';
  end if;
  if _assignment.active_duration_remaining > 0 then
    raise exception 'Habilidade ainda em duração: faltam % turno(s)', _assignment.active_duration_remaining;
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

  if coalesce(_extra_mana_cost, 0) < 0 or coalesce(_extra_mana_cost, 0) > 1000000 then
    raise exception 'A Mana extra deve ficar entre 0 e 1000000';
  end if;

  if _assignment.once_per_battle and _effective_battle_id is not null then
    insert into public.character_ability_battle_uses (battle_id, character_ability_id, character_id)
    values (_effective_battle_id, _assignment.id, _assignment.character_id)
    on conflict do nothing;
    get diagnostics _once_use_inserted = row_count;
    if _once_use_inserted = 0 then raise exception 'Esta habilidade já foi usada neste combate'; end if;
  end if;

  -- Temporary battle overrides are applied to the local activation copy only.
  if _effective_battle_id is not null then
    select override_values into _effect from public.battle_ability_overrides
    where battle_id = _effective_battle_id and character_ability_id = _assignment.id;
    if found then
      if _effect ? 'mana_cost' then _assignment.mana_cost := greatest(0, least(1000000, (_effect->>'mana_cost')::integer)); end if;
      if _effect ? 'effects' and jsonb_typeof(_effect->'effects') = 'array' then _assignment.effects := _effect->'effects'; end if;
      if _effect ? 'end_effects' and jsonb_typeof(_effect->'end_effects') = 'array' then _assignment.end_effects := _effect->'end_effects'; end if;
    end if;
  end if;

  -- Edits from the popup are applied to this *local* activation snapshot.
  -- No catalog, character ability or battle override is changed.
  IF jsonb_typeof(_dot_attribute_values) = 'object'
     AND _dot_attribute_values ? '__activation_effect_overrides' THEN
    _assignment.effects := public.apply_activation_effect_value_overrides(
      _assignment.effects,
      _dot_attribute_values->'__activation_effect_overrides'
    );
  END IF;

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
    floor(greatest(0, _assignment.mana_cost + _mana_fixed_modifier + coalesce(_extra_mana_cost, 0))
      * greatest(0, 1 + _mana_percent_modifier / 100))::integer
  );

  -- Temporal Freeze forbids spending Mana, so the cost reported to the UI
  -- and queued script events must also be zero rather than only blocking the write.
  IF public.has_temporal_freeze(_assignment.character_id,_effective_battle_id) THEN
    _effective_mana_cost := 0;
  END IF;

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
  set cooldown_remaining = CASE WHEN _assignment.duration_turns > 0 AND NOT _assignment.toggle_mode THEN 0 ELSE _effective_cooldown END,
      active_duration_remaining = CASE WHEN _assignment.toggle_mode THEN 0 ELSE _assignment.duration_turns END,
      pending_cooldown_turns = CASE WHEN _assignment.duration_turns > 0 AND NOT _assignment.toggle_mode THEN _effective_cooldown ELSE 0 END
  where id = _assignment.id;

  PERFORM public.remove_attack_cancellable_effects(_assignment.character_id, _effective_battle_id);

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
    _until_combat_end := _assignment.toggle_mode OR coalesce((_effect->>'until_combat_end')::boolean, false);
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
      'no_regen_hp','no_regen_mana','stun','magic_prohibition','damage_dealt','damage_reduction','damage_received','damage_vulnerability','no_mana','healing','invincible','healing_blocked','magic_healing_reversal','mental_control_immunity','mental_control_chance','mental_control_resistance','dot_immunity','dot_resistance','invisibility','temporal_freeze','visual_tag'
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
      IF _effect_type = 'damage_dealt' AND jsonb_typeof(_effect->'damage_dealt_physical_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_dealt_physical_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value AND dt.category = 'physical')
      ) THEN
        RAISE EXCEPTION 'Dano Causado contém um tipo físico inválido';
      END IF;
      _attribute_key := null;
    elsif _effect_type = 'damage_reduction' then
      if _polarity <> 'buff' then raise exception 'Mitigação de dano só pode ser um buff'; end if;
      PERFORM public.validate_mitigation_configuration(_effect);
      _attribute_key := null;
      if _damage_reduction_scope = 'physical' then
        _damage_reduction_type_id := null;
        _damage_reduction_magic_level := null;
        _damage_reduction_type_ids := coalesce(_damage_reduction_type_ids, ARRAY[]::uuid[]);
        _damage_reduction_magic_levels := null;
        if cardinality(_damage_reduction_type_ids) > 0 and exists (
          select 1 from unnest(_damage_reduction_type_ids) as selected(id)
          where not exists (select 1 from public.damage_types dt where dt.id = selected.id and dt.category = 'physical')
        ) then raise exception 'Selecione tipos físicos válidos para a mitigação'; end if;
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
          where not exists (select 1 from public.damage_types dt where dt.id = selected.id and dt.category = 'magical')
        ) then raise exception 'Selecione tipos mágicos válidos para a mitigação'; end if;
        if cardinality(_damage_reduction_magic_levels) > 0 and exists (
          select 1 from unnest(_damage_reduction_magic_levels) as selected(level)
          where selected.level not in ('baixa','media','alta')
        ) then raise exception 'Selecione graus mágicos válidos para a mitigação'; end if;
        _damage_reduction_type_id := null;
        _damage_reduction_magic_level := null;
      elsif _damage_reduction_scope = 'both' then
        -- Independent physical/magical selections are in effect_data.
        -- Legacy single-category columns must not combine UUIDs of two types.
        _damage_reduction_type_id := NULL;
        _damage_reduction_magic_level := NULL;
        _damage_reduction_type_ids := ARRAY[]::uuid[];
        _damage_reduction_magic_levels := ARRAY[]::text[];
      else
        raise exception 'Categoria de mitigação inválida';
      end if;
    elsif _effect_type IN ('mental_control_immunity','dot_immunity','invisibility') then
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
    elsif _effect_type = 'dot_resistance' then
      _attribute_key := null;
      _polarity := 'buff';
      _value_mode := coalesce(nullif(_effect->>'dot_resistance_value_mode', ''), _value_mode);
      _amount := coalesce(nullif(_effect->>'dot_resistance_amount', '')::numeric, _amount);
      IF _value_mode NOT IN ('fixed', 'percent') OR _amount < 0 OR (_value_mode = 'percent' AND _amount > 100) OR (_value_mode = 'fixed' AND _amount > 1000000) THEN
        RAISE EXCEPTION 'Resistência a DoTs precisa ser um valor válido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'dot_resistance_scope', ''), 'all') NOT IN ('all', 'physical', 'magical', 'specific') THEN
        RAISE EXCEPTION 'Escopo da Resistência a DoTs inválido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'dot_resistance_mode', ''), 'damage') NOT IN ('damage', 'duration') THEN
        RAISE EXCEPTION 'Modo da Resistência a DoTs inválido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'dot_resistance_scope', ''), 'all') = 'specific' AND (jsonb_typeof(_effect->'dot_resistance_template_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(_effect->'dot_resistance_template_ids') = 0) THEN
        RAISE EXCEPTION 'Selecione ao menos um DoT específico para a resistência';
      END IF;
    elsif _effect_type IN ('mental_control_chance','mental_control_resistance') then
      _attribute_key := null;
      IF _polarity <> 'buff' THEN RAISE EXCEPTION 'Modificadores de Controle Mental só podem ser buffs'; END IF;
      IF _value_mode NOT IN ('fixed','percent') OR _amount < 0 THEN RAISE EXCEPTION 'Modificador de Controle Mental inválido'; END IF;
      IF _effect_type = 'mental_control_chance' AND _value_mode = 'percent' AND _amount > 99 THEN
        RAISE EXCEPTION 'Potência de Controle Mental não pode ultrapassar 99 por cento por efeito';
      END IF;
      IF _effect_type = 'mental_control_resistance' AND _value_mode = 'percent' AND _amount > 1000 THEN
        RAISE EXCEPTION 'Resistência Mental não pode ultrapassar 1000 por cento por efeito';
      END IF;
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
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value AND dt.category = 'magical')
      ) THEN
        RAISE EXCEPTION 'Dano Recebido contém um tipo mágico inválido';
      END IF;
      IF jsonb_typeof(_effect->'damage_received_physical_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_received_physical_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value AND dt.category = 'physical')
      ) THEN
        RAISE EXCEPTION 'Dano Recebido contém um tipo físico inválido';
      END IF;
      IF jsonb_typeof(_effect->'damage_received_magic_levels') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_received_magic_levels') selected(value)
        WHERE selected.value NOT IN ('baixa', 'media', 'alta')
      ) THEN
        RAISE EXCEPTION 'Dano Recebido contém um nível mágico inválido';
      END IF;
    elsif _effect_type = 'damage_vulnerability' then
      IF _attribute_key IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.attribute_definitions WHERE key = _attribute_key
      ) THEN
        RAISE EXCEPTION 'Vulnerabilidade de Dano precisa de um atributo válido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'damage_vulnerability_scope',''), 'any') NOT IN ('any','physical','magical') THEN
        RAISE EXCEPTION 'Categoria de Vulnerabilidade de Dano inválida';
      END IF;
      IF COALESCE(NULLIF(_effect->>'damage_vulnerability_applied_duration','')::integer,1) NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'A duração do buff/debuff aplicado deve ficar entre 1 e 1000 turnos';
      END IF;
      IF jsonb_typeof(_effect->'damage_vulnerability_physical_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_vulnerability_physical_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text=selected.value AND dt.category='physical')
      ) THEN
        RAISE EXCEPTION 'Vulnerabilidade de Dano contém um tipo físico inválido';
      END IF;
      IF jsonb_typeof(_effect->'damage_vulnerability_magic_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_vulnerability_magic_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text=selected.value AND dt.category='magical')
      ) THEN
        RAISE EXCEPTION 'Vulnerabilidade de Dano contém um tipo mágico inválido';
      END IF;
      IF jsonb_typeof(_effect->'damage_vulnerability_magic_levels') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_vulnerability_magic_levels') selected(value)
        WHERE selected.value NOT IN ('baixa','media','alta')
      ) THEN
        RAISE EXCEPTION 'Vulnerabilidade de Dano contém um nível mágico inválido';
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
          WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id = selected.value::uuid AND dt.category = 'magical')
        ) THEN
          RAISE EXCEPTION 'A Reversão de Cura contém um tipo mágico inválido';
        END IF;
        IF jsonb_typeof(_effect->'magic_healing_whitelist_type_ids') = 'array' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(_effect->'magic_healing_whitelist_type_ids') selected(value)
          WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value AND dt.category = 'magical')
        ) THEN
          RAISE EXCEPTION 'Whitelist da Reversão de Cura contém um tipo mágico inválido';
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
           or coalesce(nullif(_effect->>'healing_reduce_debuff_turns_percent','')::numeric, 0) > 0
            or coalesce(nullif(_effect->>'healing_relieve_debuff_percent','')::numeric, 0) > 0 then
          perform public.apply_ability_healing(
            _effect_character_id, _effective_battle_id, _effect || jsonb_build_object('_runtime_healer_character_id', _assignment.character_id), _healing_timing <> 'per_turn', true
          );
        else
          raise exception 'Configure pelo menos uma ação para a cura';
        end if;
        if nullif(_effect->>'healing_damage_type_id','') is not null and not exists (
          select 1 from public.damage_types where id = (_effect->>'healing_damage_type_id')::uuid and category='magical'
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

  -- Starting cooldown here makes the same state drive both UI availability and
  -- cooldown lifecycle callbacks. advance_combat_turn() ticks this value down.
  UPDATE public.character_abilities
  SET cooldown_remaining = CASE WHEN _assignment.toggle_mode OR _assignment.duration_turns > 0 THEN 0 ELSE _effective_cooldown END,
      active_duration_remaining = CASE WHEN _assignment.toggle_mode THEN 0 ELSE _assignment.duration_turns END,
      pending_cooldown_turns = CASE WHEN NOT _assignment.toggle_mode AND _assignment.duration_turns > 0 THEN _effective_cooldown ELSE 0 END,
      toggle_active = _assignment.toggle_mode,
      toggle_effect_group_id = CASE WHEN _assignment.toggle_mode THEN _effect_group_id ELSE NULL END,
      toggle_battle_id = CASE WHEN _assignment.toggle_mode THEN _effective_battle_id ELSE NULL END
  WHERE id = _assignment.id;

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

  if _effective_battle_id is not null then
    delete from public.battle_ability_overrides
    where battle_id = _effective_battle_id
      and character_ability_id = _assignment.id
      and keep_after_use = false;
  end if;

  PERFORM public.apply_character_ability_dots(_assignment.id, _effective_battle_id, _dot_target_selections, _dot_attribute_values);
  -- Invoke configured creature templates as part of this paid activation.
  IF _effective_battle_id IS NOT NULL THEN
    PERFORM public.activate_ability_summons(_assignment.id,_effective_battle_id);
  END IF;
  return _effective_mana_cost;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.activate_character_ability_attack(_character_ability_id uuid, _target_character_id uuid, _battle_id uuid DEFAULT NULL::uuid, _extra_mana_cost integer DEFAULT 0, _hit_target_ids uuid[] DEFAULT NULL::uuid[], _hit_effect_groups jsonb DEFAULT NULL::jsonb, _dot_target_selections jsonb DEFAULT NULL::jsonb, _dot_attribute_values jsonb DEFAULT '{}'::jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  _hit_target_id uuid;
  _apply_both boolean := false;
  _effect_target_character_id uuid;
  _group_target_keys text[] := ARRAY[]::text[];
  _attack_effect_groups jsonb := '[]'::jsonb;
  _target_group_selection jsonb;
  _attack_group jsonb;
  _group_effect jsonb;
  _selected_target_id uuid;
  _selected_group_id text;
  _hit_effect_target_id uuid;
  _group_ids uuid[] := ARRAY[]::uuid[];
  _group_index integer;
  _healing_timing text;
  _mana_fixed_modifier numeric := 0;
  _mana_percent_modifier numeric := 0;
  _effective_mana_cost integer := 0;
  _attack_base_mana_cost integer := 0;
  _effective_cooldown integer := 0;
  _cooldown_factor numeric := 1;
  _cooldown_virtue_id uuid;
  _race_mechanics jsonb := '{}'::jsonb;
  _class_mechanics jsonb := '{}'::jsonb;
  _virtue_multiplier numeric := 1;
  _once_use_inserted integer := 0;
  _effect_group_id uuid := gen_random_uuid();
  _is_master boolean := public.has_role(auth.uid(), 'master');
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;

  select * into _assignment
  from public.character_abilities
  where id = _character_ability_id
  for update;
  if not found then raise exception 'Habilidade não encontrada nesta ficha'; end if;

  _cooldown_virtue_id := COALESCE(_assignment.granted_by_virtue_id, _assignment.linked_by_virtue_id);
  SELECT COALESCE(r.special_mechanics, '{}'::jsonb), COALESCE(cl.special_mechanics, '{}'::jsonb)
  INTO _race_mechanics, _class_mechanics
  FROM public.characters c
  LEFT JOIN public.races r ON r.id = c.race_id
  LEFT JOIN public.classes cl ON cl.id = c.class_id
  WHERE c.id = _assignment.character_id;
  IF _cooldown_virtue_id IS NOT NULL THEN
    IF COALESCE(NULLIF(_race_mechanics->>'virtue_cooldown_reduction_percent', '')::numeric, 0) > 0 AND NOT COALESCE((_race_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_cooldown_virtue_id::text), false) THEN
      _cooldown_factor := _cooldown_factor * (1 - LEAST(100, GREATEST(0, (_race_mechanics->>'virtue_cooldown_reduction_percent')::numeric)) / 100);
    END IF;
    IF COALESCE(NULLIF(_class_mechanics->>'virtue_cooldown_reduction_percent', '')::numeric, 0) > 0 AND NOT COALESCE((_class_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_cooldown_virtue_id::text), false) THEN
      _cooldown_factor := _cooldown_factor * (1 - LEAST(100, GREATEST(0, (_class_mechanics->>'virtue_cooldown_reduction_percent')::numeric)) / 100);
    END IF;
  END IF;
  _effective_cooldown := GREATEST(0, FLOOR(_assignment.cooldown_turns * _cooldown_factor)::integer);

  IF _assignment.ability_id IS NULL AND _assignment.linked_by_virtue_id IS NOT NULL THEN
    IF COALESCE((_race_mechanics->>'duplicate_virtue_effects')::boolean, false) AND NOT COALESCE((_race_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_assignment.linked_by_virtue_id::text), false) THEN
      _virtue_multiplier := _virtue_multiplier * GREATEST(1, LEAST(10, COALESCE(NULLIF(_race_mechanics->>'virtue_effect_multiplier', '')::numeric, 2)));
    END IF;
    IF COALESCE((_class_mechanics->>'duplicate_virtue_effects')::boolean, false) AND NOT COALESCE((_class_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_assignment.linked_by_virtue_id::text), false) THEN
      _virtue_multiplier := _virtue_multiplier * GREATEST(1, LEAST(10, COALESCE(NULLIF(_class_mechanics->>'virtue_effect_multiplier', '')::numeric, 2)));
    END IF;
    _virtue_multiplier := GREATEST(1, LEAST(100, _virtue_multiplier));
    IF _virtue_multiplier > 1 THEN
      _assignment.effects := public.scale_racial_virtue_effect_json(COALESCE(_assignment.effects, '[]'::jsonb), _virtue_multiplier);
      _assignment.passive_effects := public.scale_racial_virtue_effect_json(COALESCE(_assignment.passive_effects, '[]'::jsonb), _virtue_multiplier);
      _assignment.end_effects := public.scale_racial_virtue_effect_json(COALESCE(_assignment.end_effects, '[]'::jsonb), _virtue_multiplier);
    END IF;
  END IF;

  select owner_id into _owner_id
  from public.characters where id = _assignment.character_id;
  if not found then raise exception 'Ficha do personagem não encontrada'; end if;
  if not _is_master then
    raise exception 'Apenas o mestre pode ativar habilidades';
  end if;

  IF _assignment.toggle_mode THEN RAISE EXCEPTION 'Habilidades sustentadas não podem usar o botão Atacar'; END IF;
  if not _assignment.can_activate or _assignment.cooldown_turns < 0 then
    raise exception 'Esta habilidade não pode ser ativada';
  end if;
  if _assignment.active_duration_remaining > 0 then
    raise exception 'Habilidade ainda em duração: faltam % turno(s)', _assignment.active_duration_remaining;
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

  IF _hit_target_ids IS NOT NULL THEN
    IF NOT (
      (_assignment.ability_id IS NULL AND _assignment.attack_enabled IS TRUE)
      OR EXISTS (SELECT 1 FROM public.abilities a
        WHERE a.id = _assignment.ability_id AND a.attack_enabled IS TRUE)
    ) THEN
      RAISE EXCEPTION 'Esta habilidade não está configurada para atacar';
    END IF;
    IF _effective_battle_id IS NULL THEN
      RAISE EXCEPTION 'Ataques de habilidade só podem ser resolvidos dentro de uma batalha ativa';
    END IF;
    IF cardinality(_hit_target_ids) > 100 THEN
      RAISE EXCEPTION 'Um ataque pode selecionar no máximo 100 alvos';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM unnest(_hit_target_ids) AS selected(target_id)
      WHERE selected.target_id IS NULL
         OR selected.target_id = _assignment.character_id
         OR NOT EXISTS (
           SELECT 1 FROM public.battle_participants bp
           WHERE bp.battle_id = _effective_battle_id
             AND bp.character_id = selected.target_id
         )
    ) THEN
      RAISE EXCEPTION 'Todos os alvos atingidos precisam ser outros participantes da mesma batalha';
    END IF;
  END IF;

  if coalesce(_extra_mana_cost, 0) < 0 or coalesce(_extra_mana_cost, 0) > 1000000 then
    raise exception 'A Mana extra deve ficar entre 0 e 1000000';
  end if;

  if _assignment.once_per_battle and _effective_battle_id is not null then
    insert into public.character_ability_battle_uses (battle_id, character_ability_id, character_id)
    values (_effective_battle_id, _assignment.id, _assignment.character_id)
    on conflict do nothing;
    get diagnostics _once_use_inserted = row_count;
    if _once_use_inserted = 0 then raise exception 'Esta habilidade já foi usada neste combate'; end if;
  end if;

  -- Temporary battle overrides are applied to the local activation copy only.
  if _effective_battle_id is not null then
    select override_values into _effect from public.battle_ability_overrides
    where battle_id = _effective_battle_id and character_ability_id = _assignment.id;
    if found then
      if _effect ? 'mana_cost' then _assignment.mana_cost := greatest(0, least(1000000, (_effect->>'mana_cost')::integer)); end if;
      if _effect ? 'effects' and jsonb_typeof(_effect->'effects') = 'array' then _assignment.effects := _effect->'effects'; end if;
      if _effect ? 'end_effects' and jsonb_typeof(_effect->'end_effects') = 'array' then _assignment.end_effects := _effect->'end_effects'; end if;
    end if;
  end if;

  -- Separate attack Mana cost. NULL means inherit the existing activation
  -- cost; an explicitly configured 0 makes Atacar free.
  _attack_base_mana_cost := COALESCE(
    _assignment.attack_mana_cost,
    (SELECT a.attack_mana_cost FROM public.abilities a WHERE a.id=_assignment.ability_id),
    _assignment.mana_cost
  );
  -- The battle-specific Ativar override remains the default when no separate
  -- attack cost is configured. A dedicated battle attack override wins if set.
  IF _effect ? 'attack_mana_cost' AND _effect->>'attack_mana_cost' IS NOT NULL THEN
    _attack_base_mana_cost := GREATEST(0,LEAST(1000000,(_effect->>'attack_mana_cost')::integer));
  END IF;

  IF _hit_effect_groups IS NOT NULL THEN
    IF _hit_target_ids IS NULL OR jsonb_typeof(_hit_effect_groups) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'As categorias de efeitos exigem alvos válidos no ataque';
    END IF;
    IF _assignment.ability_id IS NULL AND _assignment.attack_enabled IS TRUE THEN
      _attack_effect_groups := COALESCE(_assignment.attack_effect_groups,'[]'::jsonb);
    ELSE
      SELECT coalesce(a.attack_effect_groups, '[]'::jsonb)
      INTO _attack_effect_groups
      FROM public.abilities a
      WHERE a.id = _assignment.ability_id AND a.attack_enabled IS TRUE;
    END IF;
    IF _attack_effect_groups IS NULL THEN
      RAISE EXCEPTION 'Esta habilidade não tem categorias de efeitos de ataque configuradas';
    END IF;
    IF jsonb_typeof(_attack_effect_groups) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Configuração de categorias de efeitos inválida';
    END IF;
    IF jsonb_array_length(_hit_effect_groups) > 100 THEN
      RAISE EXCEPTION 'Há categorias de efeitos demais na resolução deste ataque';
    END IF;

    FOR _target_group_selection IN
      SELECT value FROM jsonb_array_elements(_hit_effect_groups) AS selected(value)
    LOOP
      _selected_target_id := nullif(_target_group_selection->>'target_id', '')::uuid;
      IF _selected_target_id IS NULL OR NOT (_selected_target_id = ANY(_hit_target_ids)) THEN
        RAISE EXCEPTION 'Só é possível aplicar efeitos em alvos marcados como acertados';
      END IF;
      IF jsonb_typeof(_target_group_selection->'group_ids') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'A lista de categorias selecionadas é inválida';
      END IF;
      IF jsonb_array_length(_target_group_selection->'group_ids') > 100 THEN
        RAISE EXCEPTION 'Há categorias demais selecionadas para um alvo';
      END IF;

      FOR _selected_group_id IN
        SELECT DISTINCT selected_group.value
        FROM jsonb_array_elements_text(_target_group_selection->'group_ids') AS selected_group(value)
      LOOP
        SELECT entry.value INTO _attack_group
        FROM jsonb_array_elements(_attack_effect_groups) AS entry(value)
        WHERE entry.value->>'id' = _selected_group_id
        LIMIT 1;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Uma categoria de efeitos selecionada não pertence a esta habilidade';
        END IF;
        -- Changes made in the expanded attack editor are scoped to the
        -- target, group and current strike. They never modify saved abilities.
        IF _target_group_selection->'group_overrides'->_selected_group_id ? 'effects' THEN
          IF jsonb_typeof(_target_group_selection->'group_overrides'->_selected_group_id->'effects') IS DISTINCT FROM 'array'
             OR jsonb_array_length(_target_group_selection->'group_overrides'->_selected_group_id->'effects') > 100 THEN
            RAISE EXCEPTION 'Os efeitos modificados nesta utilização são inválidos';
          END IF;
          _attack_group := jsonb_set(_attack_group,'{effects}',
            _target_group_selection->'group_overrides'->_selected_group_id->'effects',true);
        END IF;
        IF jsonb_typeof(_attack_group->'effects') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'Uma categoria de efeitos está configurada incorretamente';
        END IF;
        IF jsonb_array_length(_attack_group->'effects') > 100 THEN
          RAISE EXCEPTION 'Uma categoria contém efeitos demais';
        END IF;
        FOR _group_effect IN
          SELECT value FROM jsonb_array_elements(_attack_group->'effects') AS configured(value)
        LOOP
          _assignment.effects := coalesce(_assignment.effects, '[]'::jsonb)
            || jsonb_build_array(
              (_group_effect - '__attack_effect_target_id')
              || jsonb_build_object('__attack_effect_target_id', _selected_target_id::text)
            );
        END LOOP;
      END LOOP;
    END LOOP;
  END IF;

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
    floor(greatest(0, _attack_base_mana_cost + _mana_fixed_modifier + coalesce(_extra_mana_cost, 0))
      * greatest(0, 1 + _mana_percent_modifier / 100))::integer
  );

  -- Temporal Freeze forbids spending Mana, so the cost reported to the UI
  -- and queued script events must also be zero rather than only blocking the write.
  IF public.has_temporal_freeze(_assignment.character_id,_effective_battle_id) THEN
    _effective_mana_cost := 0;
  END IF;

  if ((_assignment.is_magical or _attack_base_mana_cost > 0 or _effective_mana_cost > 0)
      and public.character_has_no_mana(_assignment.character_id)) then
    raise exception 'Sem Mana: habilidades mágicas ou que consomem Mana não podem ser usadas enquanto o efeito durar';
  end if;

  if (
    (_assignment.is_magical or _attack_base_mana_cost > 0 or _effective_mana_cost > 0)
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
  set cooldown_remaining = CASE WHEN _assignment.duration_turns > 0 AND NOT _assignment.toggle_mode THEN 0 ELSE _effective_cooldown END,
      active_duration_remaining = CASE WHEN _assignment.toggle_mode THEN 0 ELSE _assignment.duration_turns END,
      pending_cooldown_turns = CASE WHEN _assignment.duration_turns > 0 AND NOT _assignment.toggle_mode THEN _effective_cooldown ELSE 0 END
  where id = _assignment.id;

  PERFORM public.remove_attack_cancellable_effects(_assignment.character_id, _effective_battle_id);

  if jsonb_typeof(coalesce(_assignment.effects, '[]'::jsonb)) <> 'array' then
    raise exception 'Configuração de efeitos ativos inválida';
  end if;

  for _effect in select value from jsonb_array_elements(coalesce(_assignment.effects, '[]'::jsonb))
  loop
    _hit_effect_target_id := nullif(_effect->>'__attack_effect_target_id', '')::uuid;
    _effect := _effect - '__attack_effect_target_id';
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
    IF _hit_effect_target_id IS NOT NULL THEN
      _effect_character_ids := ARRAY[]::uuid[];
      _apply_both := COALESCE((_effect->>'apply_both_on_activation')::boolean, false);

      IF _apply_both OR _target_scope IN ('caster', 'both') THEN
        _effect_character_ids := array_append(_effect_character_ids, _assignment.character_id);
      END IF;

      IF (_apply_both OR _target_scope IN ('target', 'both'))
         AND _hit_effect_target_id <> _assignment.character_id
         AND NOT (_hit_effect_target_id = ANY(_effect_character_ids)) THEN
        _effect_character_ids := array_append(_effect_character_ids, _hit_effect_target_id);
      END IF;
    ELSIF _hit_target_ids IS NOT NULL THEN
      _effect_character_ids := ARRAY[]::uuid[];
      _apply_both := COALESCE((_effect->>'apply_both_on_activation')::boolean, false);

      IF _apply_both OR _target_scope IN ('caster', 'both') THEN
        _effect_character_ids := array_append(_effect_character_ids, _assignment.character_id);
      END IF;

      IF _apply_both OR _target_scope IN ('target', 'both') THEN
        FOREACH _hit_target_id IN ARRAY COALESCE(_hit_target_ids, ARRAY[]::uuid[]) LOOP
          IF _hit_target_id IS NOT NULL
             AND _hit_target_id <> _assignment.character_id
             AND NOT (_hit_target_id = ANY(_effect_character_ids)) THEN
            _effect_character_ids := array_append(_effect_character_ids, _hit_target_id);
          END IF;
        END LOOP;
      END IF;
    ELSIF coalesce((_effect->>'apply_both_on_activation')::boolean, false) then
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
      'no_regen_hp','no_regen_mana','stun','magic_prohibition','damage_dealt','damage_reduction','damage_received','damage_vulnerability','no_mana','healing','invincible','healing_blocked','magic_healing_reversal','mental_control_immunity','mental_control_chance','mental_control_resistance','dot_immunity','dot_resistance','invisibility','temporal_freeze','visual_tag'
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
      IF _effect_type = 'damage_dealt' AND jsonb_typeof(_effect->'damage_dealt_physical_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_dealt_physical_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value AND dt.category = 'physical')
      ) THEN
        RAISE EXCEPTION 'Dano Causado contém um tipo físico inválido';
      END IF;
      _attribute_key := null;
    elsif _effect_type = 'damage_reduction' then
      if _polarity <> 'buff' then raise exception 'Mitigação de dano só pode ser um buff'; end if;
      PERFORM public.validate_mitigation_configuration(_effect);
      _attribute_key := null;
      if _damage_reduction_scope = 'physical' then
        _damage_reduction_type_id := null;
        _damage_reduction_magic_level := null;
        _damage_reduction_type_ids := coalesce(_damage_reduction_type_ids, ARRAY[]::uuid[]);
        _damage_reduction_magic_levels := null;
        if cardinality(_damage_reduction_type_ids) > 0 and exists (
          select 1 from unnest(_damage_reduction_type_ids) as selected(id)
          where not exists (select 1 from public.damage_types dt where dt.id = selected.id and dt.category = 'physical')
        ) then raise exception 'Selecione tipos físicos válidos para a mitigação'; end if;
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
          where not exists (select 1 from public.damage_types dt where dt.id = selected.id and dt.category = 'magical')
        ) then raise exception 'Selecione tipos mágicos válidos para a mitigação'; end if;
        if cardinality(_damage_reduction_magic_levels) > 0 and exists (
          select 1 from unnest(_damage_reduction_magic_levels) as selected(level)
          where selected.level not in ('baixa','media','alta')
        ) then raise exception 'Selecione graus mágicos válidos para a mitigação'; end if;
        _damage_reduction_type_id := null;
        _damage_reduction_magic_level := null;
      elsif _damage_reduction_scope = 'both' then
        -- Independent physical/magical selections are in effect_data.
        -- Legacy single-category columns must not combine UUIDs of two types.
        _damage_reduction_type_id := NULL;
        _damage_reduction_magic_level := NULL;
        _damage_reduction_type_ids := ARRAY[]::uuid[];
        _damage_reduction_magic_levels := ARRAY[]::text[];
      else
        raise exception 'Categoria de mitigação inválida';
      end if;
    elsif _effect_type IN ('mental_control_immunity','dot_immunity','invisibility') then
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
    elsif _effect_type = 'dot_resistance' then
      _attribute_key := null;
      _polarity := 'buff';
      _value_mode := coalesce(nullif(_effect->>'dot_resistance_value_mode', ''), _value_mode);
      _amount := coalesce(nullif(_effect->>'dot_resistance_amount', '')::numeric, _amount);
      IF _value_mode NOT IN ('fixed', 'percent') OR _amount < 0 OR (_value_mode = 'percent' AND _amount > 100) OR (_value_mode = 'fixed' AND _amount > 1000000) THEN
        RAISE EXCEPTION 'Resistência a DoTs precisa ser um valor válido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'dot_resistance_scope', ''), 'all') NOT IN ('all', 'physical', 'magical', 'specific') THEN
        RAISE EXCEPTION 'Escopo da Resistência a DoTs inválido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'dot_resistance_mode', ''), 'damage') NOT IN ('damage', 'duration') THEN
        RAISE EXCEPTION 'Modo da Resistência a DoTs inválido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'dot_resistance_scope', ''), 'all') = 'specific' AND (jsonb_typeof(_effect->'dot_resistance_template_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(_effect->'dot_resistance_template_ids') = 0) THEN
        RAISE EXCEPTION 'Selecione ao menos um DoT específico para a resistência';
      END IF;
    elsif _effect_type IN ('mental_control_chance','mental_control_resistance') then
      _attribute_key := null;
      IF _polarity <> 'buff' THEN RAISE EXCEPTION 'Modificadores de Controle Mental só podem ser buffs'; END IF;
      IF _value_mode NOT IN ('fixed','percent') OR _amount < 0 THEN RAISE EXCEPTION 'Modificador de Controle Mental inválido'; END IF;
      IF _effect_type = 'mental_control_chance' AND _value_mode = 'percent' AND _amount > 99 THEN
        RAISE EXCEPTION 'Potência de Controle Mental não pode ultrapassar 99 por cento por efeito';
      END IF;
      IF _effect_type = 'mental_control_resistance' AND _value_mode = 'percent' AND _amount > 1000 THEN
        RAISE EXCEPTION 'Resistência Mental não pode ultrapassar 1000 por cento por efeito';
      END IF;
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
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value AND dt.category = 'magical')
      ) THEN
        RAISE EXCEPTION 'Dano Recebido contém um tipo mágico inválido';
      END IF;
      IF jsonb_typeof(_effect->'damage_received_physical_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_received_physical_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value AND dt.category = 'physical')
      ) THEN
        RAISE EXCEPTION 'Dano Recebido contém um tipo físico inválido';
      END IF;
      IF jsonb_typeof(_effect->'damage_received_magic_levels') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_received_magic_levels') selected(value)
        WHERE selected.value NOT IN ('baixa', 'media', 'alta')
      ) THEN
        RAISE EXCEPTION 'Dano Recebido contém um nível mágico inválido';
      END IF;
    elsif _effect_type = 'damage_vulnerability' then
      IF _attribute_key IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.attribute_definitions WHERE key = _attribute_key
      ) THEN
        RAISE EXCEPTION 'Vulnerabilidade de Dano precisa de um atributo válido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'damage_vulnerability_scope',''), 'any') NOT IN ('any','physical','magical') THEN
        RAISE EXCEPTION 'Categoria de Vulnerabilidade de Dano inválida';
      END IF;
      IF COALESCE(NULLIF(_effect->>'damage_vulnerability_applied_duration','')::integer,1) NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'A duração do buff/debuff aplicado deve ficar entre 1 e 1000 turnos';
      END IF;
      IF jsonb_typeof(_effect->'damage_vulnerability_physical_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_vulnerability_physical_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text=selected.value AND dt.category='physical')
      ) THEN
        RAISE EXCEPTION 'Vulnerabilidade de Dano contém um tipo físico inválido';
      END IF;
      IF jsonb_typeof(_effect->'damage_vulnerability_magic_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_vulnerability_magic_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text=selected.value AND dt.category='magical')
      ) THEN
        RAISE EXCEPTION 'Vulnerabilidade de Dano contém um tipo mágico inválido';
      END IF;
      IF jsonb_typeof(_effect->'damage_vulnerability_magic_levels') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_vulnerability_magic_levels') selected(value)
        WHERE selected.value NOT IN ('baixa','media','alta')
      ) THEN
        RAISE EXCEPTION 'Vulnerabilidade de Dano contém um nível mágico inválido';
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
          WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id = selected.value::uuid AND dt.category = 'magical')
        ) THEN
          RAISE EXCEPTION 'A Reversão de Cura contém um tipo mágico inválido';
        END IF;
        IF jsonb_typeof(_effect->'magic_healing_whitelist_type_ids') = 'array' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(_effect->'magic_healing_whitelist_type_ids') selected(value)
          WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value AND dt.category = 'magical')
        ) THEN
          RAISE EXCEPTION 'Whitelist da Reversão de Cura contém um tipo mágico inválido';
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
      _effect_target_character_id := coalesce(_hit_effect_target_id, _target_character_id);
      IF _hit_target_ids IS NOT NULL THEN
        _group_index := array_position(
          _group_target_keys,
          _effect_character_id::text || ':' || coalesce(_hit_effect_target_id, _target_character_id)::text
        );
        IF _group_index IS NULL THEN
          _group_target_keys := array_append(
            _group_target_keys,
            _effect_character_id::text || ':' || coalesce(_hit_effect_target_id, _target_character_id)::text
          );
          _group_ids := array_append(_group_ids, gen_random_uuid());
          _group_index := cardinality(_group_target_keys);
        END IF;
        _effect_group_id := _group_ids[_group_index];
        IF _effect_character_id <> _assignment.character_id THEN
          _effect_target_character_id := _effect_character_id;
        END IF;
      END IF;
      if _effect_type = 'healing' then
        _healing_timing := coalesce(nullif(_effect->>'healing_timing', ''), 'instant');
        if _healing_timing not in ('instant', 'per_turn') then raise exception 'Modo de cura inválido'; end if;
        if coalesce((_effect->>'healing_hp_enabled')::boolean, false)
           or coalesce((_effect->>'healing_mana_enabled')::boolean, false)
           or coalesce((_effect->>'healing_body_enabled')::boolean, false)
           or coalesce((_effect->>'healing_sanity_enabled')::boolean, false)
           or coalesce((_effect->>'healing_remove_debuffs')::boolean, false)
           or coalesce(nullif(_effect->>'healing_reduce_debuff_turns_fixed','')::integer, 0) > 0
           or coalesce(nullif(_effect->>'healing_reduce_debuff_turns_percent','')::numeric, 0) > 0
            or coalesce(nullif(_effect->>'healing_relieve_debuff_percent','')::numeric, 0) > 0 then
          perform public.apply_ability_healing(
            _effect_character_id, _effective_battle_id, _effect || jsonb_build_object('_runtime_healer_character_id', _assignment.character_id), _healing_timing <> 'per_turn', true
          );
        else
          raise exception 'Configure pelo menos uma ação para a cura';
        end if;
        if nullif(_effect->>'healing_damage_type_id','') is not null and not exists (
          select 1 from public.damage_types where id = (_effect->>'healing_damage_type_id')::uuid and category='magical'
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
            _effect_group_id, false, 'any', _effect_target_character_id, _effect || jsonb_build_object('_runtime_healer_character_id', _assignment.character_id)
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
        _effect_target_character_id, _effect
      );
    end loop;
  end loop;

  -- Starting cooldown here makes the same state drive both UI availability and
  -- cooldown lifecycle callbacks. advance_combat_turn() ticks this value down.
  UPDATE public.character_abilities
  SET cooldown_remaining = CASE WHEN _assignment.duration_turns > 0 THEN 0 ELSE _effective_cooldown END,
      active_duration_remaining = _assignment.duration_turns,
      pending_cooldown_turns = CASE WHEN _assignment.duration_turns > 0 THEN _effective_cooldown ELSE 0 END
  WHERE id = _assignment.id;

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

  if _effective_battle_id is not null then
    delete from public.battle_ability_overrides
    where battle_id = _effective_battle_id
      and character_ability_id = _assignment.id
      and keep_after_use = false;
  end if;

  PERFORM public.apply_character_ability_dots(_assignment.id, _effective_battle_id, _dot_target_selections, _dot_attribute_values);

  IF _hit_target_ids IS NOT NULL AND _effective_battle_id IS NOT NULL THEN
    INSERT INTO public.ability_attack_sessions (battle_id,character_ability_id,master_id)
    VALUES (_effective_battle_id,_assignment.id,auth.uid())
    ON CONFLICT (battle_id,character_ability_id,master_id)
    DO UPDATE SET started_at=now();
  END IF;

  -- Invoke configured creature templates as part of this paid activation.
  IF _effective_battle_id IS NOT NULL THEN
    PERFORM public.activate_ability_summons(_assignment.id,_effective_battle_id);
  END IF;
  return _effective_mana_cost;
end;
$function$
;
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
      PERFORM public.validate_mitigation_configuration(_effect);
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
      elsif _damage_reduction_scope = 'both' then
        -- Independent physical/magical selections are in effect_data.
        -- Legacy single-category columns must not combine UUIDs of two types.
        _damage_reduction_type_id := NULL;
        _damage_reduction_magic_level := NULL;
        _damage_reduction_type_ids := ARRAY[]::uuid[];
        _damage_reduction_magic_levels := ARRAY[]::text[];
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
CREATE OR REPLACE FUNCTION public.apply_manual_character_effects(_character_id uuid, _battle_id uuid DEFAULT NULL::uuid, _source_character_id uuid DEFAULT NULL::uuid, _effects jsonb DEFAULT '[]'::jsonb, _dots jsonb DEFAULT '[]'::jsonb, _permanent boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _source_name text;
  _target_battle_id uuid := _battle_id;
  _effect jsonb;
  _dot jsonb;
  _effect_type text;
  _stored_type text;
  _attribute_key text;
  _polarity text;
  _value_mode text;
  _amount numeric;
  _duration integer;
  _until_combat_end boolean;
  _damage_scope text;
  _reduction_scope text;
  _type_ids uuid[];
  _magic_levels text[];
  _name text;
  _dot_name text;
  _dot_kind text;
  _dot_mode text;
  _dot_amount numeric;
  _dot_duration integer;
  _dot_physical_id uuid;
  _dot_magic_id uuid;
  _dot_magic_level text;
  _effect_target_id uuid;
  _effect_target_ids uuid[];
  _effect_target_scope text;
  _applied integer := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode aplicar efeitos diretamente na ficha.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.characters c WHERE c.id = _character_id) THEN
    RAISE EXCEPTION 'Ficha do alvo não encontrada.';
  END IF;
  IF jsonb_typeof(COALESCE(_effects,'[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(_dots,'[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Efeitos e DoTs precisam ser listas.';
  END IF;
  IF jsonb_array_length(COALESCE(_effects,'[]'::jsonb)) > 50
     OR jsonb_array_length(COALESCE(_dots,'[]'::jsonb)) > 50 THEN
    RAISE EXCEPTION 'Aplique no máximo 50 efeitos e 50 DoTs por vez.';
  END IF;

  IF _battle_id IS NOT NULL AND _permanent THEN
    RAISE EXCEPTION 'Efeitos aplicados durante o combate não podem ser permanentes na ficha.';
  END IF;

  IF _battle_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.battles b WHERE b.id = _battle_id AND b.active) THEN
      RAISE EXCEPTION 'A batalha selecionada não está ativa.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.battle_participants bp WHERE bp.battle_id = _battle_id AND bp.character_id = _character_id) THEN
      RAISE EXCEPTION 'O alvo não participa desta batalha.';
    END IF;
    IF _source_character_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.battle_participants bp WHERE bp.battle_id = _battle_id AND bp.character_id = _source_character_id
    ) THEN RAISE EXCEPTION 'O atacante não participa desta batalha.'; END IF;
  END IF;
  IF _source_character_id IS NOT NULL THEN
    SELECT c.name INTO _source_name FROM public.characters c WHERE c.id = _source_character_id;
  END IF;

  IF _permanent THEN
    _target_battle_id := NULL;
  END IF;

  FOR _effect IN SELECT value FROM jsonb_array_elements(COALESCE(_effects,'[]'::jsonb))
  LOOP
    _effect_type := COALESCE(NULLIF(_effect->>'effect_type',''),'status');
    IF _effect_type = 'healing' THEN
      RAISE EXCEPTION 'A cura instantânea deve ser usada como habilidade; ela não pode ser salva como efeito permanente.';
    END IF;
    IF _effect_type NOT IN (
      'status','regeneration','mana_regeneration','mana_used','no_regen_hp','no_regen_mana',
      'magic_prohibition','stun','damage_dealt','no_mana','damage_reduction','damage_received',
      'damage_vulnerability','invincible','healing_blocked','magic_healing_reversal',
      'mental_control_immunity','mental_control_chance','mental_control_resistance','dot_immunity','dot_resistance','invisibility'
    ) THEN RAISE EXCEPTION 'Tipo de efeito inválido: %', _effect_type; END IF;

    _stored_type := CASE WHEN _effect_type='mana_regeneration' THEN 'regeneration'
                         WHEN _effect_type='magic_healing_reversal' THEN 'healing_blocked'
                         ELSE _effect_type END;
    _attribute_key := CASE
      WHEN _stored_type IN ('status','damage_vulnerability') THEN NULLIF(_effect->>'attribute_key','')
      WHEN _stored_type='regeneration' THEN CASE WHEN _effect_type='mana_regeneration' THEN 'mana' ELSE NULLIF(_effect->>'attribute_key','') END
      ELSE NULL END;
    _polarity := CASE
      WHEN _stored_type IN ('no_mana','magic_prohibition','healing_blocked','damage_received') THEN 'debuff'
      WHEN _stored_type IN ('damage_reduction','invincible','mental_control_immunity','mental_control_chance','mental_control_resistance','dot_immunity','dot_resistance','invisibility') THEN 'buff'
      ELSE CASE WHEN _effect->>'polarity'='debuff' THEN 'debuff' ELSE 'buff' END END;
    _value_mode := CASE WHEN _effect->>'value_mode'='percent' THEN 'percent' ELSE 'fixed' END;
    _amount := GREATEST(0,COALESCE(NULLIF(_effect->>'amount','')::numeric,0));
    _duration := CASE WHEN _permanent THEN 1 ELSE GREATEST(1,LEAST(1000,COALESCE(NULLIF(_effect->>'duration','')::integer,1))) END;
    _until_combat_end := NOT _permanent AND _target_battle_id IS NOT NULL
      AND COALESCE((_effect->>'until_combat_end')::boolean, false);
    _damage_scope := CASE WHEN _effect->>'damage_scope' IN ('physical','magical') THEN _effect->>'damage_scope' ELSE 'any' END;
    _reduction_scope := CASE WHEN _effect->>'damage_reduction_scope' IN ('physical','magical','both') THEN _effect->>'damage_reduction_scope' ELSE 'physical' END;
    _name := LEFT(COALESCE(NULLIF(BTRIM(_effect->>'name'),''),'Efeito aplicado'),160);
    IF _source_name IS NOT NULL THEN _name := LEFT(_source_name || ': ' || _name, 160); END IF;

    IF _stored_type IN ('status','damage_vulnerability') AND _attribute_key IS NULL THEN
      RAISE EXCEPTION 'Selecione um atributo para o efeito %.', _name;
    END IF;
    IF _stored_type='regeneration' AND _attribute_key NOT IN ('hp','mana') THEN
      RAISE EXCEPTION 'Regeneração só pode afetar HP ou Mana.';
    END IF;
    IF _stored_type IN ('no_mana','magic_prohibition','invincible','healing_blocked','mental_control_immunity','dot_immunity','dot_resistance','invisibility') THEN
      _attribute_key := NULL; _amount := 0; _value_mode := 'fixed';
    END IF;
    IF _stored_type IN ('damage_dealt','mana_used') THEN _attribute_key := NULL; END IF;
    IF _stored_type IN ('no_mana','magic_prohibition','healing_blocked','damage_received') THEN
      _polarity := 'debuff'; _attribute_key := NULL;
    END IF;
    IF _stored_type IN ('mental_control_chance','mental_control_resistance') THEN
      _attribute_key := NULL;
      IF _polarity <> 'buff' THEN RAISE EXCEPTION 'Modificadores de Controle Mental só podem ser buffs.'; END IF;
      IF _stored_type='mental_control_chance' AND _value_mode='percent' AND _amount > 99 THEN RAISE EXCEPTION 'Potência de Controle Mental deve ser no máximo 99 por cento por efeito.'; END IF;
      IF _stored_type='mental_control_resistance' AND _value_mode='percent' AND _amount > 1000 THEN RAISE EXCEPTION 'Resistência Mental deve ser no máximo 1000 por cento por efeito.'; END IF;
    END IF;
    IF _stored_type='damage_reduction' THEN
      _attribute_key := NULL; _polarity := 'buff';
      IF _reduction_scope='magical' THEN
        IF jsonb_typeof(_effect->'damage_reduction_type_ids')='array' THEN
          SELECT COALESCE(array_agg(value::uuid),ARRAY[]::uuid[]) INTO _type_ids FROM jsonb_array_elements_text(_effect->'damage_reduction_type_ids') ids(value);
        ELSE _type_ids := ARRAY[]::uuid[]; END IF;
        IF jsonb_typeof(_effect->'damage_reduction_magic_levels')='array' THEN
          SELECT COALESCE(array_agg(value),ARRAY[]::text[]) INTO _magic_levels FROM jsonb_array_elements_text(_effect->'damage_reduction_magic_levels') levels(value);
        ELSE _magic_levels := ARRAY[]::text[]; END IF;
      ELSE _type_ids := NULL; _magic_levels := NULL; END IF;
    ELSE _reduction_scope := 'physical'; _type_ids := NULL; _magic_levels := NULL; END IF;

    _effect_target_scope := COALESCE(NULLIF(_effect->>'target_scope',''),'target');
    IF _effect_target_scope NOT IN ('caster','target','both') THEN
      RAISE EXCEPTION 'Destino do efeito manual inválido.';
    END IF;
    IF _effect_target_scope IN ('caster','both') AND _source_character_id IS NULL THEN
      RAISE EXCEPTION 'Selecione quem está causando o efeito para usar o destino Caster ou Ambos.';
    END IF;
    IF _effect_target_scope = 'caster' THEN
      _effect_target_ids := ARRAY[_source_character_id];
    ELSIF _effect_target_scope = 'both' AND _source_character_id IS DISTINCT FROM _character_id THEN
      _effect_target_ids := ARRAY[_character_id,_source_character_id];
    ELSE
      _effect_target_ids := ARRAY[_character_id];
    END IF;

    FOREACH _effect_target_id IN ARRAY _effect_target_ids
    LOOP
      INSERT INTO public.battle_effects (
        battle_id,character_id,target_character_id,name,effect_type,attribute_key,polarity,value_mode,amount,
        duration,duration_scope,until_combat_end,damage_scope,damage_reduction_scope,
        damage_reduction_type_id,damage_reduction_magic_level,damage_reduction_type_ids,damage_reduction_magic_levels,
        effect_data,effect_group_id,is_end_effect,is_sheet_permanent
      ) VALUES (
        _target_battle_id,_effect_target_id,_effect_target_id,_name,_stored_type,_attribute_key,_polarity,_value_mode,_amount,
        _duration,'individual',_until_combat_end,_damage_scope,_reduction_scope,NULL,NULL,_type_ids,_magic_levels,
        COALESCE(_effect,'{}'::jsonb) || jsonb_build_object('source_character_id',_source_character_id,'source_character_name',_source_name),
        gen_random_uuid(),false,_permanent
      );
      _applied := _applied + 1;
    END LOOP;
  END LOOP;

  FOR _dot IN SELECT value FROM jsonb_array_elements(COALESCE(_dots,'[]'::jsonb))
  LOOP
    _dot_name := NULLIF(BTRIM(_dot->>'name'),'');
    _dot_kind := _dot->>'damage_kind';
    _dot_mode := COALESCE(NULLIF(_dot->>'damage_mode',''),'fixed');
    _dot_amount := COALESCE(NULLIF(_dot->>'damage_amount','')::numeric,0);
    _dot_duration := CASE WHEN _permanent THEN 1 ELSE GREATEST(1,LEAST(1000,COALESCE(NULLIF(_dot->>'duration','')::integer,1))) END;
    _dot_physical_id := NULLIF(_dot->>'physical_damage_type_id','')::uuid;
    _dot_magic_id := NULLIF(_dot->>'damage_type_id','')::uuid;
    _dot_magic_level := NULLIF(_dot->>'magic_level','');
    IF _dot_name IS NULL OR length(_dot_name)>120 OR _dot_kind NOT IN ('physical','magical')
       OR _dot_mode NOT IN ('fixed','percent') THEN RAISE EXCEPTION 'Configuração de DoT inválida.'; END IF;
    IF _dot_amount <= 0 OR (_dot_mode='fixed' AND (_dot_amount>1000000 OR _dot_amount<>floor(_dot_amount)))
       OR (_dot_mode='percent' AND _dot_amount>1000) THEN RAISE EXCEPTION 'Valor de DoT inválido.'; END IF;
    IF _dot_kind='physical' AND NOT EXISTS (
      SELECT 1 FROM public.damage_types dt WHERE dt.id=_dot_physical_id AND dt.category='physical'
    ) THEN RAISE EXCEPTION 'Selecione um tipo físico válido para o DoT.'; END IF;
    IF _dot_kind='magical' AND NOT EXISTS (
      SELECT 1 FROM public.damage_types dt WHERE dt.id=_dot_magic_id AND dt.category='magical'
    ) THEN RAISE EXCEPTION 'Selecione um tipo mágico válido para o DoT.'; END IF;
    IF _dot_kind='magical' AND _dot_magic_level NOT IN ('baixa','media','alta') THEN
      RAISE EXCEPTION 'Selecione um grau de magia válido para o DoT.';
    END IF;
    IF public.character_is_immune_to_dot(_character_id,_battle_id,_dot) THEN CONTINUE; END IF;

    _name := CASE WHEN _source_name IS NULL THEN 'DoT — ' || _dot_name ELSE _source_name || ': DoT — ' || _dot_name END;
    INSERT INTO public.battle_effects (
      battle_id,character_id,target_character_id,name,effect_type,attribute_key,polarity,value_mode,amount,
      duration,duration_scope,until_combat_end,damage_scope,effect_data,effect_group_id,is_end_effect,is_sheet_permanent
    ) VALUES (
      _target_battle_id,_character_id,_character_id,LEFT(_name,160),'damage_over_time',NULL,'debuff',
      _dot_mode,_dot_amount,_dot_duration,'individual',false,_dot_kind,
      jsonb_build_object(
        'is_damage_over_time',true,'dot_template_id',COALESCE(_dot->>'template_id',_dot->>'id'),'dot_template_name',_dot_name,
        'damage_kind',_dot_kind,'physical_damage_type_id',_dot_physical_id,'damage_type_id',_dot_magic_id,
        'magic_level',_dot_magic_level,'damage_mode',_dot_mode,'damage_amount',_dot_amount,
        'source_character_id',_source_character_id::text,'source_character_name',_source_name
      ),
      gen_random_uuid(),false,_permanent
    );
    _applied := _applied + 1;
  END LOOP;
  RETURN _applied;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.repeat_character_ability_attack(_character_ability_id uuid, _target_character_id uuid, _battle_id uuid DEFAULT NULL::uuid, _extra_mana_cost integer DEFAULT 0, _hit_target_ids uuid[] DEFAULT NULL::uuid[], _hit_effect_groups jsonb DEFAULT NULL::jsonb, _dot_target_selections jsonb DEFAULT NULL::jsonb, _dot_attribute_values jsonb DEFAULT '{}'::jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  _hit_target_id uuid;
  _apply_both boolean := false;
  _effect_target_character_id uuid;
  _group_target_keys text[] := ARRAY[]::text[];
  _attack_effect_groups jsonb := '[]'::jsonb;
  _target_group_selection jsonb;
  _attack_group jsonb;
  _group_effect jsonb;
  _selected_target_id uuid;
  _selected_group_id text;
  _hit_effect_target_id uuid;
  _group_ids uuid[] := ARRAY[]::uuid[];
  _group_index integer;
  _healing_timing text;
  _mana_fixed_modifier numeric := 0;
  _mana_percent_modifier numeric := 0;
  _effective_mana_cost integer := 0;
  _effective_cooldown integer := 0;
  _cooldown_factor numeric := 1;
  _cooldown_virtue_id uuid;
  _race_mechanics jsonb := '{}'::jsonb;
  _class_mechanics jsonb := '{}'::jsonb;
  _virtue_multiplier numeric := 1;
  _once_use_inserted integer := 0;
  _effect_group_id uuid := gen_random_uuid();
  _is_master boolean := public.has_role(auth.uid(), 'master');
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;

  select * into _assignment
  from public.character_abilities
  where id = _character_ability_id
  for update;
  if not found then raise exception 'Habilidade não encontrada nesta ficha'; end if;

  _cooldown_virtue_id := COALESCE(_assignment.granted_by_virtue_id, _assignment.linked_by_virtue_id);
  SELECT COALESCE(r.special_mechanics, '{}'::jsonb), COALESCE(cl.special_mechanics, '{}'::jsonb)
  INTO _race_mechanics, _class_mechanics
  FROM public.characters c
  LEFT JOIN public.races r ON r.id = c.race_id
  LEFT JOIN public.classes cl ON cl.id = c.class_id
  WHERE c.id = _assignment.character_id;
  IF _cooldown_virtue_id IS NOT NULL THEN
    IF COALESCE(NULLIF(_race_mechanics->>'virtue_cooldown_reduction_percent', '')::numeric, 0) > 0 AND NOT COALESCE((_race_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_cooldown_virtue_id::text), false) THEN
      _cooldown_factor := _cooldown_factor * (1 - LEAST(100, GREATEST(0, (_race_mechanics->>'virtue_cooldown_reduction_percent')::numeric)) / 100);
    END IF;
    IF COALESCE(NULLIF(_class_mechanics->>'virtue_cooldown_reduction_percent', '')::numeric, 0) > 0 AND NOT COALESCE((_class_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_cooldown_virtue_id::text), false) THEN
      _cooldown_factor := _cooldown_factor * (1 - LEAST(100, GREATEST(0, (_class_mechanics->>'virtue_cooldown_reduction_percent')::numeric)) / 100);
    END IF;
  END IF;
  _effective_cooldown := GREATEST(0, FLOOR(_assignment.cooldown_turns * _cooldown_factor)::integer);

  IF _assignment.ability_id IS NULL AND _assignment.linked_by_virtue_id IS NOT NULL THEN
    IF COALESCE((_race_mechanics->>'duplicate_virtue_effects')::boolean, false) AND NOT COALESCE((_race_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_assignment.linked_by_virtue_id::text), false) THEN
      _virtue_multiplier := _virtue_multiplier * GREATEST(1, LEAST(10, COALESCE(NULLIF(_race_mechanics->>'virtue_effect_multiplier', '')::numeric, 2)));
    END IF;
    IF COALESCE((_class_mechanics->>'duplicate_virtue_effects')::boolean, false) AND NOT COALESCE((_class_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_assignment.linked_by_virtue_id::text), false) THEN
      _virtue_multiplier := _virtue_multiplier * GREATEST(1, LEAST(10, COALESCE(NULLIF(_class_mechanics->>'virtue_effect_multiplier', '')::numeric, 2)));
    END IF;
    _virtue_multiplier := GREATEST(1, LEAST(100, _virtue_multiplier));
    IF _virtue_multiplier > 1 THEN
      _assignment.effects := public.scale_racial_virtue_effect_json(COALESCE(_assignment.effects, '[]'::jsonb), _virtue_multiplier);
      _assignment.passive_effects := public.scale_racial_virtue_effect_json(COALESCE(_assignment.passive_effects, '[]'::jsonb), _virtue_multiplier);
      _assignment.end_effects := public.scale_racial_virtue_effect_json(COALESCE(_assignment.end_effects, '[]'::jsonb), _virtue_multiplier);
    END IF;
  END IF;

  select owner_id into _owner_id
  from public.characters where id = _assignment.character_id;
  if not found then raise exception 'Ficha do personagem não encontrada'; end if;
  if not _is_master then
    raise exception 'Apenas o mestre pode ativar habilidades';
  end if;

  IF _assignment.toggle_mode THEN RAISE EXCEPTION 'Habilidades sustentadas não podem usar o botão Atacar'; END IF;
  if not _assignment.can_activate or _assignment.cooldown_turns < 0 then
    raise exception 'Esta habilidade não pode ser ativada';
  end if;
  -- Recarga ignorada apenas nesta continuação autorizada.
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

  IF _hit_target_ids IS NOT NULL THEN
    IF NOT (
      (_assignment.ability_id IS NULL AND _assignment.attack_enabled IS TRUE)
      OR EXISTS (SELECT 1 FROM public.abilities a
        WHERE a.id = _assignment.ability_id AND a.attack_enabled IS TRUE)
    ) THEN
      RAISE EXCEPTION 'Esta habilidade não está configurada para atacar';
    END IF;
    IF _effective_battle_id IS NULL THEN
      RAISE EXCEPTION 'Ataques de habilidade só podem ser resolvidos dentro de uma batalha ativa';
    END IF;
    IF cardinality(_hit_target_ids) > 100 THEN
      RAISE EXCEPTION 'Um ataque pode selecionar no máximo 100 alvos';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM unnest(_hit_target_ids) AS selected(target_id)
      WHERE selected.target_id IS NULL
         OR selected.target_id = _assignment.character_id
         OR NOT EXISTS (
           SELECT 1 FROM public.battle_participants bp
           WHERE bp.battle_id = _effective_battle_id
             AND bp.character_id = selected.target_id
         )
    ) THEN
      RAISE EXCEPTION 'Todos os alvos atingidos precisam ser outros participantes da mesma batalha';
    END IF;
  END IF;

  if coalesce(_extra_mana_cost, 0) < 0 or coalesce(_extra_mana_cost, 0) > 1000000 then
    raise exception 'A Mana extra deve ficar entre 0 e 1000000';
  end if;

  -- Não repetir consumo do uso único.

  IF _effective_battle_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.ability_attack_sessions s
    WHERE s.battle_id=_effective_battle_id
      AND s.character_ability_id=_assignment.id
      AND s.master_id=auth.uid()
      AND s.started_at > now() - interval '6 hours'
  ) THEN
    RAISE EXCEPTION 'Este ataque já foi finalizado ou sua sessão expirou';
  END IF;
  IF COALESCE(_extra_mana_cost,0)<>0 THEN
    RAISE EXCEPTION 'Não é possível cobrar Mana extra numa continuação de ataque';
  END IF;

  -- Temporary battle overrides are applied to the local activation copy only.
  if _effective_battle_id is not null then
    select override_values into _effect from public.battle_ability_overrides
    where battle_id = _effective_battle_id and character_ability_id = _assignment.id;
    if found then
      if _effect ? 'mana_cost' then _assignment.mana_cost := greatest(0, least(1000000, (_effect->>'mana_cost')::integer)); end if;
      if _effect ? 'effects' and jsonb_typeof(_effect->'effects') = 'array' then _assignment.effects := _effect->'effects'; end if;
      if _effect ? 'end_effects' and jsonb_typeof(_effect->'end_effects') = 'array' then _assignment.end_effects := _effect->'end_effects'; end if;
    end if;
  end if;

  IF _hit_effect_groups IS NOT NULL THEN
    IF _hit_target_ids IS NULL OR jsonb_typeof(_hit_effect_groups) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'As categorias de efeitos exigem alvos válidos no ataque';
    END IF;
    IF _assignment.ability_id IS NULL AND _assignment.attack_enabled IS TRUE THEN
      _attack_effect_groups := COALESCE(_assignment.attack_effect_groups,'[]'::jsonb);
    ELSE
      SELECT coalesce(a.attack_effect_groups, '[]'::jsonb)
      INTO _attack_effect_groups
      FROM public.abilities a
      WHERE a.id = _assignment.ability_id AND a.attack_enabled IS TRUE;
    END IF;
    IF _attack_effect_groups IS NULL THEN
      RAISE EXCEPTION 'Esta habilidade não tem categorias de efeitos de ataque configuradas';
    END IF;
    IF jsonb_typeof(_attack_effect_groups) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Configuração de categorias de efeitos inválida';
    END IF;
    IF jsonb_array_length(_hit_effect_groups) > 100 THEN
      RAISE EXCEPTION 'Há categorias de efeitos demais na resolução deste ataque';
    END IF;

    FOR _target_group_selection IN
      SELECT value FROM jsonb_array_elements(_hit_effect_groups) AS selected(value)
    LOOP
      _selected_target_id := nullif(_target_group_selection->>'target_id', '')::uuid;
      IF _selected_target_id IS NULL OR NOT (_selected_target_id = ANY(_hit_target_ids)) THEN
        RAISE EXCEPTION 'Só é possível aplicar efeitos em alvos marcados como acertados';
      END IF;
      IF jsonb_typeof(_target_group_selection->'group_ids') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'A lista de categorias selecionadas é inválida';
      END IF;
      IF jsonb_array_length(_target_group_selection->'group_ids') > 100 THEN
        RAISE EXCEPTION 'Há categorias demais selecionadas para um alvo';
      END IF;

      FOR _selected_group_id IN
        SELECT DISTINCT selected_group.value
        FROM jsonb_array_elements_text(_target_group_selection->'group_ids') AS selected_group(value)
      LOOP
        SELECT entry.value INTO _attack_group
        FROM jsonb_array_elements(_attack_effect_groups) AS entry(value)
        WHERE entry.value->>'id' = _selected_group_id
        LIMIT 1;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Uma categoria de efeitos selecionada não pertence a esta habilidade';
        END IF;
        -- Changes made in the expanded attack editor are scoped to the
        -- target, group and current strike. They never modify saved abilities.
        IF _target_group_selection->'group_overrides'->_selected_group_id ? 'effects' THEN
          IF jsonb_typeof(_target_group_selection->'group_overrides'->_selected_group_id->'effects') IS DISTINCT FROM 'array'
             OR jsonb_array_length(_target_group_selection->'group_overrides'->_selected_group_id->'effects') > 100 THEN
            RAISE EXCEPTION 'Os efeitos modificados nesta utilização são inválidos';
          END IF;
          _attack_group := jsonb_set(_attack_group,'{effects}',
            _target_group_selection->'group_overrides'->_selected_group_id->'effects',true);
        END IF;
        IF jsonb_typeof(_attack_group->'effects') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'Uma categoria de efeitos está configurada incorretamente';
        END IF;
        IF jsonb_array_length(_attack_group->'effects') > 100 THEN
          RAISE EXCEPTION 'Uma categoria contém efeitos demais';
        END IF;
        FOR _group_effect IN
          SELECT value FROM jsonb_array_elements(_attack_group->'effects') AS configured(value)
        LOOP
          _assignment.effects := coalesce(_assignment.effects, '[]'::jsonb)
            || jsonb_build_array(
              (_group_effect - '__attack_effect_target_id')
              || jsonb_build_object('__attack_effect_target_id', _selected_target_id::text)
            );
        END LOOP;
      END LOOP;
    END LOOP;
  END IF;

  -- Continuação do ataque: sem novo custo de Mana, sem novo cooldown.
  if jsonb_typeof(coalesce(_assignment.effects, '[]'::jsonb)) <> 'array' then
    raise exception 'Configuração de efeitos ativos inválida';
  end if;

  for _effect in select value from jsonb_array_elements(coalesce(_assignment.effects, '[]'::jsonb))
  loop
    _hit_effect_target_id := nullif(_effect->>'__attack_effect_target_id', '')::uuid;
    _effect := _effect - '__attack_effect_target_id';
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
    IF _hit_effect_target_id IS NOT NULL THEN
      _effect_character_ids := ARRAY[]::uuid[];
      _apply_both := COALESCE((_effect->>'apply_both_on_activation')::boolean, false);

      IF _apply_both OR _target_scope IN ('caster', 'both') THEN
        _effect_character_ids := array_append(_effect_character_ids, _assignment.character_id);
      END IF;

      IF (_apply_both OR _target_scope IN ('target', 'both'))
         AND _hit_effect_target_id <> _assignment.character_id
         AND NOT (_hit_effect_target_id = ANY(_effect_character_ids)) THEN
        _effect_character_ids := array_append(_effect_character_ids, _hit_effect_target_id);
      END IF;
    ELSIF _hit_target_ids IS NOT NULL THEN
      _effect_character_ids := ARRAY[]::uuid[];
      _apply_both := COALESCE((_effect->>'apply_both_on_activation')::boolean, false);

      IF _apply_both OR _target_scope IN ('caster', 'both') THEN
        _effect_character_ids := array_append(_effect_character_ids, _assignment.character_id);
      END IF;

      IF _apply_both OR _target_scope IN ('target', 'both') THEN
        FOREACH _hit_target_id IN ARRAY COALESCE(_hit_target_ids, ARRAY[]::uuid[]) LOOP
          IF _hit_target_id IS NOT NULL
             AND _hit_target_id <> _assignment.character_id
             AND NOT (_hit_target_id = ANY(_effect_character_ids)) THEN
            _effect_character_ids := array_append(_effect_character_ids, _hit_target_id);
          END IF;
        END LOOP;
      END IF;
    ELSIF coalesce((_effect->>'apply_both_on_activation')::boolean, false) then
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
      'no_regen_hp','no_regen_mana','stun','magic_prohibition','damage_dealt','damage_reduction','damage_received','damage_vulnerability','no_mana','healing','invincible','healing_blocked','magic_healing_reversal','mental_control_immunity','mental_control_chance','mental_control_resistance','dot_immunity','dot_resistance','invisibility'
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
      IF _effect_type = 'damage_dealt' AND jsonb_typeof(_effect->'damage_dealt_physical_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_dealt_physical_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value AND dt.category = 'physical')
      ) THEN
        RAISE EXCEPTION 'Dano Causado contém um tipo físico inválido';
      END IF;
      _attribute_key := null;
    elsif _effect_type = 'damage_reduction' then
      if _polarity <> 'buff' then raise exception 'Mitigação de dano só pode ser um buff'; end if;
      PERFORM public.validate_mitigation_configuration(_effect);
      _attribute_key := null;
      if _damage_reduction_scope = 'physical' then
        _damage_reduction_type_id := null;
        _damage_reduction_magic_level := null;
        _damage_reduction_type_ids := coalesce(_damage_reduction_type_ids, ARRAY[]::uuid[]);
        _damage_reduction_magic_levels := null;
        if cardinality(_damage_reduction_type_ids) > 0 and exists (
          select 1 from unnest(_damage_reduction_type_ids) as selected(id)
          where not exists (select 1 from public.damage_types dt where dt.id = selected.id and dt.category = 'physical')
        ) then raise exception 'Selecione tipos físicos válidos para a mitigação'; end if;
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
          where not exists (select 1 from public.damage_types dt where dt.id = selected.id and dt.category = 'magical')
        ) then raise exception 'Selecione tipos mágicos válidos para a mitigação'; end if;
        if cardinality(_damage_reduction_magic_levels) > 0 and exists (
          select 1 from unnest(_damage_reduction_magic_levels) as selected(level)
          where selected.level not in ('baixa','media','alta')
        ) then raise exception 'Selecione graus mágicos válidos para a mitigação'; end if;
        _damage_reduction_type_id := null;
        _damage_reduction_magic_level := null;
      elsif _damage_reduction_scope = 'both' then
        -- Independent physical/magical selections are in effect_data.
        -- Legacy single-category columns must not combine UUIDs of two types.
        _damage_reduction_type_id := NULL;
        _damage_reduction_magic_level := NULL;
        _damage_reduction_type_ids := ARRAY[]::uuid[];
        _damage_reduction_magic_levels := ARRAY[]::text[];
      else
        raise exception 'Categoria de mitigação inválida';
      end if;
    elsif _effect_type IN ('mental_control_immunity','dot_immunity','invisibility') then
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
    elsif _effect_type = 'dot_resistance' then
      _attribute_key := null;
      _polarity := 'buff';
      _value_mode := coalesce(nullif(_effect->>'dot_resistance_value_mode', ''), _value_mode);
      _amount := coalesce(nullif(_effect->>'dot_resistance_amount', '')::numeric, _amount);
      IF _value_mode NOT IN ('fixed', 'percent') OR _amount < 0 OR (_value_mode = 'percent' AND _amount > 100) OR (_value_mode = 'fixed' AND _amount > 1000000) THEN
        RAISE EXCEPTION 'Resistência a DoTs precisa ser um valor válido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'dot_resistance_scope', ''), 'all') NOT IN ('all', 'physical', 'magical', 'specific') THEN
        RAISE EXCEPTION 'Escopo da Resistência a DoTs inválido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'dot_resistance_mode', ''), 'damage') NOT IN ('damage', 'duration') THEN
        RAISE EXCEPTION 'Modo da Resistência a DoTs inválido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'dot_resistance_scope', ''), 'all') = 'specific' AND (jsonb_typeof(_effect->'dot_resistance_template_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(_effect->'dot_resistance_template_ids') = 0) THEN
        RAISE EXCEPTION 'Selecione ao menos um DoT específico para a resistência';
      END IF;
    elsif _effect_type IN ('mental_control_chance','mental_control_resistance') then
      _attribute_key := null;
      IF _polarity <> 'buff' THEN RAISE EXCEPTION 'Modificadores de Controle Mental só podem ser buffs'; END IF;
      IF _value_mode NOT IN ('fixed','percent') OR _amount < 0 THEN RAISE EXCEPTION 'Modificador de Controle Mental inválido'; END IF;
      IF _effect_type = 'mental_control_chance' AND _value_mode = 'percent' AND _amount > 99 THEN
        RAISE EXCEPTION 'Potência de Controle Mental não pode ultrapassar 99 por cento por efeito';
      END IF;
      IF _effect_type = 'mental_control_resistance' AND _value_mode = 'percent' AND _amount > 1000 THEN
        RAISE EXCEPTION 'Resistência Mental não pode ultrapassar 1000 por cento por efeito';
      END IF;
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
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value AND dt.category = 'magical')
      ) THEN
        RAISE EXCEPTION 'Dano Recebido contém um tipo mágico inválido';
      END IF;
      IF jsonb_typeof(_effect->'damage_received_physical_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_received_physical_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value AND dt.category = 'physical')
      ) THEN
        RAISE EXCEPTION 'Dano Recebido contém um tipo físico inválido';
      END IF;
      IF jsonb_typeof(_effect->'damage_received_magic_levels') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_received_magic_levels') selected(value)
        WHERE selected.value NOT IN ('baixa', 'media', 'alta')
      ) THEN
        RAISE EXCEPTION 'Dano Recebido contém um nível mágico inválido';
      END IF;
    elsif _effect_type = 'damage_vulnerability' then
      IF _attribute_key IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.attribute_definitions WHERE key = _attribute_key
      ) THEN
        RAISE EXCEPTION 'Vulnerabilidade de Dano precisa de um atributo válido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'damage_vulnerability_scope',''), 'any') NOT IN ('any','physical','magical') THEN
        RAISE EXCEPTION 'Categoria de Vulnerabilidade de Dano inválida';
      END IF;
      IF COALESCE(NULLIF(_effect->>'damage_vulnerability_applied_duration','')::integer,1) NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'A duração do buff/debuff aplicado deve ficar entre 1 e 1000 turnos';
      END IF;
      IF jsonb_typeof(_effect->'damage_vulnerability_physical_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_vulnerability_physical_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text=selected.value AND dt.category='physical')
      ) THEN
        RAISE EXCEPTION 'Vulnerabilidade de Dano contém um tipo físico inválido';
      END IF;
      IF jsonb_typeof(_effect->'damage_vulnerability_magic_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_vulnerability_magic_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text=selected.value AND dt.category='magical')
      ) THEN
        RAISE EXCEPTION 'Vulnerabilidade de Dano contém um tipo mágico inválido';
      END IF;
      IF jsonb_typeof(_effect->'damage_vulnerability_magic_levels') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_vulnerability_magic_levels') selected(value)
        WHERE selected.value NOT IN ('baixa','media','alta')
      ) THEN
        RAISE EXCEPTION 'Vulnerabilidade de Dano contém um nível mágico inválido';
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
          WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id = selected.value::uuid AND dt.category = 'magical')
        ) THEN
          RAISE EXCEPTION 'A Reversão de Cura contém um tipo mágico inválido';
        END IF;
        IF jsonb_typeof(_effect->'magic_healing_whitelist_type_ids') = 'array' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(_effect->'magic_healing_whitelist_type_ids') selected(value)
          WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value AND dt.category = 'magical')
        ) THEN
          RAISE EXCEPTION 'Whitelist da Reversão de Cura contém um tipo mágico inválido';
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
      _effect_target_character_id := coalesce(_hit_effect_target_id, _target_character_id);
      IF _hit_target_ids IS NOT NULL THEN
        _group_index := array_position(
          _group_target_keys,
          _effect_character_id::text || ':' || coalesce(_hit_effect_target_id, _target_character_id)::text
        );
        IF _group_index IS NULL THEN
          _group_target_keys := array_append(
            _group_target_keys,
            _effect_character_id::text || ':' || coalesce(_hit_effect_target_id, _target_character_id)::text
          );
          _group_ids := array_append(_group_ids, gen_random_uuid());
          _group_index := cardinality(_group_target_keys);
        END IF;
        _effect_group_id := _group_ids[_group_index];
        IF _effect_character_id <> _assignment.character_id THEN
          _effect_target_character_id := _effect_character_id;
        END IF;
      END IF;
      if _effect_type = 'healing' then
        _healing_timing := coalesce(nullif(_effect->>'healing_timing', ''), 'instant');
        if _healing_timing not in ('instant', 'per_turn') then raise exception 'Modo de cura inválido'; end if;
        if coalesce((_effect->>'healing_hp_enabled')::boolean, false)
           or coalesce((_effect->>'healing_mana_enabled')::boolean, false)
           or coalesce((_effect->>'healing_body_enabled')::boolean, false)
           or coalesce((_effect->>'healing_sanity_enabled')::boolean, false)
           or coalesce((_effect->>'healing_remove_debuffs')::boolean, false)
           or coalesce(nullif(_effect->>'healing_reduce_debuff_turns_fixed','')::integer, 0) > 0
           or coalesce(nullif(_effect->>'healing_reduce_debuff_turns_percent','')::numeric, 0) > 0
            or coalesce(nullif(_effect->>'healing_relieve_debuff_percent','')::numeric, 0) > 0 then
          perform public.apply_ability_healing(
            _effect_character_id, _effective_battle_id, _effect || jsonb_build_object('_runtime_healer_character_id', _assignment.character_id), _healing_timing <> 'per_turn', true
          );
        else
          raise exception 'Configure pelo menos uma ação para a cura';
        end if;
        if nullif(_effect->>'healing_damage_type_id','') is not null and not exists (
          select 1 from public.damage_types where id = (_effect->>'healing_damage_type_id')::uuid and category='magical'
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
            _effect_group_id, false, 'any', _effect_target_character_id, _effect || jsonb_build_object('_runtime_healer_character_id', _assignment.character_id)
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
        _effect_target_character_id, _effect
      );
    end loop;
  end loop;

  -- Não reiniciar cooldown, disparar habilidade_ativada ou consumir override novamente.
  PERFORM public.apply_character_ability_dots(_assignment.id, _effective_battle_id, _dot_target_selections, _dot_attribute_values);

  IF _hit_target_ids IS NOT NULL AND _effective_battle_id IS NOT NULL THEN
    INSERT INTO public.ability_attack_sessions (battle_id,character_ability_id,master_id)
    VALUES (_effective_battle_id,_assignment.id,auth.uid())
    ON CONFLICT (battle_id,character_ability_id,master_id)
    DO UPDATE SET started_at=now();
  END IF;

  return 0;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.sync_character_class_effects(_character_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _class_id uuid;
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
  SELECT c.class_id
  INTO _class_id
  FROM public.characters c
  WHERE c.id = _character_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Remove only effects supplied by a previous race. Ability and manual effects remain untouched.
  DELETE FROM public.battle_effects e
  WHERE e.character_id = _character_id
    AND e.source_class_id IS NOT NULL
    AND e.source_class_id IS DISTINCT FROM _class_id;

  IF _class_id IS NULL THEN
    RETURN;
  END IF;

  SELECT r.starting_effects
  INTO _starting_effects
  FROM public.classes r
  WHERE r.id = _class_id;

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
      'damage_dealt', 'no_mana', 'damage_reduction', 'damage_received', 'invincible', 'healing_blocked', 'magic_healing_reversal', 'mental_control_immunity', 'mental_control_chance', 'mental_control_resistance', 'dot_immunity','dot_resistance','invisibility'
    ) THEN
      RAISE EXCEPTION 'Tipo de efeito da classe inválido: %', _effect_type;
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
      RAISE EXCEPTION 'Efeito da classe de status precisa escolher um atributo.';
    END IF;
    IF _stored_type = 'regeneration' AND _attribute_key NOT IN ('hp', 'mana') THEN
      RAISE EXCEPTION 'Efeito da classe de regeneração precisa usar HP ou Mana.';
    END IF;

    _polarity := CASE
      WHEN _stored_type IN ('magic_prohibition', 'no_mana', 'healing_blocked', 'damage_received') OR _effect_type = 'magic_healing_reversal' THEN 'debuff'
      WHEN _stored_type IN ('damage_reduction', 'invincible', 'mental_control_immunity', 'mental_control_chance', 'mental_control_resistance', 'dot_immunity','dot_resistance','invisibility') THEN 'buff'
      ELSE COALESCE(NULLIF(_effect ->> 'polarity', ''), 'buff')
    END;
    _value_mode := CASE WHEN _effect ->> 'value_mode' = 'percent' THEN 'percent' ELSE 'fixed' END;
    _amount := GREATEST(0, COALESCE(NULLIF(_effect ->> 'amount', '')::numeric, 0));
    _damage_scope := CASE WHEN _effect ->> 'damage_scope' IN ('physical', 'magical') THEN _effect ->> 'damage_scope' ELSE 'any' END;
    _reduction_scope := CASE WHEN _effect ->> 'damage_reduction_scope' IN ('physical','magical','both') THEN _effect ->> 'damage_reduction_scope' ELSE 'physical' END;
    _effect_name := LEFT(COALESCE(NULLIF(BTRIM(_effect ->> 'name'), ''), 'Efeito da classe'), 160);
    IF _effect_type = 'magic_healing_reversal' THEN
      IF COALESCE(NULLIF(_effect->>'magic_healing_reversal_damage_mode', ''), 'healing_amount') NOT IN ('healing_amount', 'custom', 'both') THEN
        RAISE EXCEPTION 'Modo de dano da Reversão de Cura inválido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'magic_healing_reversal_custom_damage', '')::numeric, 0) < 0 OR COALESCE(NULLIF(_effect->>'magic_healing_reversal_custom_damage', '')::numeric, 0) > 1000000 THEN
        RAISE EXCEPTION 'Dano customizado da Reversão de Cura deve ficar entre 0 e 1000000';
      END IF;
    END IF;
    IF _effect_type = 'damage_received' THEN
      IF COALESCE(NULLIF(_effect->>'damage_received_scope', ''), 'any') NOT IN ('any', 'physical', 'magical', 'race') THEN
        RAISE EXCEPTION 'Categoria de Dano Recebido da classe inválida';
      END IF;
      IF _amount > 1000000 THEN
        RAISE EXCEPTION 'Dano Recebido da classe deve ficar entre 0 e 1000000';
      END IF;
      IF COALESCE(NULLIF(_effect->>'damage_received_scope', ''), 'any') = 'race'
        AND (
          NULLIF(_effect->>'damage_received_race_id', '') IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.races r WHERE r.id::text = _effect->>'damage_received_race_id')
        ) THEN
        RAISE EXCEPTION 'Selecione uma raça válida para Dano Recebido racial';
      END IF;
      IF jsonb_typeof(_effect->'damage_received_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_received_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value)
      ) THEN
        RAISE EXCEPTION 'Dano Recebido racial contém um tipo mágico inválido';
      END IF;
      IF jsonb_typeof(_effect->'damage_received_magic_levels') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_received_magic_levels') selected(value)
        WHERE selected.value NOT IN ('baixa', 'media', 'alta')
      ) THEN
        RAISE EXCEPTION 'Dano Recebido racial contém um nível mágico inválido';
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
      is_end_effect, until_combat_end, source_class_id, source_class_effect_index
    ) VALUES (
      NULL, _character_id, _effect_name, _stored_type, _attribute_key, _polarity, _value_mode, _amount,
      1, 'individual', _damage_scope, _reduction_scope,
      NULL, NULL, _type_ids, _magic_levels,
      NULL, NULL, CASE WHEN _effect_type IN ('magic_healing_reversal', 'damage_received', 'mental_control_chance', 'mental_control_resistance', 'dot_immunity', 'damage_reduction') THEN _effect ELSE '{}'::jsonb END, NULL,
      false, false, _class_id, _effect_index
    )
    ON CONFLICT ON CONSTRAINT battle_effects_class_effect_key
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
    AND e.source_class_id = _class_id
    AND e.source_class_effect_index >= jsonb_array_length(COALESCE(_starting_effects, '[]'::jsonb));
END;
$function$
;
CREATE OR REPLACE FUNCTION public.sync_character_race_effects(_character_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
      'damage_dealt', 'no_mana', 'damage_reduction', 'damage_received', 'invincible', 'healing_blocked', 'magic_healing_reversal', 'mental_control_immunity', 'mental_control_chance', 'mental_control_resistance', 'dot_immunity','dot_resistance','invisibility'
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
      WHEN _stored_type IN ('magic_prohibition', 'no_mana', 'healing_blocked', 'damage_received') OR _effect_type = 'magic_healing_reversal' THEN 'debuff'
      WHEN _stored_type IN ('damage_reduction', 'invincible', 'mental_control_immunity', 'mental_control_chance', 'mental_control_resistance', 'dot_immunity','dot_resistance','invisibility') THEN 'buff'
      ELSE COALESCE(NULLIF(_effect ->> 'polarity', ''), 'buff')
    END;
    _value_mode := CASE WHEN _effect ->> 'value_mode' = 'percent' THEN 'percent' ELSE 'fixed' END;
    _amount := GREATEST(0, COALESCE(NULLIF(_effect ->> 'amount', '')::numeric, 0));
    _damage_scope := CASE WHEN _effect ->> 'damage_scope' IN ('physical', 'magical') THEN _effect ->> 'damage_scope' ELSE 'any' END;
    _reduction_scope := CASE WHEN _effect ->> 'damage_reduction_scope' IN ('physical','magical','both') THEN _effect ->> 'damage_reduction_scope' ELSE 'physical' END;
    _effect_name := LEFT(COALESCE(NULLIF(BTRIM(_effect ->> 'name'), ''), 'Efeito racial'), 160);
    IF _effect_type = 'magic_healing_reversal' THEN
      IF COALESCE(NULLIF(_effect->>'magic_healing_reversal_damage_mode', ''), 'healing_amount') NOT IN ('healing_amount', 'custom', 'both') THEN
        RAISE EXCEPTION 'Modo de dano da Reversão de Cura inválido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'magic_healing_reversal_custom_damage', '')::numeric, 0) < 0 OR COALESCE(NULLIF(_effect->>'magic_healing_reversal_custom_damage', '')::numeric, 0) > 1000000 THEN
        RAISE EXCEPTION 'Dano customizado da Reversão de Cura deve ficar entre 0 e 1000000';
      END IF;
    END IF;
    IF _effect_type = 'damage_received' THEN
      IF COALESCE(NULLIF(_effect->>'damage_received_scope', ''), 'any') NOT IN ('any', 'physical', 'magical', 'race') THEN
        RAISE EXCEPTION 'Categoria de Dano Recebido racial inválida';
      END IF;
      IF _amount > 1000000 THEN
        RAISE EXCEPTION 'Dano Recebido racial deve ficar entre 0 e 1000000';
      END IF;
      IF COALESCE(NULLIF(_effect->>'damage_received_scope', ''), 'any') = 'race'
        AND (
          NULLIF(_effect->>'damage_received_race_id', '') IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.races r WHERE r.id::text = _effect->>'damage_received_race_id')
        ) THEN
        RAISE EXCEPTION 'Selecione uma raça válida para Dano Recebido racial';
      END IF;
      IF jsonb_typeof(_effect->'damage_received_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_received_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value)
      ) THEN
        RAISE EXCEPTION 'Dano Recebido racial contém um tipo mágico inválido';
      END IF;
      IF jsonb_typeof(_effect->'damage_received_magic_levels') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_received_magic_levels') selected(value)
        WHERE selected.value NOT IN ('baixa', 'media', 'alta')
      ) THEN
        RAISE EXCEPTION 'Dano Recebido racial contém um nível mágico inválido';
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
      NULL, NULL, CASE WHEN _effect_type IN ('magic_healing_reversal', 'damage_received', 'mental_control_chance', 'mental_control_resistance', 'dot_immunity', 'damage_reduction') THEN _effect ELSE '{}'::jsonb END, NULL,
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
$function$
;
CREATE OR REPLACE FUNCTION public.sync_character_virtue_effects(_character_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _virtue_id uuid;
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
  SELECT c.virtue_id INTO _virtue_id
  FROM public.characters c WHERE c.id = _character_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF _virtue_id IS NOT NULL THEN
    SELECT v.starting_effects INTO _starting_effects
    FROM public.virtues v WHERE v.id = _virtue_id;
    IF NOT FOUND THEN _starting_effects := '[]'::jsonb; END IF;
  ELSE
    _starting_effects := '[]'::jsonb;
  END IF;
  IF jsonb_typeof(COALESCE(_starting_effects, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Os efeitos iniciais da virtude precisam ser uma lista.';
  END IF;

  -- Keep matching entries, remove only the old/removed virtue-owned effects.
  DELETE FROM public.battle_effects e
  WHERE e.character_id = _character_id
    AND e.source_virtue_id IS NOT NULL
    AND (
      e.source_virtue_id IS DISTINCT FROM _virtue_id
      OR e.source_virtue_effect_index >= jsonb_array_length(COALESCE(_starting_effects, '[]'::jsonb))
    );

  IF _virtue_id IS NULL THEN RETURN; END IF;

  FOR _effect, _effect_index IN
    SELECT item.value, (item.ordinality - 1)::integer
    FROM jsonb_array_elements(COALESCE(_starting_effects, '[]'::jsonb))
      WITH ORDINALITY AS item(value, ordinality)
  LOOP
    _effect_type := COALESCE(NULLIF(_effect->>'effect_type', ''), 'status');
    IF _effect_type NOT IN (
      'status','regeneration','mana_regeneration','mana_used','no_regen_hp','no_regen_mana',
      'magic_prohibition','stun','damage_dealt','no_mana','damage_reduction','damage_received',
      'damage_vulnerability','invincible','healing_blocked','magic_healing_reversal',
      'mental_control_immunity','mental_control_chance','mental_control_resistance','dot_immunity','dot_resistance','invisibility'
    ) THEN
      RAISE EXCEPTION 'Tipo de efeito inicial da virtude inválido: %', _effect_type;
    END IF;

    _stored_type := CASE
      WHEN _effect_type = 'mana_regeneration' THEN 'regeneration'
      WHEN _effect_type = 'magic_healing_reversal' THEN 'healing_blocked'
      ELSE _effect_type
    END;
    _attribute_key := CASE
      WHEN _stored_type IN ('status','damage_vulnerability') THEN NULLIF(_effect->>'attribute_key','')
      WHEN _stored_type = 'regeneration' THEN
        CASE WHEN _effect_type = 'mana_regeneration' THEN 'mana' ELSE NULLIF(_effect->>'attribute_key','') END
      ELSE NULL
    END;
    IF _stored_type IN ('status','damage_vulnerability') AND _attribute_key IS NULL THEN
      RAISE EXCEPTION 'Efeito inicial de status da virtude precisa escolher um atributo.';
    END IF;
    IF _stored_type = 'regeneration' AND _attribute_key NOT IN ('hp','mana') THEN
      RAISE EXCEPTION 'Regeneração inicial da virtude precisa usar HP ou Mana.';
    END IF;

    _polarity := CASE
      WHEN _stored_type IN ('magic_prohibition','no_mana','healing_blocked','damage_received') THEN 'debuff'
      WHEN _stored_type IN ('damage_reduction','invincible','mental_control_immunity','mental_control_chance',
        'mental_control_resistance','dot_immunity','dot_resistance','invisibility') THEN 'buff'
      ELSE COALESCE(NULLIF(_effect->>'polarity',''),'buff')
    END;
    _value_mode := CASE WHEN _effect->>'value_mode'='percent' THEN 'percent' ELSE 'fixed' END;
    _amount := GREATEST(0, COALESCE(NULLIF(_effect->>'amount','')::numeric,0));
    _damage_scope := CASE WHEN _effect->>'damage_scope' IN ('physical','magical') THEN _effect->>'damage_scope' ELSE 'any' END;
    _reduction_scope := CASE WHEN _effect->>'damage_reduction_scope' IN ('physical','magical','both') THEN _effect->>'damage_reduction_scope' ELSE 'physical' END;
    _effect_name := LEFT(COALESCE(NULLIF(BTRIM(_effect->>'name'),''),'Efeito inicial da virtude'),160);

    IF _stored_type IN ('no_mana','magic_prohibition') THEN
      _polarity := 'debuff'; _attribute_key := NULL; _amount := 0; _value_mode := 'fixed';
    ELSIF _stored_type IN ('invincible','healing_blocked','mental_control_immunity','dot_immunity','dot_resistance','invisibility') THEN
      _attribute_key := NULL; _amount := 0; _value_mode := 'fixed';
    ELSIF _stored_type IN ('mental_control_chance','mental_control_resistance') THEN
      _attribute_key := NULL;
      IF _polarity <> 'buff' OR _amount < 0 THEN RAISE EXCEPTION 'Modificador de Controle Mental da virtude inválido'; END IF;
    ELSIF _stored_type IN ('damage_dealt','mana_used','damage_received') THEN
      _attribute_key := NULL;
      IF _stored_type = 'damage_received' THEN _polarity := 'debuff'; END IF;
    END IF;

    IF _stored_type = 'damage_reduction' THEN
      _polarity := 'buff'; _attribute_key := NULL;
      IF _reduction_scope = 'magical' THEN
        IF jsonb_typeof(_effect->'damage_reduction_type_ids')='array' THEN
          SELECT COALESCE(array_agg(value::uuid), ARRAY[]::uuid[]) INTO _type_ids
          FROM jsonb_array_elements_text(_effect->'damage_reduction_type_ids') ids(value);
        ELSE _type_ids := ARRAY[]::uuid[]; END IF;
        IF jsonb_typeof(_effect->'damage_reduction_magic_levels')='array' THEN
          SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO _magic_levels
          FROM jsonb_array_elements_text(_effect->'damage_reduction_magic_levels') levels(value);
        ELSE _magic_levels := ARRAY[]::text[]; END IF;
      ELSE
        _type_ids := NULL; _magic_levels := NULL;
      END IF;
    ELSE
      _type_ids := NULL; _magic_levels := NULL; _reduction_scope := 'physical';
    END IF;

    IF _stored_type = 'damage_received' AND _amount > 1000000 THEN
      RAISE EXCEPTION 'Dano Recebido da virtude deve ficar entre 0 e 1000000';
    END IF;
    IF _stored_type = 'damage_vulnerability' THEN
      IF _polarity NOT IN ('buff','debuff') THEN RAISE EXCEPTION 'Polaridade da Vulnerabilidade de Dano inválida'; END IF;
    END IF;
    IF _stored_type IN ('mental_control_chance','mental_control_resistance') AND _value_mode='percent' AND _amount > 1000 THEN
      RAISE EXCEPTION 'O modificador percentual de Controle Mental da virtude ultrapassou o limite';
    END IF;

    INSERT INTO public.battle_effects (
      battle_id, character_id, name, effect_type, attribute_key, polarity, value_mode, amount,
      duration, duration_scope, damage_scope, damage_reduction_scope,
      damage_reduction_type_id, damage_reduction_magic_level, damage_reduction_type_ids,
      damage_reduction_magic_levels, source_character_ability_id, target_character_id, effect_data,
      effect_group_id, is_end_effect, until_combat_end, source_virtue_id, source_virtue_effect_index,
      is_sheet_permanent
    ) VALUES (
      NULL, _character_id, _effect_name, _stored_type, _attribute_key, _polarity, _value_mode, _amount,
      1, 'individual', _damage_scope, _reduction_scope,
      NULL, NULL, _type_ids, _magic_levels, NULL, NULL, _effect,
      NULL, false, false, _virtue_id, _effect_index, true
    )
    ON CONFLICT ON CONSTRAINT battle_effects_virtue_effect_key
    DO UPDATE SET
      name = EXCLUDED.name, effect_type = EXCLUDED.effect_type, attribute_key = EXCLUDED.attribute_key,
      polarity = EXCLUDED.polarity, value_mode = EXCLUDED.value_mode, amount = EXCLUDED.amount,
      duration = 1, duration_scope = EXCLUDED.duration_scope, damage_scope = EXCLUDED.damage_scope,
      damage_reduction_scope = EXCLUDED.damage_reduction_scope,
      damage_reduction_type_id = EXCLUDED.damage_reduction_type_id,
      damage_reduction_magic_level = EXCLUDED.damage_reduction_magic_level,
      damage_reduction_type_ids = EXCLUDED.damage_reduction_type_ids,
      damage_reduction_magic_levels = EXCLUDED.damage_reduction_magic_levels,
      target_character_id = NULL, effect_data = EXCLUDED.effect_data, effect_group_id = NULL,
      is_end_effect = false, until_combat_end = false, is_sheet_permanent = true;
  END LOOP;
END;
$function$
;
NOTIFY pgrst,'reload schema';
COMMIT;