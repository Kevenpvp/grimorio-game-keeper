-- Summons update the combat roster and the character sheet in realtime.
-- RLS on both tables still governs what authenticated users can see.
ALTER PUBLICATION supabase_realtime
  ADD TABLE public.summon_grants, public.active_summons;
