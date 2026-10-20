ALTER TABLE public.battle_participants
  ADD COLUMN IF NOT EXISTS turn_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.battle_participants
  DROP CONSTRAINT IF EXISTS battle_participants_turn_count_nonnegative;

ALTER TABLE public.battle_participants
  ADD CONSTRAINT battle_participants_turn_count_nonnegative CHECK (turn_count >= 0);
