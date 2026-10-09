create type public.app_role as enum ('master','player');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  email text,
  created_at timestamptz not null default now()
);
grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role public.app_role not null,
  unique (user_id, role)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create policy "own roles readable" on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(),'master'));

create policy "profiles read own or master" on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_role(auth.uid(),'master'));
create policy "profiles update own" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)), new.email);
  if not exists (select 1 from public.user_roles where role = 'master') then
    insert into public.user_roles (user_id, role) values (new.id, 'master');
  else
    insert into public.user_roles (user_id, role) values (new.id, 'player');
  end if;
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end; $$;

create table public.characters (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  player_name text not null default '',
  description text,
  photo_path text,
  owner_id uuid references public.profiles(id) on delete set null,
  body smallint not null default 100 check (body between 0 and 100),
  sanity smallint not null default 100 check (sanity between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.characters to authenticated;
grant all on public.characters to service_role;
alter table public.characters enable row level security;
create policy "master all characters" on public.characters for all to authenticated
  using (public.has_role(auth.uid(),'master')) with check (public.has_role(auth.uid(),'master'));
create policy "player reads own character" on public.characters for select to authenticated
  using (owner_id = auth.uid());
create trigger characters_touch before update on public.characters
  for each row execute function public.touch_updated_at();

create table public.attribute_definitions (
  key text primary key,
  label text not null,
  icon text not null default 'circle',
  sort_order int not null default 0,
  cap_current boolean not null default true,
  show_bar boolean not null default false
);
grant select on public.attribute_definitions to authenticated;
grant all on public.attribute_definitions to service_role;
alter table public.attribute_definitions enable row level security;
create policy "defs readable" on public.attribute_definitions for select to authenticated using (true);

insert into public.attribute_definitions (key,label,icon,sort_order,cap_current,show_bar) values
 ('hp','HP (Vida)','heart',1,true,true),
 ('mana','Mana','droplet',2,true,true),
 ('strength','Força','dumbbell',3,true,false),
 ('speed','Velocidade','wind',4,true,false),
 ('phys_def','Defesa física','shield',5,true,false),
 ('atk_speed','Velocidade de ataque','zap',6,true,false),
 ('mag_def','Defesa mágica','shield-half',7,true,false),
 ('mag_dmg','Dano mágico','flame',8,true,false),
 ('iq','QI','brain',9,true,false),
 ('mental','Força mental','sparkles',10,true,false);

create table public.character_attributes (
  character_id uuid not null references public.characters(id) on delete cascade,
  attribute_key text not null references public.attribute_definitions(key) on delete cascade,
  current_value int not null default 0,
  max_value int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (character_id, attribute_key)
);
grant select, insert, update, delete on public.character_attributes to authenticated;
grant all on public.character_attributes to service_role;
alter table public.character_attributes enable row level security;
create policy "master all attrs" on public.character_attributes for all to authenticated
  using (public.has_role(auth.uid(),'master')) with check (public.has_role(auth.uid(),'master'));
create policy "player reads own attrs" on public.character_attributes for select to authenticated
  using (exists (select 1 from public.characters c where c.id = character_id and c.owner_id = auth.uid()));

create or replace function public.validate_attribute()
returns trigger language plpgsql set search_path = public as $$
declare capped boolean;
begin
  if new.current_value < 0 then raise exception 'O valor atual não pode ser negativo'; end if;
  if new.max_value < 0 then raise exception 'O valor máximo não pode ser negativo'; end if;
  select cap_current into capped from public.attribute_definitions where key = new.attribute_key;
  if capped and new.current_value > new.max_value then
    raise exception 'O valor atual não pode ultrapassar o máximo';
  end if;
  new.updated_at = now();
  return new;
end; $$;
create trigger character_attributes_validate before insert or update on public.character_attributes
  for each row execute function public.validate_attribute();

alter publication supabase_realtime add table public.characters;
alter publication supabase_realtime add table public.character_attributes;

create policy "master manage photos" on storage.objects for all to authenticated
  using (bucket_id = 'character-photos' and public.has_role(auth.uid(),'master'))
  with check (bucket_id = 'character-photos' and public.has_role(auth.uid(),'master'));
create policy "player reads own photo" on storage.objects for select to authenticated
  using (bucket_id = 'character-photos' and exists (
    select 1 from public.characters c
    where c.owner_id = auth.uid() and c.id::text = (storage.foldername(name))[1]));
