-- Virtudes use the same point bonus and attribute modifier model as races.
create table public.virtues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  bonus_points integer not null default 0 check (bonus_points >= 0),
  modifiers jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.virtues to authenticated;
grant all on public.virtues to service_role;
alter table public.virtues enable row level security;
create policy "virtues readable" on public.virtues for select to authenticated using (true);
create policy "master manages virtues" on public.virtues for all to authenticated
  using (public.has_role(auth.uid(),'master')) with check (public.has_role(auth.uid(),'master'));

alter table public.characters
  add column virtue_id uuid references public.virtues(id) on delete set null,
  add column virtue_points_granted integer not null default 0;

-- Select the race and virtue together. This also supports players who selected a race
-- before virtues existed: they keep that race and only need to choose a virtue.
create or replace function public.choose_character_traits(
  _character_id uuid,
  _race_id uuid,
  _virtue_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _c public.characters;
  _race_bonus integer := 0;
  _virtue_bonus integer := 0;
  _master boolean := public.has_role(auth.uid(), 'master');
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;

  select * into _c
  from public.characters
  where id = _character_id
  for update;

  if not found then raise exception 'Ficha não encontrada'; end if;

  if not _master then
    if _c.owner_id is distinct from auth.uid() then raise exception 'Sem permissão'; end if;
    if _race_id is null or _virtue_id is null then
      raise exception 'Escolha uma raça e uma virtude antes de confirmar';
    end if;
    if _c.race_id is not null and _c.race_id is distinct from _race_id then
      raise exception 'A raça já foi escolhida; peça ao mestre para trocar';
    end if;
    if _c.virtue_id is not null and _c.virtue_id is distinct from _virtue_id then
      raise exception 'A virtude já foi escolhida; peça ao mestre para trocar';
    end if;
  end if;

  if _race_id is not null then
    select bonus_points into _race_bonus from public.races where id = _race_id;
    if not found then raise exception 'Raça não encontrada'; end if;
  end if;

  if _virtue_id is not null then
    select bonus_points into _virtue_bonus from public.virtues where id = _virtue_id;
    if not found then raise exception 'Virtude não encontrada'; end if;
  end if;

  update public.characters
  set race_id = _race_id,
      virtue_id = _virtue_id,
      available_points = greatest(
        0,
        available_points
          - coalesce(race_points_granted, 0)
          - coalesce(virtue_points_granted, 0)
          + _race_bonus
          + _virtue_bonus
      ),
      race_points_granted = _race_bonus,
      virtue_points_granted = _virtue_bonus
  where id = _character_id;
end;
$$;

revoke all on function public.choose_character_traits(uuid, uuid, uuid) from public, anon;
grant execute on function public.choose_character_traits(uuid, uuid, uuid) to authenticated;
