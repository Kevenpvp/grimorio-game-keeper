BEGIN;

ALTER TABLE public.character_abilities DROP CONSTRAINT IF EXISTS character_abilities_can_activate_cooldown_check;
ALTER TABLE public.character_abilities ADD CONSTRAINT character_abilities_can_activate_cooldown_check
  CHECK ((can_activate AND cooldown_turns >= 0 AND cooldown_remaining <= cooldown_turns) OR (NOT can_activate AND cooldown_turns = 0 AND cooldown_remaining = 0));

ALTER TABLE public.character_abilities DROP CONSTRAINT IF EXISTS character_abilities_check;
ALTER TABLE public.character_abilities ADD CONSTRAINT character_abilities_check
  CHECK ((is_passive AND cooldown_turns = 0 AND cooldown_remaining = 0) OR (NOT is_passive AND cooldown_turns >= 0 AND cooldown_remaining <= cooldown_turns));

NOTIFY pgrst, 'reload schema';
COMMIT;
