-- Adds configurable attack mode to catalog abilities and secure multi-target activation.
ALTER TABLE public.abilities
  ADD COLUMN IF NOT EXISTS attack_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS attack_damage jsonb NOT NULL DEFAULT '{"damage_kind":"physical","attribute_key":"strength","attribute_percent":100,"fixed_damage":0,"physical_damage_type_id":null,"damage_type_id":null,"magic_level":"baixa"}'::jsonb;

ALTER TABLE public.abilities DROP CONSTRAINT IF EXISTS abilities_attack_damage_object_check;
ALTER TABLE public.abilities ADD CONSTRAINT abilities_attack_damage_object_check
  CHECK (jsonb_typeof(attack_damage) = 'object');

-- Preserve normal activation validation, mana/cooldown handling, healing, caster effects,
-- ending-effect metadata and queued script hooks, but deliver target-scoped effects only
-- to the hit list chosen by the master.


