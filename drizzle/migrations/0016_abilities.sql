-- Ability catalog, per-character loadouts, cooldowns, active effects, and passive bonuses.
create table public.abilities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  is_passive boolean not null default false,
  cooldown_turns integer not null default 1 check (cooldown_turns >= 0),
  mana_cost integer not null default 0 check (mana_cost >= 0),
  effects jsonb not null default '[]'::jsonb check (jsonb_typeof(effects) = 'array'),
  created_at timestamptz not null default now(),
  check ((is_passive and cooldown_turns = 0) or (not is_passive and cooldown_turns > 0))
);
grant select, insert, update, delete on public.abilities to authenticated;
grant all on public.abilities to service_role;
alter table public.abilities enable row level security;
create policy "abilities readable" on public.abilities for select to authenticated using (true);
create policy "master manages abilities" on public.abilities for all to authenticated
  using (public.has_role(auth.uid(), 'master'))
  with check (public.has_role(auth.uid(), 'master'));

create table public.character_abilities (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.characters(id) on delete cascade,
  ability_id uuid not null references public.abilities(id) on delete cascade,
  name text not null,
  description text,
  is_passive boolean not null default false,
  cooldown_turns integer not null default 1 check (cooldown_turns >= 0),
  cooldown_remaining integer not null default 0 check (cooldown_remaining >= 0),
  mana_cost integer not null default 0 check (mana_cost >= 0),
  effects jsonb not null default '[]'::jsonb check (jsonb_typeof(effects) = 'array'),
  created_at timestamptz not null default now(),
  unique (character_id, ability_id),
  check (
    (is_passive and cooldown_turns = 0 and cooldown_remaining = 0)
    or (not is_passive and cooldown_turns > 0 and cooldown_remaining <= cooldown_turns)
  )
);
create index character_abilities_character_idx on public.character_abilities(character_id);
grant select, insert, update, delete on public.character_abilities to authenticated;
grant all on public.character_abilities to service_role;
alter table public.character_abilities enable row level security;
create policy "master manages character abilities" on public.character_abilities for all to authenticated
  using (public.has_role(auth.uid(), 'master'))
  with check (public.has_role(auth.uid(), 'master'));
create policy "players read own character abilities" on public.character_abilities for select to authenticated
  using (exists (
    select 1 from public.characters c
    where c.id = character_abilities.character_id and c.owner_id = auth.uid()
  ));

-- Standalone activations from a character sheet may not have a current battle.
alter table public.battle_effects alter column battle_id drop not null;
create policy "players read standalone effects on own character" on public.battle_effects
  for select to authenticated using (
    battle_id is null and exists (
      select 1 from public.characters c
      where c.id = battle_effects.character_id and c.owner_id = auth.uid()
    )
  );
alter table public.battle_effects
  add column source_character_ability_id uuid references public.character_abilities(id) on delete cascade;
create index battle_effects_source_ability_idx on public.battle_effects(source_character_ability_id);

-- A single atomic activation validates ownership, cooldown, mana, and target,
-- then applies the assigned (possibly customized) effect values.
create or replace function public.activate_character_ability(
  _character_ability_id uuid,
  _target_character_id uuid,
  _battle_id uuid default null
)
returns void
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

  if _assignment.is_passive or _assignment.cooldown_turns <= 0 then
    raise exception 'Esta habilidade é passiva e não pode ser ativada';
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
    -- If the sheet is opened during a battle, attach the effect to that battle.
    select b.id into _effective_battle_id
    from public.battles b
    join public.battle_participants bp on bp.battle_id = b.id
    where b.active and bp.character_id = _target_character_id
    order by b.created_at desc
    limit 1;
  end if;

  if _assignment.mana_cost > 0 then
    select current_value into _mana
    from public.character_attributes
    where character_id = _assignment.character_id and attribute_key = 'mana'
    for update;
    if not found then raise exception 'Esta ficha não possui o atributo Mana'; end if;
    if _mana < _assignment.mana_cost then
      raise exception 'Mana insuficiente: precisa de %, possui %', _assignment.mana_cost, _mana;
    end if;
    update public.character_attributes
      set current_value = _mana - _assignment.mana_cost, updated_at = now()
      where character_id = _assignment.character_id and attribute_key = 'mana';
  end if;

  update public.character_abilities
  set cooldown_remaining = cooldown_turns
  where id = _assignment.id;

  if jsonb_typeof(coalesce(_assignment.effects, '[]'::jsonb)) <> 'array' then
    raise exception 'Configuração de efeitos inválida';
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

    if _effect_type is null or _effect_type not in ('status','regeneration','no_regen_hp','no_regen_mana','stun') then
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
      if _attribute_key not in ('hp','mana') then raise exception 'Regeneração só pode afetar HP ou Mana'; end if;
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
end;
$$;
revoke all on function public.activate_character_ability(uuid, uuid, uuid) from public, anon;
grant execute on function public.activate_character_ability(uuid, uuid, uuid) to authenticated;

-- Cooldowns advance only when the combat UI explicitly advances a character/global turn.
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
  where character_id = _character_id and not is_passive and cooldown_remaining > 0;
end;
$$;
revoke all on function public.tick_character_ability_cooldowns(uuid) from public, anon;
grant execute on function public.tick_character_ability_cooldowns(uuid) to authenticated;

alter publication supabase_realtime add table public.abilities;
alter publication supabase_realtime add table public.character_abilities;

