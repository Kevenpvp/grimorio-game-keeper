-- Align columns introduced on the live project after the numbered baseline migrations.
ALTER TABLE public.characters
  ADD COLUMN IF NOT EXISTS class_custom_modifiers jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.characters
  DROP CONSTRAINT IF EXISTS characters_class_custom_modifiers_object_check;
ALTER TABLE public.characters
  ADD CONSTRAINT characters_class_custom_modifiers_object_check
  CHECK (jsonb_typeof(class_custom_modifiers) = 'object');

ALTER TABLE public.transformations
  ADD COLUMN IF NOT EXISTS duration_turns integer NOT NULL DEFAULT 3;
ALTER TABLE public.transformations
  DROP CONSTRAINT IF EXISTS transformations_duration_turns_check;
ALTER TABLE public.transformations
  ADD CONSTRAINT transformations_duration_turns_check
  CHECK (duration_turns >= 1 AND duration_turns <= 1000);

ALTER TABLE public.character_transformations
  ADD COLUMN IF NOT EXISTS active_duration_remaining integer NOT NULL DEFAULT 0;
ALTER TABLE public.character_transformations
  DROP CONSTRAINT IF EXISTS character_transformations_active_duration_remaining_check;
ALTER TABLE public.character_transformations
  ADD CONSTRAINT character_transformations_active_duration_remaining_check
  CHECK (active_duration_remaining >= 0 AND active_duration_remaining <= 1000);
