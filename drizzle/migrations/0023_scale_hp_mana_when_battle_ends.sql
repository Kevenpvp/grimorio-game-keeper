-- When a battle is ended, its temporary effects stop contributing to HP/Mana maxima.
-- Preserve the old maxima by passing that battle's status effects as extra modifiers, then
-- scale current HP/Mana to the newly effective maxima. This runs AFTER active=false so the
-- current-value validator sees the new maxima, including when an ending debuff raises the max.

create or replace function public.scale_resources_after_battle_end()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _participant record;
  _attribute_key text;
  _old_max numeric;
  _new_max numeric;
  _battle_status_effects jsonb;
begin
  if not old.active or new.active then
    return new;
  end if;

  for _participant in
    select bp.character_id
    from public.battle_participants bp
    where bp.battle_id = old.id
    order by bp.character_id
  loop
    for _attribute_key in select unnest(array['hp', 'mana'])
    loop
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'effect_type', e.effect_type,
          'attribute_key', e.attribute_key,
          'polarity', e.polarity,
          'value_mode', e.value_mode,
          'amount', e.amount
        )),
        '[]'::jsonb
      )
      into _battle_status_effects
      from public.battle_effects e
      where e.battle_id = old.id
        and e.character_id = _participant.character_id
        and e.effect_type = 'status'
        and e.attribute_key = _attribute_key
        and e.duration > 0;

      -- The battle is already inactive here, so the helper's normal maximum excludes
      -- its effects. Re-add them only for the pre-combat maximum.
      _new_max := public.calculate_character_resource_max(
        _participant.character_id,
        _attribute_key
      );
      _old_max := public.calculate_character_resource_max(
        _participant.character_id,
        _attribute_key,
        null,
        null,
        coalesce(_battle_status_effects, '[]'::jsonb),
        '[]'::jsonb
      );

      perform public.scale_character_resource_current(
        _participant.character_id,
        _attribute_key,
        _old_max,
        _new_max
      );
    end loop;
  end loop;

  return new;
end;
$$;

revoke all on function public.scale_resources_after_battle_end() from public, anon, authenticated;
grant execute on function public.scale_resources_after_battle_end() to service_role;

create trigger battles_scale_resources_after_end
after update of active on public.battles
for each row
when (old.active is true and new.active is false)
execute function public.scale_resources_after_battle_end();

-- Repair characters already left with an over-cap current value by earlier ended combats.
-- The effective maximum excludes every inactive battle, so this clamps stale values such as 60/50.
update public.character_attributes ca
set current_value = public.calculate_character_resource_max(ca.character_id, ca.attribute_key)::integer,
    updated_at = now()
where ca.attribute_key in ('hp', 'mana')
  and ca.current_value > public.calculate_character_resource_max(ca.character_id, ca.attribute_key);
