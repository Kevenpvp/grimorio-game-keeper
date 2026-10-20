ALTER TABLE public.battles
  ADD COLUMN IF NOT EXISTS turn_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.battles
  DROP CONSTRAINT IF EXISTS battles_turn_count_nonnegative;

ALTER TABLE public.battles
  ADD CONSTRAINT battles_turn_count_nonnegative CHECK (turn_count >= 0);
