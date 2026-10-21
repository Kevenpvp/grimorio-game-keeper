-- Skill effects can target the caster or selected target. Healing can restore several resources at once,
-- cleanse or shorten debuffs, and optionally become a recurring heal that ticks as turns advance.
-- Add effect metadata used to resolve each effect's destination and persist recurring healing settings.
ALTER TABLE public.battle_effects
  ADD COLUMN IF NOT EXISTS target_character_id uuid REFERENCES public.characters(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS effect_data jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.battle_effects DROP CONSTRAINT IF EXISTS battle_effects_effect_type_check;
ALTER TABLE public.battle_effects ADD CONSTRAINT battle_effects_effect_type_check
  CHECK (effect_type IN (
    'status','regeneration','no_regen_hp','no_regen_mana','stun','mana_used',
    'magic_prohibition','damage_dealt','no_mana','damage_reduction','healing'
  ));

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
  OR (effect_type = 'healing' AND attribute_key IS NULL AND polarity = 'buff' AND value_mode = 'fixed' AND amount = 0)
);
ALTER TABLE public.battle_effects DROP CONSTRAINT IF EXISTS battle_effects_effect_data_check;
ALTER TABLE public.battle_effects ADD CONSTRAINT battle_effects_effect_data_check
  CHECK (jsonb_typeof(effect_data) = 'object');


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
  _fixed_turns integer := 0;
  _percent_turns numeric := 0;
  _debuff record;
  _new_duration integer;
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

  IF _apply_resources THEN
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
        AND NOT (_blacklist ? e.effect_type);
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

REVOKE ALL ON FUNCTION public.apply_ability_healing(uuid, uuid, jsonb, boolean, boolean) FROM public, anon, authenticated;

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
    _duration := greatest(1, coalesce(nullif(_effect->>'duration', '')::integer, 1));
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
      'no_regen_hp','no_regen_mana','stun','magic_prohibition','damage_dealt','damage_reduction','no_mana','healing'
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
      perform public.apply_ability_healing(_effect_character_id, old.battle_id, _effect, true, true);
      continue;
    end if;

    insert into public.battle_effects (
      battle_id, character_id, name, effect_type, attribute_key, polarity,
      value_mode, amount, duration, duration_scope, source_character_ability_id,
      effect_group_id, is_end_effect, damage_scope,
      damage_reduction_scope, damage_reduction_type_id, damage_reduction_magic_level,
      damage_reduction_type_ids, damage_reduction_magic_levels,
      target_character_id, effect_data
    ) values (
      old.battle_id, _effect_character_id, _ability_name || ': ' || _effect_name,
      _effect_type, _attribute_key, _polarity, _value_mode, _amount, _duration,
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
  _effect_name text;
  _damage_scope text;
  _damage_reduction_scope text;
  _damage_reduction_type_id uuid;
  _damage_reduction_magic_level text;
  _damage_reduction_type_ids uuid[];
  _damage_reduction_magic_levels text[];
  _target_scope text;
  _effect_character_id uuid;
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
    _target_scope := coalesce(nullif(_effect->>'target_scope', ''), 'target');
    if _target_scope not in ('caster', 'target') then raise exception 'Destino de efeito inválido'; end if;
    _effect_character_id := case when _target_scope = 'caster' then _assignment.character_id else _target_character_id end;
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
      'no_regen_hp','no_regen_mana','stun','magic_prohibition','damage_dealt','damage_reduction','no_mana','healing'
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
          _effect_character_id, _effective_battle_id, _effect, _healing_timing <> 'per_turn', true
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
          value_mode, amount, duration, duration_scope, source_character_ability_id,
          effect_group_id, is_end_effect, damage_scope, target_character_id, effect_data
        ) values (
          _effective_battle_id, _effect_character_id, _assignment.name || ': ' || _effect_name,
          'healing', null, 'buff', 'fixed', 0, _duration, 'global', _assignment.id,
          _effect_group_id, false, 'any', _target_character_id, _effect
        );
      end if;
      continue;
    end if;

    insert into public.battle_effects (
      battle_id, character_id, name, effect_type, attribute_key, polarity,
      value_mode, amount, duration, duration_scope, source_character_ability_id,
      effect_group_id, is_end_effect, damage_scope,
      damage_reduction_scope, damage_reduction_type_id, damage_reduction_magic_level,
      damage_reduction_type_ids, damage_reduction_magic_levels,
      target_character_id, effect_data
    ) values (
      _effective_battle_id, _effect_character_id, _assignment.name || ': ' || _effect_name,
      _effect_type, _attribute_key, _polarity, _value_mode, _amount,
      _duration, 'global', _assignment.id, _effect_group_id, false, _damage_scope,
      _damage_reduction_scope, _damage_reduction_type_id, _damage_reduction_magic_level,
      _damage_reduction_type_ids, _damage_reduction_magic_levels,
      _target_character_id, _effect
    );
  end loop;

  return _effective_mana_cost;
end;
$$;

create or replace function public.advance_combat_turn(
  _battle_id uuid,
  _character_id uuid default null,
  _mana_regeneration_settings jsonb default '{}'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
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
        e.battle_id = _battle_id
        or (e.battle_id is null and exists (
          select 1 from public.battle_participants bp
          where bp.battle_id = _battle_id and bp.character_id = e.character_id
        ))
      )
    order by e.created_at, e.id
    for update of e
  loop
    perform public.apply_ability_healing(_periodic.character_id, _battle_id, _periodic.effect_data, true, false);
  end loop;

  if _character_id is not null then
    update public.character_abilities ca
    set cooldown_remaining = greatest(0, ca.cooldown_remaining - 1)
    where ca.character_id = _character_id and ca.can_activate and ca.cooldown_remaining > 0;
  else
    update public.character_abilities ca
    set cooldown_remaining = greatest(0, ca.cooldown_remaining - 1)
    where ca.can_activate and ca.cooldown_remaining > 0
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
  where e.duration = 1
    and (
      e.battle_id = _battle_id
      or (e.battle_id is null and exists (
        select 1 from public.battle_participants bp
        where bp.battle_id = _battle_id and bp.character_id = e.character_id
      ))
    );

  -- Decrement only effects with more than one turn remaining. Effects changed 2 -> 1
  -- remain active; only IDs captured above are expired after the decrement.
  update public.battle_effects e
  set duration = duration - 1
  where e.duration > 1
    and (
      e.battle_id = _battle_id
      or (e.battle_id is null and exists (
        select 1 from public.battle_participants bp
        where bp.battle_id = _battle_id and bp.character_id = e.character_id
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

  return _result_turn;
end;
$$;
