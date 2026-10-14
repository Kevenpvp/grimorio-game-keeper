create table public.races (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  bonus_points integer not null default 0 check (bonus_points >= 0),
  modifiers jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.races to authenticated;
grant all on public.races to service_role;
alter table public.races enable row level security;
create policy "races readable" on public.races for select to authenticated using (true);
create policy "master manages races" on public.races for all to authenticated
  using (public.has_role(auth.uid(),'master')) with check (public.has_role(auth.uid(),'master'));

alter table public.characters add column race_id uuid references public.races(id) on delete set null;
alter table public.characters add column race_points_granted integer not null default 0;

create or replace function public.choose_race(_character_id uuid, _race_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare _c public.characters; _bonus int; _master bool := public.has_role(auth.uid(),'master');
begin
  select * into _c from public.characters where id = _character_id for update;
  if not found then raise exception 'Ficha não encontrada'; end if;
  if not _master then
    if _c.owner_id is distinct from auth.uid() then raise exception 'Sem permissão'; end if;
    if _c.race_id is not null then raise exception 'A raça já foi escolhida; peça ao mestre para trocar'; end if;
    if _race_id is null then raise exception 'Escolha uma raça'; end if;
  end if;
  if _race_id is not null then
    select bonus_points into _bonus from public.races where id = _race_id;
    if not found then raise exception 'Raça não encontrada'; end if;
  else _bonus := 0; end if;
  update public.characters set race_id = _race_id,
    available_points = greatest(0, available_points - race_points_granted + _bonus),
    race_points_granted = _bonus
  where id = _character_id;
end $$;
revoke all on function public.choose_race(uuid, uuid) from public, anon;
grant execute on function public.choose_race(uuid, uuid) to authenticated;