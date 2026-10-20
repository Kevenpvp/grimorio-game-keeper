-- Make turn advancement serializable, update resource currents proportionally when HP/Mana maxima change.
-- The UI sends the configured base Mana regeneration; all effect modifiers, cooldowns,
-- counters, and durations are read/updated atomically in this function.

create or replace function public.calculate_character_resource_max(
  _character_id uuid,
  _attribute_key text,
  _exclude_battle_effect_id uuid default null,
  _exclude_character_ability_id uuid default null,
  _extra_active_effects jsonb default '[]'::jsonb,
  _extra_passive_effects jsonb default '[]'::jsonb
)
returns numeric
language plpgsql
security definer
set search_path = public
as $
declare
  _accepts_points boolean;
  _base_value numeric;
  _points_multiplier numeric;
  _points numeric;
  _stored_max numeric;
  _bonus numeric;
  _trait_modifier numeric;
  _base_max numeric;
  _fixed_modifier numeric := 0;
  _percent_modifier numeric := 0;
begin
  if _attribute_key not in ('hp', 'mana') then
    raise exception 'Este cálculo só aceita HP ou Mana';
  end if;

  select
    d.accepts_points,
    d.base_value,
    d.points_multiplier,
    ca.points,
    ca.max_value,
    ca.bonus,
    coalesce(nullif(r.modifiers ->> _attribute_key, '')::numeric, 0)
      + coalesce(nullif(v.modifiers ->> _attribute_key, '')::numeric, 0)
  into
    _accepts_points, _base_value, _points_multiplier, _points,
    _stored_max, _bonus, _trait_modifier
  from public.characters c
  join public.character_attributes ca
    on ca.character_id = c.id and ca.attribute_key = _attribute_key
  join public.attribute_definitions d on d.key = ca.attribute_key
  left join public.races r on r.id = c.race_id
  left join public.virtues v on v.id = c.virtue_id
  where c.id = _character_id;

  if not found then return 0; end if;

  if _accepts_points then
    _base_max := round((_base_value + (coalesce(_points, 0) + _trait_modifier) * _points_multiplier) * 100) / 100
      + coalesce(_bonus, 0);
  else
    _base_max := coalesce(_stored_max, 0) + _trait_modifier + coalesce(_bonus, 0);
  end if;

  select
    coalesce(sum(case when modifiers.polarity = 'buff' then modifiers.amount else -modifiers.amount end)
      filter (where modifiers.value_mode = 'fixed'), 0),
    coalesce(sum(case when modifiers.polarity = 'buff' then modifiers.amount else -modifiers.amount end)
      filter (where modifiers.value_mode = 'percent'), 0)
  into _fixed_modifier, _percent_modifier
  from (
    select e.polarity, e.value_mode, e.amount
    from public.battle_effects e
    where e.character_id = _character_id
      and e.id is distinct from _exclude_battle_effect_id
      and e.effect_type = 'status'
      and e.attribute_key = _attribute_key
      and e.duration > 0
      and (
        e.battle_id is null
        or exists (select 1 from public.battles b where b.id = e.battle_id and b.active)
      )

    union all

    select
      coalesce(passive.effect ->> 'polarity', 'buff'),
      coalesce(passive.effect ->> 'value_mode', 'fixed'),
      coalesce(nullif(passive.effect ->> 'amount', '')::numeric, 0)
    from public.character_abilities ca
    cross join lateral jsonb_array_elements(coalesce(ca.passive_effects, '[]'::jsonb)) as passive(effect)
    where ca.character_id = _character_id
      and ca.id is distinct from _exclude_character_ability_id
      and passive.effect ->> 'effect_type' = 'status'
      and passive.effect ->> 'attribute_key' = _attribute_key

    union all

    select
      coalesce(extra.effect ->> 'polarity', 'buff'),
      coalesce(extra.effect ->> 'value_mode', 'fixed'),
      coalesce(nullif(extra.effect ->> 'amount', '')::numeric, 0)
    from jsonb_array_elements(coalesce(_extra_active_effects, '[]'::jsonb)) as extra(effect)
    where extra.effect ->> 'effect_type' = 'status'
      and extra.effect ->> 'attribute_key' = _attribute_key

    union all

    select
      coalesce(extra.effect ->> 'polarity', 'buff'),
      coalesce(extra.effect ->> 'value_mode', 'fixed'),
      coalesce(nullif(extra.effect ->> 'amount', '')::numeric, 0)
    from jsonb_array_elements(coalesce(_extra_passive_effects, '[]'::jsonb)) as extra(effect)
    where extra.effect ->> 'effect_type' = 'status'
      and extra.effect ->> 'attribute_key' = _attribute_key
  ) as modifiers;

  return greatest(
    case when _attribute_key = 'hp' then 1 else 0 end,
    floor((_base_max + _fixed_modifier) * (1 + _percent_modifier / 100))
  );
