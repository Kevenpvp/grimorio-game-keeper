-- Character-specific abilities, once-per-battle tracking, transformation-granted abilities,
-- and battle-scoped temporary overrides.
ALTER TABLE public.abilities
  ADD COLUMN IF NOT EXISTS once_per_battle boolean NOT NULL DEFAULT false;

ALTER TABLE public.character_abilities
  ALTER COLUMN ability_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS once_per_battle boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS granted_by_transformation_id uuid REFERENCES public.transformations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS granted_only_while_transformed boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS character_abilities_transformation_grant_idx
  ON public.character_abilities(granted_by_transformation_id)
  WHERE granted_by_transformation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.character_ability_battle_uses (
  battle_id uuid NOT NULL REFERENCES public.battles(id) ON DELETE CASCADE,
  character_ability_id uuid NOT NULL REFERENCES public.character_abilities(id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (battle_id, character_ability_id)
);
ALTER TABLE public.character_ability_battle_uses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS character_ability_battle_uses_read_accessible ON public.character_ability_battle_uses;
CREATE POLICY character_ability_battle_uses_read_accessible ON public.character_ability_battle_uses
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(), 'master')
    OR EXISTS (SELECT 1 FROM public.characters c WHERE c.id = character_id AND c.owner_id = auth.uid())
    OR public.shares_battle(character_id)
  );
GRANT SELECT ON public.character_ability_battle_uses TO authenticated;
GRANT ALL ON public.character_ability_battle_uses TO service_role;

-- Per-battle changes are overlays and never overwrite permanent character_abilities values.
CREATE TABLE IF NOT EXISTS public.battle_ability_overrides (
  battle_id uuid NOT NULL REFERENCES public.battles(id) ON DELETE CASCADE,
  character_ability_id uuid NOT NULL REFERENCES public.character_abilities(id) ON DELETE CASCADE,
  override_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  keep_after_use boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (battle_id, character_ability_id),
  CONSTRAINT battle_ability_overrides_object_check CHECK (jsonb_typeof(override_values) = 'object')
);
ALTER TABLE public.battle_ability_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS battle_ability_overrides_master_manage ON public.battle_ability_overrides;
CREATE POLICY battle_ability_overrides_master_manage ON public.battle_ability_overrides
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master') AND EXISTS (SELECT 1 FROM public.battles b WHERE b.id = battle_id AND b.active))
  WITH CHECK (public.has_role(auth.uid(), 'master') AND EXISTS (SELECT 1 FROM public.battles b WHERE b.id = battle_id AND b.active));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.battle_ability_overrides TO authenticated;
GRANT ALL ON public.battle_ability_overrides TO service_role;

-- A transformation may grant an ability always while the transformation is owned,
-- or only while it is currently active in combat.
CREATE TABLE IF NOT EXISTS public.transformation_abilities (
  transformation_id uuid NOT NULL REFERENCES public.transformations(id) ON DELETE CASCADE,
  ability_id uuid NOT NULL REFERENCES public.abilities(id) ON DELETE CASCADE,
  only_while_transformed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transformation_id, ability_id)
);
ALTER TABLE public.transformation_abilities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transformation_abilities_read_authenticated ON public.transformation_abilities;
CREATE POLICY transformation_abilities_read_authenticated ON public.transformation_abilities
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS transformation_abilities_master_manage ON public.transformation_abilities;
CREATE POLICY transformation_abilities_master_manage ON public.transformation_abilities
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'master'))
  WITH CHECK (public.has_role(auth.uid(), 'master'));
GRANT SELECT ON public.transformation_abilities TO authenticated;
GRANT ALL ON public.transformation_abilities TO service_role;

-- Remove abilities that were granted only for a transformation as soon as that
-- transformation is no longer active. Permanent grants remain attached to the character.
CREATE OR REPLACE FUNCTION public.sync_transformation_granted_abilities()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF OLD.active AND NOT NEW.active THEN
    DELETE FROM public.character_abilities
    WHERE character_id = NEW.character_id
      AND granted_by_transformation_id = NEW.transformation_id
      AND granted_only_while_transformed = true;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sync_transformation_granted_abilities_trigger ON public.character_transformations;
CREATE TRIGGER sync_transformation_granted_abilities_trigger
AFTER UPDATE OF active ON public.character_transformations
FOR EACH ROW EXECUTE FUNCTION public.sync_transformation_granted_abilities();

-- Ensure the one-use ledger and temporary overrides disappear when combat ends.
CREATE OR REPLACE FUNCTION public.cleanup_battle_ability_runtime()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF OLD.active AND NOT NEW.active THEN
    DELETE FROM public.character_ability_battle_uses WHERE battle_id = NEW.id;
    DELETE FROM public.battle_ability_overrides WHERE battle_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS cleanup_battle_ability_runtime_trigger ON public.battles;
CREATE TRIGGER cleanup_battle_ability_runtime_trigger
AFTER UPDATE OF active ON public.battles
FOR EACH ROW EXECUTE FUNCTION public.cleanup_battle_ability_runtime();
