-- Let virtues grant catalog abilities, while tracking which assignments came from a virtue.
alter table public.character_abilities
  add column granted_by_virtue_id uuid references public.virtues(id) on delete cascade;

create index character_abilities_granted_by_virtue_idx
  on public.character_abilities(granted_by_virtue_id)
  where granted_by_virtue_id is not null;

create table public.virtue_abilities (
  virtue_id uuid not null references public.virtues(id) on delete cascade,
  ability_id uuid not null references public.abilities(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (virtue_id, ability_id)
);

create index virtue_abilities_ability_idx on public.virtue_abilities(ability_id);

grant select, insert, update, delete on public.virtue_abilities to authenticated;
grant all on public.virtue_abilities to service_role;
alter table public.virtue_abilities enable row level security;

create policy "virtue abilities readable" on public.virtue_abilities
  for select to authenticated using (true);

create policy "master manages virtue abilities" on public.virtue_abilities
  for all to authenticated
  using (public.has_role(auth.uid(), 'master'))
  with check (public.has_role(auth.uid(), 'master'));

-- Reconcile one virtue's assignments for every character currently holding it.
-- Existing manually assigned abilities are preserved because conflicting rows are not overwritten.
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
      select 1
      from public.virtue_abilities va
      where va.virtue_id = _virtue_id
        and va.ability_id = ca.ability_id
    );

  insert into public.character_abilities (
    character_id,
    ability_id,
    name,
    description,
    can_activate,
    is_passive,
    cooldown_turns,
    cooldown_remaining,
    mana_cost,
    effects,
    passive_effects,
    granted_by_virtue_id
  )
  select
    c.id,
    a.id,
    a.name,
    a.description,
    a.can_activate,
    not a.can_activate,
    case when a.can_activate then greatest(a.cooldown_turns, 1) else 0 end,
    0,
    case when a.can_activate then a.mana_cost else 0 end,
    a.effects,
    a.passive_effects,
    _virtue_id
  from public.characters c
  join public.virtue_abilities va on va.virtue_id = c.virtue_id
  join public.abilities a on a.id = va.ability_id
  where c.virtue_id = _virtue_id
  on conflict (character_id, ability_id) do nothing;
end;
$$;

revoke all on function public.sync_virtue_ability_assignments(uuid) from public, anon, authenticated;
grant execute on function public.sync_virtue_ability_assignments(uuid) to service_role;

-- When a character receives, changes, or loses a virtue, reconcile only virtue-sourced assignments.
create or replace function public.sync_character_virtue_abilities()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    delete from public.character_abilities
    where character_id = new.id
      and granted_by_virtue_id is not null
      and granted_by_virtue_id is distinct from new.virtue_id;
  end if;

  if new.virtue_id is not null then
    perform public.sync_virtue_ability_assignments(new.virtue_id);
  end if;

  return new;
end;
$$;

create trigger characters_sync_virtue_abilities_insert
after insert on public.characters
for each row execute function public.sync_character_virtue_abilities();

create trigger characters_sync_virtue_abilities_update
after update of virtue_id on public.characters
for each row execute function public.sync_character_virtue_abilities();

-- Keep current character loadouts aligned when the master edits a virtue's ability list.
create or replace function public.on_virtue_abilities_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.sync_virtue_ability_assignments(new.virtue_id);
    return new;
  elsif tg_op = 'DELETE' then
    perform public.sync_virtue_ability_assignments(old.virtue_id);
    return old;
  else
    perform public.sync_virtue_ability_assignments(old.virtue_id);
    if new.virtue_id is distinct from old.virtue_id then
      perform public.sync_virtue_ability_assignments(new.virtue_id);
    else
      perform public.sync_virtue_ability_assignments(new.virtue_id);
    end if;
    return new;
  end if;
end;
$$;

create trigger virtue_abilities_sync_assignments
after insert or update or delete on public.virtue_abilities
for each row execute function public.on_virtue_abilities_changed();