end;
$$;

revoke all on function public.calculate_character_resource_max(uuid, text, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.calculate_character_resource_max(uuid, text, uuid, uuid, jsonb, jsonb) to service_role;

create or replace function public.scale_character_resource_current(
  _character_id uuid,
  _attribute_key text,
  _old_max numeric,
  _new_max numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if _old_max is not distinct from _new_max then return; end if;

  update public.character_attributes ca
  set current_value = least(
    greatest(0, _new_max),
    greatest(
      0,
      case
        when _old_max > 0 then round(coalesce(ca.current_value, 0) * greatest(0, _new_max) / _old_max)
        else coalesce(ca.current_value, 0)
      end
    )
  ),
  updated_at = now()
  where ca.character_id = _character_id
    and ca.attribute_key = _attribute_key;
end;
$$;

revoke all on function public.scale_character_resource_current(uuid, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.scale_character_resource_current(uuid, text, numeric, numeric) to service_role;

create or replace function public.scale_resource_on_battle_effect_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _character_id uuid;
  _attribute_key text;
  _old_max numeric;
  _new_max numeric;
  _extra jsonb := '[]'::jsonb;
begin
  if tg_op = 'INSERT' then
    if new.effect_type <> 'status' or new.attribute_key not in ('hp', 'mana') then return new; end if;
    if new.battle_id is not null and not exists (
      select 1 from public.battles b where b.id = new.battle_id and b.active
    ) then return new; end if;

    _character_id := new.character_id;
    _attribute_key := new.attribute_key;
    _old_max := public.calculate_character_resource_max(_character_id, _attribute_key);
    _extra := jsonb_build_array(jsonb_build_object(
      'effect_type', new.effect_type,
      'attribute_key', new.attribute_key,
      'polarity', new.polarity,
      'value_mode', new.value_mode,
      'amount', new.amount
    ));
    _new_max := public.calculate_character_resource_max(
      _character_id, _attribute_key, null, null, _extra, '[]'::jsonb
    );
    perform public.scale_character_resource_current(_character_id, _attribute_key, _old_max, _new_max);
    return new;
  elsif tg_op = 'DELETE' then
    if old.effect_type <> 'status' or old.attribute_key not in ('hp', 'mana') then return old; end if;
    if old.battle_id is not null and not exists (
      select 1 from public.battles b where b.id = old.battle_id and b.active
    ) then return old; end if;

    _character_id := old.character_id;
    _attribute_key := old.attribute_key;
    _old_max := public.calculate_character_resource_max(_character_id, _attribute_key);
    _new_max := public.calculate_character_resource_max(
      _character_id, _attribute_key, old.id
    );
    perform public.scale_character_resource_current(_character_id, _attribute_key, _old_max, _new_max);
    return old;
  elsif tg_op = 'UPDATE' then
    if old.effect_type = 'status' and old.attribute_key in ('hp', 'mana') then
      _character_id := old.character_id;
      _attribute_key := old.attribute_key;
      _old_max := public.calculate_character_resource_max(_character_id, _attribute_key);
      _extra := jsonb_build_array(jsonb_build_object(
        'effect_type', new.effect_type,
        'attribute_key', new.attribute_key,
        'polarity', new.polarity,
        'value_mode', new.value_mode,
        'amount', new.amount
      ));
      _new_max := public.calculate_character_resource_max(
        new.character_id, new.attribute_key, old.id, null, _extra, '[]'::jsonb
      );
      perform public.scale_character_resource_current(_character_id, _attribute_key, _old_max, _new_max);
    elsif new.effect_type = 'status' and new.attribute_key in ('hp', 'mana') then
      _character_id := new.character_id;
      _attribute_key := new.attribute_key;
      _old_max := public.calculate_character_resource_max(_character_id, _attribute_key, old.id);
      _extra := jsonb_build_array(jsonb_build_object(
        'effect_type', new.effect_type,
        'attribute_key', new.attribute_key,
        'polarity', new.polarity,
        'value_mode', new.value_mode,
        'amount', new.amount
      ));
      _new_max := public.calculate_character_resource_max(
        _character_id, _attribute_key, old.id, null, _extra, '[]'::jsonb
      );
      perform public.scale_character_resource_current(_character_id, _attribute_key, _old_max, _new_max);
    end if;
    return new;
  end if;

  return null;
end;
$$;

revoke all on function public.scale_resource_on_battle_effect_change() from public, anon, authenticated;
grant execute on function public.scale_resource_on_battle_effect_change() to service_role;

create trigger battle_effects_scale_resource_insert
before insert on public.battle_effects
for each row execute function public.scale_resource_on_battle_effect_change();

create trigger battle_effects_scale_resource_delete
before delete on public.battle_effects
for each row execute function public.scale_resource_on_battle_effect_change();

create trigger battle_effects_scale_resource_update
before update of effect_type, attribute_key, polarity, value_mode, amount on public.battle_effects
for each row execute function public.scale_resource_on_battle_effect_change();

create or replace function public.scale_resource_on_passive_ability_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _character_id uuid;
  _attribute_key text;
  _old_max numeric;
  _new_max numeric;
begin
  if tg_op = 'INSERT' then
    for _attribute_key in select unnest(array['hp','mana'])
    loop
      _old_max := public.calculate_character_resource_max(new.character_id, _attribute_key);
      _new_max := public.calculate_character_resource_max(
        new.character_id, _attribute_key, null, new.id, '[]'::jsonb, coalesce(new.passive_effects, '[]'::jsonb)
      );
      perform public.scale_character_resource_current(new.character_id, _attribute_key, _old_max, _new_max);
    end loop;
    return new;
  elsif tg_op = 'DELETE' then
    for _attribute_key in select unnest(array['hp','mana'])
    loop
      _old_max := public.calculate_character_resource_max(old.character_id, _attribute_key);
      _new_max := public.calculate_character_resource_max(old.character_id, _attribute_key, null, old.id);
      perform public.scale_character_resource_current(old.character_id, _attribute_key, _old_max, _new_max);
    end loop;
    return old;
  elsif tg_op = 'UPDATE' then
    for _attribute_key in select unnest(array['hp','mana'])
    loop
      _old_max := public.calculate_character_resource_max(old.character_id, _attribute_key);
      _new_max := public.calculate_character_resource_max(
        new.character_id, _attribute_key, null, old.id, '[]'::jsonb, coalesce(new.passive_effects, '[]'::jsonb)
      );
      perform public.scale_character_resource_current(new.character_id, _attribute_key, _old_max, _new_max);
    end loop;
    return new;
  end if;
  return null;
end;
$$;

revoke all on function public.scale_resource_on_passive_ability_change() from public, anon, authenticated;
grant execute on function public.scale_resource_on_passive_ability_change() to service_role;

create trigger character_abilities_scale_resource_insert
before insert on public.character_abilities
for each row execute function public.scale_resource_on_passive_ability_change();

create trigger character_abilities_scale_resource_delete
before delete on public.character_abilities
for each row execute function public.scale_resource_on_passive_ability_change();

create trigger character_abilities_scale_resource_update
before update of passive_effects on public.character_abilities
for each row execute function public.scale_resource_on_passive_ability_change();

-- One transaction per turn advance. Locking the battle row serializes concurrent advances so
-- counters, cooldowns, regeneration, end effects, and each duration decrement cannot overwrite
-- one another with stale client-side snapshots.
create or replace function public.advance_combat_turn(
  _battle_id uuid,
  _character_id uuid default null,
  _base_mana_regeneration jsonb default '{}'::jsonb
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
  _expired record;
begin
  if auth.uid() is null or not public.has_role(auth.uid(), 'master') then
    raise exception 'Apenas o mestre pode avançar turnos';
  end if;
  if jsonb_typeof(coalesce(_base_mana_regeneration, '{}'::jsonb)) <> 'object' then
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
  for _fighter in select key, value from jsonb_each(coalesce(_base_mana_regeneration, '{}'::jsonb))
  loop
    _fighter_id := _fighter.key::uuid;
    _base_regen := nullif(_fighter.value #>> '{}', '')::numeric;
    if _base_regen is null or _base_regen < 0 then
      raise exception 'Regeneração base inválida para %', _fighter_id;
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
      _mana_max := public.calculate_character_resource_max(_fighter_id, 'mana');
      update public.character_attributes
      set current_value = least(_mana_max, greatest(0, coalesce(current_value, 0) + _adjusted_regen)),
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

  -- Decrement surviving effects atomically; delete expiring rows one at a time so each activation
  -- group can produce its end effects exactly once.
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

  for _expired in
    select e.id
    from public.battle_effects e
    where e.duration <= 1
      and (
        e.battle_id = _battle_id
        or (e.battle_id is null and exists (
          select 1 from public.battle_participants bp
          where bp.battle_id = _battle_id and bp.character_id = e.character_id
        ))
      )
    order by e.created_at, e.id
    for update
  loop
    delete from public.battle_effects e where e.id = _expired.id;
  end loop;

  return _result_turn;
end;
$$;

revoke all on function public.advance_combat_turn(uuid, uuid, jsonb) from public, anon;
grant execute on function public.advance_combat_turn(uuid, uuid, jsonb) to authenticated;
