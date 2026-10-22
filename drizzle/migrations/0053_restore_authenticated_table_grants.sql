-- RLS decides which rows each signed-in user can access. These PostgreSQL
-- privileges allow the browser client to reach the RLS-protected tables.
-- `master_emails` is deliberately excluded: master status is resolved only by
-- the security-definer `sync_my_role` function.
grant select, insert, update, delete on table
  public.abilities,
  public.ability_script_events,
  public.attribute_definitions,
  public.battle_effects,
  public.battle_participants,
  public.battles,
  public.character_abilities,
  public.character_attributes,
  public.characters,
  public.damage_types,
  public.race_abilities,
  public.races,
  public.virtue_abilities,
  public.virtues
to authenticated;

grant select, insert, update on table public.profiles to authenticated;
grant select on table public.user_roles to authenticated;
