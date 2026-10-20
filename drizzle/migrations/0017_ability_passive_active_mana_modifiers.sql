-- Split activation behaviour from permanently applied effects and add Mana modifiers.
alter table public.abilities
  add column can_activate boolean not null default true,
  add column passive_effects jsonb not null default '[]'::jsonb
    check (jsonb_typeof(passive_effects) = 'array');

alter table public.character_abilities
  add column can_activate boolean not null default true,
  add column passive_effects jsonb not null default '[]'::jsonb
    check (jsonb_typeof(passive_effects) = 'array');

-- Keep existing passive-only abilities working: their previous effects become passive effects.
update public.abilities
set can_activate = not is_passive,
    passive_effects = case when is_passive then effects else '[]'::jsonb end,
    effects = case when is_passive then '[]'::jsonb else effects end,
    mana_cost = case when is_passive then 0 else mana_cost end;

update public.character_abilities
set can_activate = not is_passive,
    passive_effects = case when is_passive then effects else '[]'::jsonb end,
    effects = case when is_passive then '[]'::jsonb else effects end,
    mana_cost = case when is_passive then 0 else mana_cost end,
    cooldown_remaining = case when is_passive then 0 else cooldown_remaining end;

alter table public.abilities
  add constraint abilities_can_activate_cooldown_check
  check ((can_activate and cooldown_turns > 0) or (not can_activate and cooldown_turns = 0));

alter table public.character_abilities
  add constraint character_abilities_can_activate_cooldown_check
  check (
    (can_activate and cooldown_turns > 0 and cooldown_remaining <= cooldown_turns)
    or (not can_activate and cooldown_turns = 0 and cooldown_remaining = 0)
  );

-- Keep the legacy is_passive column aligned with can_activate for older application code.
create or replace function public.sync_ability_activation_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.is_passive then
      new.can_activate := false;
    else
      new.is_passive := not new.can_activate;
    end if;
  elsif new.can_activate is distinct from old.can_activate then
    new.is_passive := not new.can_activate;
  elsif new.is_passive is distinct from old.is_passive then
    new.can_activate := not new.is_passive;
  end if;

  if not new.can_activate then
    new.is_passive := true;
    new.cooldown_turns := 0;
    new.mana_cost := 0;
    if tg_table_name = 'character_abilities' then
      new.cooldown_remaining := 0;
    end if;
  else
    new.is_passive := false;
    if new.cooldown_turns < 1 then new.cooldown_turns := 1; end if;
  end if;
  return new;
end;
$$;

create trigger abilities_sync_activation_fields
before insert or update on public.abilities
for each row execute function public.sync_ability_activation_fields();

create trigger character_abilities_sync_activation_fields
before insert or update on public.character_abilities
for each row execute function public.sync_ability_activation_fields();

-- Active mana-cost modifiers are temporary battle effects, so allow that type in battle_effects.
alter table public.battle_effects drop constraint if exists battle_effects_effect_type_check;
alter table public.battle_effects
  add constraint battle_effects_effect_type_check
  check (effect_type in ('status','regeneration','no_regen_hp','no_regen_mana','stun','mana_used'));

alter table public.battle_effects drop constraint if exists battle_effects_check;
alter table public.battle_effects
  add constraint battle_effects_check check (
    (effect_type = 'status' and attribute_key is not null)
    or (effect_type = 'regeneration' and attribute_key in ('hp','mana'))
    or effect_type in ('no_regen_hp','no_regen_mana','stun','mana_used')
  );

-- Mana cost and activation are validated atomically in the database.
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
  _fixed_delta numeric;
  _percent_delta numeric;
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

    if _effect_type is null or _effect_type not in ('status','regeneration','mana_regeneration','mana_used','no_regen_hp','no_regen_mana','stun') then
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
    else
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
    end if;

    insert into public.battle_effects (
      battle_id, character_id, name, effect_type, attribute_key, polarity,
      value_mode, amount, duration, duration_scope, source_character_ability_id
    ) values (
      _effective_battle_id, _target_character_id, _assignment.name || ': ' || _effect_name,
      _effect_type, _attribute_key, _polarity, _value_mode, _amount,
      _duration, 'global', _assignment.id
    );
  end loop;

  return _effective_mana_cost;
end;
$$;
revoke all on function public.activate_character_ability(uuid, uuid, uuid) from public, anon;
grant execute on function public.activate_character_ability(uuid, uuid, uuid) to authenticated;

create or replace function public.tick_character_ability_cooldowns(_character_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.has_role(auth.uid(), 'master') then
    raise exception 'Apenas o mestre pode avançar cooldowns';
  end if;
  update public.character_abilities
  set cooldown_remaining = greatest(0, cooldown_remaining - 1)
  where character_id = _character_id and can_activate and cooldown_remaining > 0;
end;
$$;
revoke all on function public.tick_character_ability_cooldowns(uuid) from public, anon;
grant execute on function public.tick_character_ability_cooldowns(uuid) to authenticated;

