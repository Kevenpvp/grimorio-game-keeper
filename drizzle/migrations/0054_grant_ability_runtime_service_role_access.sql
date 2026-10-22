-- The ability-runtime Edge Function uses the server-side service_role client
-- to inspect character abilities, calculate custom damage hooks, and manage
-- the queued script events. Keep these grants server-side only.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.abilities,
  public.ability_script_events,
  public.battle_effects,
  public.battles,
  public.character_abilities,
  public.character_attributes,
  public.characters
TO service_role;
