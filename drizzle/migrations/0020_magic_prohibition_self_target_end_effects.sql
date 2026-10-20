-- Add magic prohibition, self-only targeting, and effects triggered when ability effects expire.
alter table public.abilities
  add column self_target_only boolean not null default false,
  add column end_effects jsonb not null default '[]'::jsonb
    check (jsonb_typeof(end_effects) = 'array');

alter table public.character_abilities
  add column self_target_only boolean not null default false,
  add column end_effects jsonb not null default '[]'::jsonb
    check (jsonb_typeof(end_effects) = 'array');

alter table public.battle_effects
  add column effect_group_id uuid,
  add column is_end_effect boolean not null default false;

create index battle_effects_effect_group_idx
  on public.battle_effects(effect_group_id)
  where effect_group_id is not null;

alter table public.battle_effects drop constraint if exists battle_effects_effect_type_check;
alter table public.battle_effects
  add constraint battle_effects_effect_type_check
  check (effect_type in (
    'status','regeneration','no_regen_hp','no_regen_mana','stun','mana_used','magic_prohibition'
  ));

alter table public.battle_effects drop constraint if exists battle_effects_check;
alter table public.battle_effects
  add constraint battle_effects_check check (
    (effect_type = 'status' and attribute_key is not null)
    or (effect_type = 'regeneration' and attribute_key in ('hp','mana'))
    or effect_type in ('no_regen_hp','no_regen_mana','stun','mana_used')
    or (effect_type = 'magic_prohibition' and attribute_key is null and polarity = 'debuff')
  );

-- Keep virtue-granted assignments in sync with the new per-ability options.
create or replace function public.sync_virtue_ability_assignments(_virtue_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.character_abilities ca
  where ca.granted_by_virtue_id = _virtue_id
    and not exists (
      select 1 from public.virtue_abilities va
      where va.virtue_id = _virtue_id and va.ability_id = ca.ability_id
    );

  insert into public.character_abilities (
    character_id, ability_id, name, description, can_activate, is_passive,
    cooldown_turns, cooldown_remaining, mana_cost, effects, passive_effects,
    self_target_only, end_effects, granted_by_virtue_id
  )
  select
    c.id, a.id, a.name, a.description, a.can_activate, not a.can_activate,
    case when a.can_activate then greatest(a.cooldown_turns, 1) else 0 end,
    0, case when a.can_activate then a.mana_cost else 0 end,
    a.effects, a.passive_effects, a.self_target_only, a.end_effects, _virtue_id
  from public.characters c
  join public.virtue_abilities va on va.virtue_id = c.virtue_id
  join public.abilities a on a.id = va.ability_id
  where c.virtue_id = _virtue_id
  on conflict (character_id, ability_id) do nothing;
end;
$$;
revoke all on function public.sync_virtue_ability_assignments(uuid) from public, anon, authenticated;
grant execute on function public.sync_virtue_ability_assignments(uuid) to service_role;

-- Each activation shares a group id. When its last normal effect expires or is removed,
-- add the configured end effects once. End effects cannot recursively trigger themselves.
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

    if _effect_type is null or _effect_type not in (
      'status','regeneration','mana_regeneration','mana_used',
      'no_regen_hp','no_regen_mana','stun','magic_prohibition'
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
    elsif _effect_type = 'mana_used' then
      _attribute_key := null;
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
      effect_group_id, is_end_effect
    ) values (
      old.battle_id, old.character_id, _ability_name || ': ' || _effect_name,
      _effect_type, _attribute_key, _polarity, _value_mode, _amount, _duration,
      old.duration_scope, old.source_character_ability_id, old.effect_group_id, true
    );
  end loop;

  return old;
end;
$$;

create trigger battle_effects_apply_ability_end_effects
after delete on public.battle_effects
for each row execute function public.apply_character_ability_end_effects();

-- Activation enforces self-only targeting and magic prohibition on the database side.
drop function if exists public.activate_character_ability(uuid, uuid, uuid);
create function public.activate_character_ability(
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

  if (
    (_assignment.mana_cost > 0 or _effective_mana_cost > 0)
    and exists (
      select 1 from public.battle_effects e
      where e.character_id = _assignment.character_id
        and e.effect_type = 'magic_prohibition'
        and e.polarity = 'debuff'
        and e.duration > 0
        and (e.battle_id is null or e.battle_id = _effective_battle_id)
    )
  ) then
    raise exception 'Proibição de magia: não é possível usar habilidades que consomem Mana enquanto o efeito durar';
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

    if _effect_type is null or _effect_type not in (
      'status','regeneration','mana_regeneration','mana_used',
      'no_regen_hp','no_regen_mana','stun','magic_prohibition'
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
    elsif _effect_type = 'mana_used' then
      _attribute_key := null;
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
      effect_group_id, is_end_effect
    ) values (
      _effective_battle_id, _target_character_id, _assignment.name || ': ' || _effect_name,
      _effect_type, _attribute_key, _polarity, _value_mode, _amount,
      _duration, 'global', _assignment.id, _effect_group_id, false
    );
  end loop;

  return _effective_mana_cost;
end;
$$;
revoke all on function public.activate_character_ability(uuid, uuid, uuid) from public, anon;
grant execute on function public.activate_character_ability(uuid, uuid, uuid) to authenticated;
