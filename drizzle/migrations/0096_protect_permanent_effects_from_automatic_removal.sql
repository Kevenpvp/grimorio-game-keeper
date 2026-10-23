-- Do not let automatic effects/scripts remove permanent sheet effects.
-- Trait-owned permanent effects are removed only when their source trait/effect disappears.
-- Manual permanent effects may be removed only through the master-only RPC below.
CREATE OR REPLACE FUNCTION public.protect_sheet_permanent_battle_effect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current_trait uuid;
  _template jsonb;
  _manual_master_removal boolean := COALESCE(current_setting('app.allow_permanent_effect_delete', true), 'false') = 'true';
BEGIN
  IF OLD.is_sheet_permanent IS NOT TRUE THEN
    RETURN OLD;
  END IF;

  -- Cascading deletion of a character should still clean up its effects.
  IF NOT EXISTS (SELECT 1 FROM public.characters c WHERE c.id = OLD.character_id) THEN
    RETURN OLD;
  END IF;

  IF OLD.source_race_id IS NOT NULL THEN
    SELECT c.race_id INTO _current_trait FROM public.characters c WHERE c.id = OLD.character_id;
    IF _current_trait IS DISTINCT FROM OLD.source_race_id
       OR NOT EXISTS (SELECT 1 FROM public.races r WHERE r.id = OLD.source_race_id) THEN
      RETURN OLD;
    END IF;
    SELECT r.starting_effects INTO _template FROM public.races r WHERE r.id = OLD.source_race_id;
    IF OLD.source_race_effect_index IS NOT NULL
       AND OLD.source_race_effect_index >= jsonb_array_length(COALESCE(_template, '[]'::jsonb)) THEN
      RETURN OLD;
    END IF;
  END IF;

  IF OLD.source_class_id IS NOT NULL THEN
    SELECT c.class_id INTO _current_trait FROM public.characters c WHERE c.id = OLD.character_id;
    IF _current_trait IS DISTINCT FROM OLD.source_class_id
       OR NOT EXISTS (SELECT 1 FROM public.classes cl WHERE cl.id = OLD.source_class_id) THEN
      RETURN OLD;
    END IF;
    SELECT cl.starting_effects INTO _template FROM public.classes cl WHERE cl.id = OLD.source_class_id;
    IF OLD.source_class_effect_index IS NOT NULL
       AND OLD.source_class_effect_index >= jsonb_array_length(COALESCE(_template, '[]'::jsonb)) THEN
      RETURN OLD;
    END IF;
  END IF;

  IF OLD.source_virtue_id IS NOT NULL THEN
    SELECT c.virtue_id INTO _current_trait FROM public.characters c WHERE c.id = OLD.character_id;
    IF _current_trait IS DISTINCT FROM OLD.source_virtue_id
       OR NOT EXISTS (SELECT 1 FROM public.virtues v WHERE v.id = OLD.source_virtue_id) THEN
      RETURN OLD;
    END IF;
    SELECT v.starting_effects INTO _template FROM public.virtues v WHERE v.id = OLD.source_virtue_id;
    IF OLD.source_virtue_effect_index IS NOT NULL
       AND OLD.source_virtue_effect_index >= jsonb_array_length(COALESCE(_template, '[]'::jsonb)) THEN
      RETURN OLD;
    END IF;
  END IF;

  -- A trait-owned effect cannot be manually removed while its trait is still active.
  IF OLD.source_race_id IS NOT NULL OR OLD.source_class_id IS NOT NULL OR OLD.source_virtue_id IS NOT NULL THEN
    RETURN NULL;
  END IF;

  IF _manual_master_removal AND public.has_role(auth.uid(), 'master') THEN
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_manual_character_effect(_effect_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _effect public.battle_effects;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode remover efeitos manualmente da ficha.';
  END IF;

  SELECT * INTO _effect
  FROM public.battle_effects
  WHERE id = _effect_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF _effect.source_race_id IS NOT NULL OR _effect.source_class_id IS NOT NULL OR _effect.source_virtue_id IS NOT NULL THEN
    RAISE EXCEPTION 'Efeitos iniciais de raça, classe ou virtude só saem ao remover ou trocar o traço que os concede.';
  END IF;

  IF _effect.is_sheet_permanent THEN
    PERFORM set_config('app.allow_permanent_effect_delete', 'true', true);
  END IF;

  DELETE FROM public.battle_effects WHERE id = _effect_id;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_manual_character_effect(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_manual_character_effect(uuid) TO authenticated;
