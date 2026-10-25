BEGIN;
ALTER TABLE public.abilities
  ADD COLUMN IF NOT EXISTS duration_turns integer NOT NULL DEFAULT 0
  CHECK (duration_turns BETWEEN 0 AND 1000);
ALTER TABLE public.character_abilities
  ADD COLUMN IF NOT EXISTS duration_turns integer NOT NULL DEFAULT 0 CHECK(duration_turns BETWEEN 0 AND 1000),
  ADD COLUMN IF NOT EXISTS active_duration_remaining integer NOT NULL DEFAULT 0 CHECK(active_duration_remaining BETWEEN 0 AND 1000),
  ADD COLUMN IF NOT EXISTS pending_cooldown_turns integer NOT NULL DEFAULT 0 CHECK(pending_cooldown_turns BETWEEN 0 AND 1000000);
CREATE OR REPLACE FUNCTION public.init_ability_duration_from_catalog()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
 IF NEW.ability_id IS NOT NULL AND NEW.duration_turns=0 THEN
   SELECT a.duration_turns INTO NEW.duration_turns FROM public.abilities a WHERE a.id=NEW.ability_id;
 END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS a_character_abilities_duration_default ON public.character_abilities;
CREATE TRIGGER a_character_abilities_duration_default
BEFORE INSERT ON public.character_abilities
FOR EACH ROW EXECUTE FUNCTION public.init_ability_duration_from_catalog();

CREATE OR REPLACE FUNCTION public.sync_catalog_ability_duration()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
 IF OLD.duration_turns IS DISTINCT FROM NEW.duration_turns THEN
  UPDATE public.character_abilities ca
  SET duration_turns=NEW.duration_turns
  WHERE ca.ability_id=NEW.id AND ca.duration_turns=OLD.duration_turns
    AND ca.active_duration_remaining=0;
 END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS abilities_sync_duration ON public.abilities;
