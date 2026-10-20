ALTER TABLE public.characters
  ADD COLUMN IF NOT EXISTS mana_regen_mode text NOT NULL DEFAULT 'percent'
    CHECK (mana_regen_mode IN ('percent', 'fixed')),
  ADD COLUMN IF NOT EXISTS mana_regen_amount numeric NOT NULL DEFAULT 5
    CHECK (mana_regen_amount >= 0);
