BEGIN;
CREATE OR REPLACE FUNCTION public.apply_activation_effect_value_overrides(
  _effects jsonb, _overrides jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _index_text text;
  _index integer;
  _patch jsonb;
  _field text;
  _value jsonb;
  _number numeric;
  _limit numeric;
  _effect jsonb;
  _type text;
  _allowed boolean;
  _resource text;
BEGIN
  IF NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode modificar efeitos ao ativar';
  END IF;
  IF jsonb_typeof(_effects) <> 'array' OR jsonb_typeof(_overrides) <> 'object'
     OR jsonb_object_length(_overrides) > 100 THEN
    RAISE EXCEPTION 'Configurações de efeitos inválidas';
  END IF;

  FOR _index_text,_patch IN SELECT key,value FROM jsonb_each(_overrides)
  LOOP
    IF _index_text !~ '^(0|[1-9][0-9]*)$'
      OR length(_index_text)>5
      OR _index_text::integer>=jsonb_array_length(_effects)
      OR jsonb_typeof(_patch)<>'object' THEN
      RAISE EXCEPTION 'Um efeito modificado não pertence a esta habilidade';
    END IF;
    _index:=_index_text::integer;
    _effect:=_effects->_index;
    IF coalesce((_effect->>'modify_on_activate')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'O efeito % não permite modificar ao ativar',_index+1;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(_patch))>20 THEN
      RAISE EXCEPTION 'Muitos valores alterados no mesmo efeito';
    END IF;
    _type:=_effect->>'effect_type';
    FOR _field,_value IN SELECT key,value FROM jsonb_each(_patch)
    LOOP
      _allowed:=false;
      _limit:=1000000;
      IF _field='amount' AND _type IN (
        'status','regeneration','mana_regeneration','mana_used','damage_dealt',
        'damage_reduction','damage_received','mental_control_chance','mental_control_resistance'
      ) THEN
        _allowed:=true;
      ELSIF _field='dot_resistance_amount' AND _type='dot_resistance' THEN
        _allowed:=true;
        IF coalesce(_effect->>'dot_resistance_value_mode','percent')='percent' THEN _limit:=100; END IF;
      ELSIF _type='healing' AND _field IN (
        'healing_hp_amount','healing_mana_amount','healing_body_amount','healing_sanity_amount'
      ) THEN
        _resource:=split_part(_field,'_',2);
        _allowed:=coalesce((_effect->>('healing_'||_resource||'_enabled'))::boolean,false);
        IF coalesce(_effect->>('healing_'||_resource||'_mode'),'fixed')='percent' THEN _limit:=100; END IF;
      ELSIF _type='healing' AND _field IN (
        'healing_reduce_debuff_turns_fixed','healing_reduce_debuff_turns_percent',
        'healing_relieve_debuff_percent'
      ) THEN
        _allowed:=coalesce(NULLIF(_effect->>_field,'')::numeric,0)>0;
        IF _field='healing_reduce_debuff_turns_fixed' THEN _limit:=1000;
        ELSE _limit:=100; END IF;
      ELSIF _type='magic_healing_reversal' AND _field='magic_healing_reversal_custom_damage'
        AND coalesce(_effect->>'magic_healing_reversal_damage_mode','healing_amount') IN ('custom','both') THEN
        _allowed:=true;
      END IF;
      IF NOT _allowed OR jsonb_typeof(_value)<>'number' THEN
        RAISE EXCEPTION 'O campo % não pode ser alterado ao ativar',_field;
      END IF;
      _number:=(_value#>>'{}')::numeric;
      IF _number<0 OR _number>_limit THEN
        RAISE EXCEPTION 'O valor de % deve ficar entre 0 e %',_field,_limit;
      END IF;
      IF _field='healing_reduce_debuff_turns_fixed' AND _number<>trunc(_number) THEN
        RAISE EXCEPTION 'A duração de debuffs deve ser um número inteiro';
      END IF;
      _effect:=jsonb_set(_effect,ARRAY[_field],_value,true);
      IF _field='dot_resistance_amount' THEN
        _effect:=jsonb_set(_effect,'{amount}',_value,true);
      END IF;
    END LOOP;
    _effects:=jsonb_set(_effects,ARRAY[_index_text],_effect,false);
  END LOOP;
  RETURN _effects;
END;
$function$;
REVOKE ALL ON FUNCTION public.apply_activation_effect_value_overrides(jsonb,jsonb)
FROM PUBLIC,anon,authenticated;
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
NOTIFY pgrst,'reload schema';
COMMIT;