CREATE TRIGGER abilities_sync_duration AFTER UPDATE OF duration_turns ON public.abilities
FOR EACH ROW EXECUTE FUNCTION public.sync_catalog_ability_duration();
REVOKE ALL ON FUNCTION public.init_ability_duration_from_catalog() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.sync_catalog_ability_duration() FROM PUBLIC,anon,authenticated;
UPDATE public.character_abilities ca SET duration_turns=a.duration_turns
FROM public.abilities a WHERE ca.ability_id=a.id AND ca.duration_turns=0 AND a.duration_turns>0;

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
    floor(greatest(0, _assignment.mana_cost + _mana_fixed_modifier + coalesce(_extra_mana_cost, 0))
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

CREATE OR REPLACE FUNCTION public.advance_combat_turn(_battle_id uuid, _character_id uuid DEFAULT NULL::uuid, _mana_regeneration_settings jsonb DEFAULT '{}'::jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _active boolean;
  _global_turn integer;
  _result_turn integer;
  _fighter record;
  _fighter_id uuid;
  _base_regen numeric;
  _mana_current numeric;
  _mana_max numeric;
  _fixed_regen numeric;
  _percent_regen numeric;
  _adjusted_regen numeric;
  _regen_blocked boolean;
  _expired_ids uuid[] := ARRAY[]::uuid[];
  _expired record;
  _periodic record;
  _dot record;
  _dot_script record;
  _dot_result jsonb;
  _dot_hits jsonb := '[]'::jsonb;
  _dot_data jsonb;
  _dot_kind text;
  _dot_mode text;
  _dot_amount numeric;
  _dot_raw_damage numeric;
  _dot_hp_max numeric;
  _dot_physical_type_id uuid;
  _dot_magic_type_id uuid;
  _dot_magic_level text;
  _dot_source_id uuid;
  _dot_total integer;
  _dot_potential_total integer;
  _dot_final_values jsonb;
  _dot_potential_values jsonb;
  _dot_invincible boolean;
  _dot_hp_before integer;
  _dot_hp_after integer;
begin
  if auth.uid() is null or not public.has_role(auth.uid(), 'master') then
    raise exception 'Apenas o mestre pode avançar turnos';
  end if;
  if jsonb_typeof(coalesce(_mana_regeneration_settings, '{}'::jsonb)) <> 'object' then
    raise exception 'Configuração de regeneração de Mana inválida';
  end if;

  select b.active, b.turn_count
  into _active, _global_turn
  from public.battles b
  where b.id = _battle_id
  for update;
  if not found then raise exception 'Batalha não encontrada'; end if;
  if not _active then raise exception 'Esta batalha já está encerrada'; end if;

  if _character_id is not null then
    update public.battle_participants bp
    set turn_count = coalesce(bp.turn_count, 0) + 1
    where bp.battle_id = _battle_id and bp.character_id = _character_id
    returning bp.turn_count into _result_turn;
    if not found then raise exception 'Personagem não encontrado nesta batalha'; end if;
  else
    update public.battles
    set turn_count = coalesce(turn_count, 0) + 1
    where id = _battle_id
    returning turn_count into _result_turn;

    update public.battle_participants bp
    set turn_count = coalesce(bp.turn_count, 0) + 1
    where bp.battle_id = _battle_id;
  end if;

  -- Apply the configured base regeneration using current database modifiers before ticking durations.
  for _fighter in select key, value from jsonb_each(coalesce(_mana_regeneration_settings, '{}'::jsonb))
  loop
    _fighter_id := _fighter.key::uuid;
    if jsonb_typeof(_fighter.value) <> 'object'
       or coalesce(_fighter.value ->> 'mode', '') not in ('percent', 'fixed') then
      raise exception 'Configuração de regeneração inválida para %', _fighter_id;
    end if;
    _base_regen := nullif(_fighter.value ->> 'amount', '')::numeric;
    if _base_regen is null or _base_regen < 0 then
      raise exception 'Regeneração inválida para %', _fighter_id;
    end if;
    if (_character_id is not null and _fighter_id <> _character_id)
       or not exists (
         select 1 from public.battle_participants bp
         where bp.battle_id = _battle_id and bp.character_id = _fighter_id
       ) then
      raise exception 'Regeneração informada para um personagem que não pertence à ação de turno';
    end if;

    select ca.current_value
    into _mana_current
    from public.character_attributes ca
    where ca.character_id = _fighter_id and ca.attribute_key = 'mana'
    for update;
    if not found then raise exception 'Esta ficha não possui o atributo Mana'; end if;

    _mana_max := public.calculate_character_resource_max(_fighter_id, 'mana');
    if _fighter.value ->> 'mode' = 'percent' then
      _base_regen := ceil(_mana_max * _base_regen / 100);
    else
      _base_regen := floor(_base_regen);
    end if;

    select
      coalesce(sum(case when modifiers.polarity = 'buff' then modifiers.amount else -modifiers.amount end)
        filter (where modifiers.value_mode = 'fixed'), 0),
      coalesce(sum(case when modifiers.polarity = 'buff' then modifiers.amount else -modifiers.amount end)
        filter (where modifiers.value_mode = 'percent'), 0)
    into _fixed_regen, _percent_regen
    from (
      select e.polarity, e.value_mode, e.amount
      from public.battle_effects e
      where e.character_id = _fighter_id
        and e.effect_type = 'regeneration'
        and e.attribute_key = 'mana'
        and e.duration > 0
        and (e.battle_id is null or e.battle_id = _battle_id)

      union all

      select
        coalesce(passive.effect ->> 'polarity', 'buff'),
        coalesce(passive.effect ->> 'value_mode', 'fixed'),
        coalesce(nullif(passive.effect ->> 'amount', '')::numeric, 0)
      from public.character_abilities ca
      cross join lateral jsonb_array_elements(coalesce(ca.passive_effects, '[]'::jsonb)) as passive(effect)
      where ca.character_id = _fighter_id
        and (
          (passive.effect ->> 'effect_type' = 'regeneration' and passive.effect ->> 'attribute_key' = 'mana')
          or passive.effect ->> 'effect_type' = 'mana_regeneration'
        )
    ) as modifiers;

    select
      exists (
        select 1 from public.battle_effects e
        where e.character_id = _fighter_id
          and e.effect_type = 'no_regen_mana'
          and e.duration > 0
          and (e.battle_id is null or e.battle_id = _battle_id)
      )
      or exists (
        select 1
        from public.character_abilities ca
        cross join lateral jsonb_array_elements(coalesce(ca.passive_effects, '[]'::jsonb)) as passive(effect)
        where ca.character_id = _fighter_id and passive.effect ->> 'effect_type' = 'no_regen_mana'
      )
    into _regen_blocked;

    if not _regen_blocked then
      _adjusted_regen := greatest(0, floor(_base_regen * (1 + coalesce(_percent_regen, 0) / 100) + coalesce(_fixed_regen, 0)));
      update public.character_attributes
      set current_value = least(_mana_max, greatest(0, coalesce(current_value, 0) + _adjusted_regen))::integer,
          updated_at = now()
      where character_id = _fighter_id and attribute_key = 'mana';
    end if;
  end loop;

  -- Periodic healing ticks once for every turn advancement, before effects at duration 1 expire.
  for _periodic in
    select e.character_id, e.effect_data
    from public.battle_effects e
    where e.effect_type = 'healing'
      and e.effect_data->>'healing_timing' = 'per_turn'
      and e.duration > 0
      and (
      (_character_id is not null and e.character_id = _character_id
        and (e.battle_id = _battle_id or e.battle_id is null))
      or
      (_character_id is null and (
        e.battle_id = _battle_id
        or (e.battle_id is null and exists (
          select 1 from public.battle_participants bp
          where bp.battle_id = _battle_id and bp.character_id = e.character_id
        ))
      ))
    )
    order by e.created_at, e.id
    for update of e
  loop
    perform public.apply_ability_healing(_periodic.character_id, _battle_id, _periodic.effect_data, true, false);
  end loop;

  -- Tick DoTs before duration decrement. Individual turns tick the current target;
  -- a global turn ticks each participant's active DoTs.
  FOR _dot IN
    SELECT e.id, e.character_id, e.name, e.effect_data
    FROM public.battle_effects e
    WHERE e.effect_type = 'damage_over_time'
      AND e.duration > 0
      AND NOT e.until_combat_end
      AND e.source_race_id IS NULL
      AND (
        (_character_id IS NOT NULL AND e.character_id = _character_id
          AND (e.battle_id = _battle_id OR e.battle_id IS NULL))
        OR
        (_character_id IS NULL AND (
          e.battle_id = _battle_id
          OR (e.battle_id IS NULL AND EXISTS (
            SELECT 1 FROM public.battle_participants bp
            WHERE bp.battle_id = _battle_id AND bp.character_id = e.character_id
          ))
        ))
      )
    ORDER BY e.created_at, e.id
    FOR UPDATE OF e
  LOOP
    _dot_data := COALESCE(_dot.effect_data, '{}'::jsonb);
    _dot_kind := COALESCE(_dot_data->>'damage_kind', '');
    _dot_mode := COALESCE(_dot_data->>'damage_mode', '');
    _dot_amount := CASE
      WHEN COALESCE(_dot_data->>'damage_amount', '') ~ '^[0-9]+([.][0-9]+)?$'
        THEN (_dot_data->>'damage_amount')::numeric
      ELSE 0
    END;

    IF _dot_kind NOT IN ('physical','magical')
       OR _dot_mode NOT IN ('fixed','percent')
       OR _dot_amount <= 0 THEN
      CONTINUE;
    END IF;

    _dot_physical_type_id := NULL;
    _dot_magic_type_id := NULL;
    _dot_magic_level := NULL;
    _dot_source_id := NULL;

    IF _dot_kind = 'physical' THEN
      IF COALESCE(_dot_data->>'physical_damage_type_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        CONTINUE;
      END IF;
      _dot_physical_type_id := (_dot_data->>'physical_damage_type_id')::uuid;
      IF NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id = _dot_physical_type_id AND dt.category = 'physical') THEN
        CONTINUE;
      END IF;
    ELSE
      IF COALESCE(_dot_data->>'damage_type_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR COALESCE(_dot_data->>'magic_level','') NOT IN ('baixa','media','alta') THEN
        CONTINUE;
      END IF;
      _dot_magic_type_id := (_dot_data->>'damage_type_id')::uuid;
      _dot_magic_level := _dot_data->>'magic_level';
      IF NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id = _dot_magic_type_id AND dt.category = 'magical') THEN
        CONTINUE;
      END IF;
    END IF;

    IF COALESCE(_dot_data->>'source_character_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      _dot_source_id := (_dot_data->>'source_character_id')::uuid;
      IF _dot_source_id = _dot.character_id
         OR NOT EXISTS (SELECT 1 FROM public.battle_participants bp WHERE bp.battle_id = _battle_id AND bp.character_id = _dot_source_id) THEN
        _dot_source_id := NULL;
      END IF;
    END IF;

    IF _dot_mode = 'percent' THEN
      _dot_hp_max := public.calculate_character_resource_max(_dot.character_id, 'hp');
      _dot_raw_damage := CEIL(GREATEST(0, COALESCE(_dot_hp_max, 0)) * _dot_amount / 100);
    ELSE
      _dot_raw_damage := FLOOR(_dot_amount);
    END IF;
    _dot_raw_damage := _dot_raw_damage - COALESCE(NULLIF(_dot_data->>'dot_fixed_damage_reduction', '')::numeric, 0);
    _dot_raw_damage := LEAST(1000000, GREATEST(0, COALESCE(_dot_raw_damage, 0)));
    IF _dot_raw_damage <= 0 THEN CONTINUE; END IF;

    _dot_result := public.apply_battle_damage(
      _battle_id, _dot.character_id, _dot_kind, _dot_magic_type_id,
      jsonb_build_array(_dot_raw_damage), _dot_magic_level, _dot_source_id, _dot_physical_type_id
    );

    _dot_total := COALESCE(NULLIF(_dot_result->>'total_damage','')::integer, 0);
    _dot_hp_before := COALESCE(NULLIF(_dot_result->>'hp_before','')::integer, 0);
    _dot_hp_after := COALESCE(NULLIF(_dot_result->>'hp_after','')::integer, 0);
    _dot_invincible := COALESCE(NULLIF(_dot_result->>'is_invincible','')::boolean, false);
    _dot_final_values := COALESCE(_dot_result->'final_damage_by_hit', '[]'::jsonb);
    _dot_potential_values := COALESCE(_dot_result->'damage_without_invincible_by_hit', _dot_final_values);

    SELECT COALESCE(SUM((entry.value #>> '{}')::integer), 0)::integer
    INTO _dot_potential_total
    FROM jsonb_array_elements(_dot_potential_values) AS entry(value);

    _dot_hits := _dot_hits || jsonb_build_array(jsonb_build_object(
      'effect_id', _dot.id, 'character_id', _dot.character_id,
      'source_character_id', _dot_source_id, 'damage_kind', _dot_kind,
      'physical_damage_type_id', _dot_physical_type_id, 'damage_type_id', _dot_magic_type_id,
      'magic_level', _dot_magic_level, 'raw_damage', _dot_raw_damage, 'total_damage', _dot_total,
      'potential_total', _dot_potential_total, 'final_damage_by_hit', _dot_final_values,
      'potential_damage_by_hit', _dot_potential_values, 'is_invincible', _dot_invincible,
      'hp_before', _dot_hp_before, 'hp_after', _dot_hp_after
    ));

    -- Trigger vulnerability effects now; newly applied effects are excluded from this tick's duration decrement.
    IF _dot_total > 0 THEN
      PERFORM public.trigger_damage_vulnerability_effects(
        _battle_id, _dot.character_id, _dot_kind, _dot_physical_type_id,
        _dot_magic_type_id, _dot_magic_level, _dot_total
      );
    END IF;
  END LOOP;

  -- A configured duration counts down before cooldown begins. When the
  -- duration reaches zero, start the pending cooldown (don't tick it yet).
  if _character_id is not null then
    update public.character_abilities ca
    set cooldown_remaining = CASE
          WHEN ca.active_duration_remaining = 1 THEN ca.pending_cooldown_turns
          WHEN ca.active_duration_remaining > 1 THEN 0
          ELSE greatest(0,ca.cooldown_remaining-1) END,
        active_duration_remaining = greatest(0,ca.active_duration_remaining-1),
        pending_cooldown_turns = CASE WHEN ca.active_duration_remaining=1 THEN 0 ELSE ca.pending_cooldown_turns END
    where ca.character_id = _character_id AND ca.can_activate
      AND (ca.cooldown_remaining > 0 OR ca.active_duration_remaining > 0);
  else
    update public.character_abilities ca
    set cooldown_remaining = CASE
          WHEN ca.active_duration_remaining = 1 THEN ca.pending_cooldown_turns
          WHEN ca.active_duration_remaining > 1 THEN 0
          ELSE greatest(0,ca.cooldown_remaining-1) END,
        active_duration_remaining = greatest(0,ca.active_duration_remaining-1),
        pending_cooldown_turns = CASE WHEN ca.active_duration_remaining=1 THEN 0 ELSE ca.pending_cooldown_turns END
    where ca.can_activate AND (ca.cooldown_remaining > 0 OR ca.active_duration_remaining > 0)
      and exists (
        select 1 from public.battle_participants bp
        where bp.battle_id = _battle_id and bp.character_id = ca.character_id
      );
  end if;

  -- Snapshot effects that were already at 1 BEFORE ticking. This preserves the
  -- database CHECK constraint (duration must stay >= 1) and prevents effects that
  -- change from 2 -> 1 in this same turn from being removed prematurely.
  select coalesce(array_agg(e.id order by e.created_at, e.id), ARRAY[]::uuid[])
  into _expired_ids
  from public.battle_effects e
  where e.duration = 1 AND NOT e.is_sheet_permanent
    AND e.created_at < transaction_timestamp()
    AND NOT e.until_combat_end
    AND e.source_race_id IS NULL
    and (
      (_character_id is not null and e.character_id = _character_id
        and (e.battle_id = _battle_id or e.battle_id is null))
      or
      (_character_id is null and (
        e.battle_id = _battle_id
        or (e.battle_id is null and exists (
          select 1 from public.battle_participants bp
          where bp.battle_id = _battle_id and bp.character_id = e.character_id
        ))
      ))
    );

  -- Decrement only effects with more than one turn remaining. Effects changed 2 -> 1
  -- remain active; only IDs captured above are expired after the decrement.
  update public.battle_effects e
  set duration = duration - 1
  where e.duration > 1 AND NOT e.is_sheet_permanent
    AND e.created_at < transaction_timestamp()
    AND NOT e.until_combat_end
    AND e.source_race_id IS NULL
    and (
      (_character_id is not null and e.character_id = _character_id
        and (e.battle_id = _battle_id or e.battle_id is null))
      or
      (_character_id is null and (
        e.battle_id = _battle_id
        or (e.battle_id is null and exists (
          select 1 from public.battle_participants bp
          where bp.battle_id = _battle_id and bp.character_id = e.character_id
        ))
      ))
    );

  -- Delete the pre-tick duration-1 effects after the countdown, so end effects created
  -- by delete triggers are not decremented during the turn that causes their creation.
  for _expired in
    select e.id
    from unnest(coalesce(_expired_ids, ARRAY[]::uuid[])) as expired(id)
    join public.battle_effects e on e.id = expired.id
    order by e.created_at, e.id
    for update of e
  loop
    delete from public.battle_effects e where e.id = _expired.id;
  end loop;

  -- Queue received-damage scripts after the turn's atomic HP updates.
  FOR _dot IN
    SELECT item.value AS event_data
    FROM jsonb_array_elements(_dot_hits) AS item(value)
  LOOP
    IF COALESCE(NULLIF(_dot.event_data->>'total_damage','')::integer, 0) > 0
       OR (COALESCE(NULLIF(_dot.event_data->>'is_invincible','')::boolean, false)
          AND COALESCE(NULLIF(_dot.event_data->>'potential_total','')::integer, 0) > 0) THEN
      FOR _dot_script IN
        SELECT ca.id
        FROM public.character_abilities ca
        JOIN public.abilities a ON a.id = ca.ability_id
        WHERE ca.character_id = (_dot.event_data->>'character_id')::uuid
          AND NULLIF(TRIM(a.custom_script_key), '') IS NOT NULL
      LOOP
        PERFORM public.queue_ability_script_event(
          'recebeu_dano', _dot_script.id,
          (_dot.event_data->>'character_id')::uuid, _battle_id,
          (_dot.event_data->>'character_id')::uuid, NULL,
          jsonb_build_object('dano', jsonb_build_object(
            'origemId', NULLIF(_dot.event_data->>'source_character_id',''),
            'personagemAtingidoId', _dot.event_data->>'character_id',
            'categoria', _dot.event_data->>'damage_kind',
            'tipoDanoId', NULLIF(_dot.event_data->>'damage_type_id',''),
            'tipoDanoFisicoId', NULLIF(_dot.event_data->>'physical_damage_type_id',''),
            'grauMagia', NULLIF(_dot.event_data->>'magic_level',''),
            'critico', false, 'dot', true,
            'danoBrutoPorGolpe', jsonb_build_array((_dot.event_data->>'raw_damage')::numeric),
            'danoFinalPorGolpe', _dot.event_data->'final_damage_by_hit',
            'danoFinalTotal', COALESCE(NULLIF(_dot.event_data->>'total_damage','')::integer,0),
            'danoPotencialSemInvencivelPorGolpe', _dot.event_data->'potential_damage_by_hit',
            'danoPotencialSemInvencivelTotal', COALESCE(NULLIF(_dot.event_data->>'potential_total','')::integer,0),
            'bloqueadoPorInvencivel', COALESCE(NULLIF(_dot.event_data->>'is_invincible','')::boolean,false),
            'hpAntes', COALESCE(NULLIF(_dot.event_data->>'hp_before','')::integer,0),
            'hpDepois', COALESCE(NULLIF(_dot.event_data->>'hp_after','')::integer,0)
          ))
        );
      END LOOP;
    END IF;
  END LOOP;

  return _result_turn;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.tick_character_ability_cooldowns(_character_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null or not public.has_role(auth.uid(), 'master') then
    raise exception 'Apenas o mestre pode avançar cooldowns';
  end if;
  update public.character_abilities
  set cooldown_remaining = CASE
        WHEN active_duration_remaining = 1 THEN pending_cooldown_turns
        WHEN active_duration_remaining > 1 THEN 0
        ELSE greatest(0,cooldown_remaining-1) END,
      pending_cooldown_turns = CASE WHEN active_duration_remaining=1 THEN 0 ELSE pending_cooldown_turns END,
      active_duration_remaining = greatest(0,active_duration_remaining-1)
  where character_id = _character_id AND can_activate
    AND (cooldown_remaining>0 OR active_duration_remaining>0);
end;
$function$
;
NOTIFY pgrst,'reload schema';
COMMIT;