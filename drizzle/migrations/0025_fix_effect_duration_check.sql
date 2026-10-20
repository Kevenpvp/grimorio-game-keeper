-- Fix early expiry without storing duration = 0, which violates battle_effects_duration_check.
-- Effects that were already at duration 1 expire on this advance; effects that tick
-- from duration 2 to 1 stay active until the following advance.
-- Fix combat effect duration expiry.
-- Durations count down to zero. Effects at 1 remain active until the next turn advance,
-- which changes them to 0; only then are they deleted and their end effects applied.
-- Keep this as a new migration so environments that already applied 0021 get the fix.

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

revoke all on function public.advance_combat_turn(uuid, uuid, jsonb) from public, anon;
grant execute on function public.advance_combat_turn(uuid, uuid, jsonb) to authenticated;
