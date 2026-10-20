CREATE TABLE public.battle_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  battle_id uuid NOT NULL REFERENCES public.battles(id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  name text NOT NULL,
  effect_type text NOT NULL CHECK (effect_type IN ('status','regeneration','no_regen_hp','no_regen_mana','stun')),
  attribute_key text,
  polarity text NOT NULL DEFAULT 'buff' CHECK (polarity IN ('buff','debuff')),
  value_mode text NOT NULL DEFAULT 'fixed' CHECK (value_mode IN ('percent','fixed')),
  amount numeric NOT NULL DEFAULT 0 CHECK (amount >= 0),
  duration integer NOT NULL CHECK (duration > 0),
  duration_scope text NOT NULL DEFAULT 'individual' CHECK (duration_scope IN ('individual','global')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((effect_type = 'status' AND attribute_key IS NOT NULL) OR (effect_type = 'regeneration' AND attribute_key IN ('hp','mana')) OR effect_type IN ('no_regen_hp','no_regen_mana','stun'))
);
CREATE INDEX battle_effects_battle_character_idx ON public.battle_effects (battle_id, character_id);
ALTER TABLE public.battle_effects ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.battle_effects TO authenticated;
GRANT ALL ON public.battle_effects TO service_role;
CREATE POLICY "master all battle effects" ON public.battle_effects FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'master')) WITH CHECK (public.has_role(auth.uid(), 'master'));
CREATE POLICY "players read effects in their battles" ON public.battle_effects FOR SELECT TO authenticated USING (public.shares_battle(character_id));
ALTER PUBLICATION supabase_realtime ADD TABLE public.battle_effects;
