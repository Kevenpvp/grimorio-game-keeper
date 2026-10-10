-- Master accounts are configured by email (server-side only)
create table public.master_emails (
  email text primary key
);
grant all on public.master_emails to service_role;
alter table public.master_emails enable row level security;
insert into public.master_emails (email) values ('kevenrzanluchi@gmail.com') on conflict do nothing;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)), new.email)
  on conflict (id) do nothing;
  insert into public.user_roles (user_id, role) values (new.id, 'player') on conflict do nothing;
  return new;
end; $$;

-- Called after login: grants master only if the authenticated user's own email is configured
create or replace function public.sync_my_role()
returns public.app_role language plpgsql security definer set search_path = public as $$
declare _email text;
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  select lower(email) into _email from auth.users where id = auth.uid() and email_confirmed_at is not null;
  if _email is not null and exists (select 1 from public.master_emails where lower(email) = _email) then
    insert into public.user_roles (user_id, role) values (auth.uid(), 'master') on conflict do nothing;
    return 'master';
  end if;
  insert into public.user_roles (user_id, role) values (auth.uid(), 'player') on conflict do nothing;
  return 'player';
end; $$;
revoke all on function public.sync_my_role() from public, anon;
grant execute on function public.sync_my_role() to authenticated;

-- Points-based attributes
alter table public.attribute_definitions
  add column accepts_points boolean not null default true,
  add column base_value numeric not null default 0,
  add column points_multiplier numeric not null default 1;
update public.attribute_definitions set accepts_points = false where key = 'hp';

alter table public.character_attributes add column points integer not null default 0 check (points >= 0);
-- preserve old data: previous "max" becomes invested points for point-based attributes
update public.character_attributes ca set points = ca.max_value
  from public.attribute_definitions d
  where d.key = ca.attribute_key and d.accepts_points and ca.max_value > 0;

alter table public.characters
  add column available_points integer not null default 0 check (available_points >= 0),
  add column kills integer not null default 0 check (kills >= 0);

-- Atomic, locked point distribution. Players may only add points from their balance;
-- the master may add or remove (refunds go back to the balance).
create or replace function public.invest_points(_character_id uuid, _allocations jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  _is_master boolean := public.has_role(auth.uid(), 'master');
  _owner uuid; _available int; _total int := 0;
  _k text; _delta int; _cur int;
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  select owner_id, available_points into _owner, _available
    from public.characters where id = _character_id for update;
  if not found then raise exception 'Ficha não encontrada'; end if;
  if not _is_master and _owner is distinct from auth.uid() then raise exception 'Sem permissão'; end if;

  for _k, _delta in select key, value::int from jsonb_each_text(_allocations) loop
    if _delta = 0 then continue; end if;
    if not exists (select 1 from public.attribute_definitions where key = _k and accepts_points) then
      raise exception 'O atributo % não aceita pontos', _k;
    end if;
    if _delta < 0 and not _is_master then raise exception 'Apenas o mestre pode retirar pontos'; end if;
    select points into _cur from public.character_attributes
      where character_id = _character_id and attribute_key = _k for update;
    if coalesce(_cur,0) + _delta < 0 then raise exception 'Pontos investidos não podem ficar negativos'; end if;
    insert into public.character_attributes (character_id, attribute_key, points)
      values (_character_id, _k, _delta)
      on conflict (character_id, attribute_key) do update set points = public.character_attributes.points + _delta;
    _total := _total + _delta;
  end loop;

  if _total > _available then raise exception 'Pontos insuficientes (disponível: %)', _available; end if;
  update public.characters set available_points = available_points - _total where id = _character_id;
end; $$;
revoke all on function public.invest_points(uuid, jsonb) from public, anon;
grant execute on function public.invest_points(uuid, jsonb) to authenticated;

create or replace function public.validate_attribute()
returns trigger language plpgsql set search_path = public as $$
declare capped boolean;
begin
  if new.current_value < 0 then raise exception 'O valor atual não pode ser negativo'; end if;
  if new.max_value < 0 then raise exception 'O valor máximo não pode ser negativo'; end if;
  if new.points < 0 then raise exception 'Pontos não podem ser negativos'; end if;
  select cap_current into capped from public.attribute_definitions where key = new.attribute_key;
  if capped and new.current_value > new.max_value then
    raise exception 'O valor atual não pode ultrapassar o máximo';
  end if;
  new.updated_at = now();
  return new;
end; $$;
