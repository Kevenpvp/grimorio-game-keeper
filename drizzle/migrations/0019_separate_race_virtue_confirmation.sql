-- Allow the master/player flow to confirm race and virtue independently.
-- Each function replaces only its own point grant, preserving the other trait's grant.

create or replace function public.choose_character_race(
  _character_id uuid,
  _race_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _c public.characters;
  _race_bonus integer := 0;
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
    if _race_id is null then raise exception 'Escolha uma raça'; end if;
    if _c.race_id is not null and _c.race_id is distinct from _race_id then
      raise exception 'A raça já foi escolhida; peça ao mestre para trocar';
    end if;
  end if;

  if _race_id is not null then
    select bonus_points into _race_bonus
    from public.races
    where id = _race_id;
    if not found then raise exception 'Raça não encontrada'; end if;
  end if;

  update public.characters
  set race_id = _race_id,
      available_points = greatest(
        0,
        available_points - coalesce(race_points_granted, 0) + _race_bonus
      ),
      race_points_granted = _race_bonus
  where id = _character_id;
end;
$$;

create or replace function public.choose_character_virtue(
  _character_id uuid,
  _virtue_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _c public.characters;
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
    if _c.race_id is null then raise exception 'Confirme sua raça antes de escolher a virtude'; end if;
    if _virtue_id is null then raise exception 'Escolha uma virtude'; end if;
    if _c.virtue_id is not null and _c.virtue_id is distinct from _virtue_id then
      raise exception 'A virtude já foi escolhida; peça ao mestre para trocar';
    end if;
  end if;

  if _virtue_id is not null then
    select bonus_points into _virtue_bonus
    from public.virtues
    where id = _virtue_id;
    if not found then raise exception 'Virtude não encontrada'; end if;
  end if;

  update public.characters
  set virtue_id = _virtue_id,
      available_points = greatest(
        0,
        available_points - coalesce(virtue_points_granted, 0) + _virtue_bonus
      ),
      virtue_points_granted = _virtue_bonus
  where id = _character_id;
end;
$$;

revoke all on function public.choose_character_race(uuid, uuid) from public, anon;
grant execute on function public.choose_character_race(uuid, uuid) to authenticated;
revoke all on function public.choose_character_virtue(uuid, uuid) from public, anon;
grant execute on function public.choose_character_virtue(uuid, uuid) to authenticated;
