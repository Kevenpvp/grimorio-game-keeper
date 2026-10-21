-- Support initial Body/Sanity modifiers for traits and abilities granted by races.
-- Negative modifiers lower the character's current condition when the race/virtue is selected.
-- The modifier is stored in the existing modifiers JSON (keys "body" and "sanity").

ALTER TABLE public.character_abilities
  ADD COLUMN IF NOT EXISTS granted_by_race_id uuid REFERENCES public.races(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS character_abilities_granted_by_race_idx
  ON public.character_abilities(granted_by_race_id)
  WHERE granted_by_race_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.race_abilities (
  race_id uuid NOT NULL REFERENCES public.races(id) ON DELETE CASCADE,
  ability_id uuid NOT NULL REFERENCES public.abilities(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (race_id, ability_id)
);

CREATE INDEX IF NOT EXISTS race_abilities_ability_idx ON public.race_abilities(ability_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.race_abilities TO authenticated;
GRANT ALL ON public.race_abilities TO service_role;
ALTER TABLE public.race_abilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "race abilities readable" ON public.race_abilities
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "master manages race abilities" ON public.race_abilities
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master'))
  WITH CHECK (public.has_role(auth.uid(), 'master'));

-- Reconcile assignments from the currently selected race and virtue together.
-- Manually assigned abilities (both grant-source columns NULL) are never removed.
-- If both traits grant the same ability, it remains granted while either trait provides it.
CREATE OR REPLACE FUNCTION public.sync_character_trait_abilities(_character_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _race_id uuid;
  _virtue_id uuid;
BEGIN
  SELECT c.race_id, c.virtue_id
  INTO _race_id, _virtue_id
  FROM public.characters c
  WHERE c.id = _character_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Prefer recording a shared ability as race-granted when both traits provide it.
  UPDATE public.character_abilities ca
  SET granted_by_race_id = _race_id,
      granted_by_virtue_id = NULL
  WHERE ca.character_id = _character_id
    AND (ca.granted_by_race_id IS NOT NULL OR ca.granted_by_virtue_id IS NOT NULL)
    AND _race_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.race_abilities ra
      WHERE ra.race_id = _race_id AND ra.ability_id = ca.ability_id
    );

  UPDATE public.character_abilities ca
  SET granted_by_race_id = NULL,
      granted_by_virtue_id = _virtue_id
  WHERE ca.character_id = _character_id
    AND (ca.granted_by_race_id IS NOT NULL OR ca.granted_by_virtue_id IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1 FROM public.race_abilities ra
      WHERE ra.race_id = _race_id AND ra.ability_id = ca.ability_id
    )
    AND _virtue_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.virtue_abilities va
      WHERE va.virtue_id = _virtue_id AND va.ability_id = ca.ability_id
    );

  DELETE FROM public.character_abilities ca
  WHERE ca.character_id = _character_id
    AND (ca.granted_by_race_id IS NOT NULL OR ca.granted_by_virtue_id IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1 FROM public.race_abilities ra
      WHERE ra.race_id = _race_id AND ra.ability_id = ca.ability_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.virtue_abilities va
      WHERE va.virtue_id = _virtue_id AND va.ability_id = ca.ability_id
    );

  INSERT INTO public.character_abilities (
    character_id, ability_id, name, description, can_activate, is_passive,
    cooldown_turns, cooldown_remaining, mana_cost, effects, passive_effects,
    end_effects, is_magical, self_target_only, granted_by_race_id, granted_by_virtue_id
  )
  SELECT
    _character_id, a.id, a.name, a.description, a.can_activate, NOT a.can_activate,
    CASE WHEN a.can_activate THEN GREATEST(a.cooldown_turns, 1) ELSE 0 END,
    0, CASE WHEN a.can_activate THEN a.mana_cost ELSE 0 END,
    a.effects, a.passive_effects, a.end_effects, a.is_magical, a.self_target_only,
    _race_id, NULL
  FROM public.race_abilities ra
  JOIN public.abilities a ON a.id = ra.ability_id
  WHERE ra.race_id = _race_id
  ON CONFLICT (character_id, ability_id) DO NOTHING;

  INSERT INTO public.character_abilities (
    character_id, ability_id, name, description, can_activate, is_passive,
    cooldown_turns, cooldown_remaining, mana_cost, effects, passive_effects,
    end_effects, is_magical, self_target_only, granted_by_race_id, granted_by_virtue_id
  )
  SELECT
    _character_id, a.id, a.name, a.description, a.can_activate, NOT a.can_activate,
    CASE WHEN a.can_activate THEN GREATEST(a.cooldown_turns, 1) ELSE 0 END,
    0, CASE WHEN a.can_activate THEN a.mana_cost ELSE 0 END,
    a.effects, a.passive_effects, a.end_effects, a.is_magical, a.self_target_only,
    NULL, _virtue_id
  FROM public.virtue_abilities va
  JOIN public.abilities a ON a.id = va.ability_id
  WHERE va.virtue_id = _virtue_id
  ON CONFLICT (character_id, ability_id) DO NOTHING;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_character_trait_abilities(uuid) FROM PUBLIC, anon, authenticated;

-- Replace the old virtue-only reconciliation so ability grants from both traits stay consistent.
CREATE OR REPLACE FUNCTION public.sync_virtue_ability_assignments(_virtue_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _character_id uuid;
BEGIN
  FOR _character_id IN
    SELECT c.id FROM public.characters c WHERE c.virtue_id = _virtue_id
  LOOP
    PERFORM public.sync_character_trait_abilities(_character_id);
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_virtue_ability_assignments(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sync_race_ability_assignments(_race_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _character_id uuid;
BEGIN
  FOR _character_id IN
    SELECT c.id FROM public.characters c WHERE c.race_id = _race_id
  LOOP
    PERFORM public.sync_character_trait_abilities(_character_id);
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_race_ability_assignments(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sync_character_virtue_abilities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  PERFORM public.sync_character_trait_abilities(NEW.id);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_character_race_abilities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  PERFORM public.sync_character_trait_abilities(NEW.id);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS characters_sync_race_abilities_insert ON public.characters;
DROP TRIGGER IF EXISTS characters_sync_race_abilities_update ON public.characters;
CREATE TRIGGER characters_sync_race_abilities_insert
AFTER INSERT ON public.characters
FOR EACH ROW EXECUTE FUNCTION public.sync_character_race_abilities();
CREATE TRIGGER characters_sync_race_abilities_update
AFTER UPDATE OF race_id ON public.characters
FOR EACH ROW EXECUTE FUNCTION public.sync_character_race_abilities();

CREATE OR REPLACE FUNCTION public.on_race_abilities_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.sync_race_ability_assignments(OLD.race_id);
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM public.sync_race_ability_assignments(NEW.race_id);
    RETURN NEW;
  ELSE
    PERFORM public.sync_race_ability_assignments(OLD.race_id);
    IF NEW.race_id IS DISTINCT FROM OLD.race_id THEN
      PERFORM public.sync_race_ability_assignments(NEW.race_id);
    ELSE
      PERFORM public.sync_race_ability_assignments(NEW.race_id);
    END IF;
    RETURN NEW;
  END IF;
END;
$function$;

DROP TRIGGER IF EXISTS race_abilities_sync_assignments ON public.race_abilities;
CREATE TRIGGER race_abilities_sync_assignments
AFTER INSERT OR UPDATE OR DELETE ON public.race_abilities
FOR EACH ROW EXECUTE FUNCTION public.on_race_abilities_changed();

-- Apply signed initial Body/Sanity modifiers when an assigned trait changes.
-- The old modifier is reversed before the new modifier is applied, preserving later damage.
CREATE OR REPLACE FUNCTION public.apply_trait_condition_modifier_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _old_body integer := COALESCE((OLD.modifiers ->> 'body')::integer, 0);
  _new_body integer := COALESCE((NEW.modifiers ->> 'body')::integer, 0);
  _old_sanity integer := COALESCE((OLD.modifiers ->> 'sanity')::integer, 0);
  _new_sanity integer := COALESCE((NEW.modifiers ->> 'sanity')::integer, 0);
BEGIN
  IF TG_TABLE_NAME = 'races' THEN
    UPDATE public.characters c
    SET body = GREATEST(0, LEAST(100, c.body - _old_body + _new_body)),
        sanity = GREATEST(0, LEAST(100, c.sanity - _old_sanity + _new_sanity)),
        updated_at = now()
    WHERE c.race_id = NEW.id
      AND (_old_body <> _new_body OR _old_sanity <> _new_sanity);
  ELSE
    UPDATE public.characters c
    SET body = GREATEST(0, LEAST(100, c.body - _old_body + _new_body)),
        sanity = GREATEST(0, LEAST(100, c.sanity - _old_sanity + _new_sanity)),
        updated_at = now()
    WHERE c.virtue_id = NEW.id
      AND (_old_body <> _new_body OR _old_sanity <> _new_sanity);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS races_apply_condition_modifiers ON public.races;
CREATE TRIGGER races_apply_condition_modifiers
AFTER UPDATE OF modifiers ON public.races
FOR EACH ROW EXECUTE FUNCTION public.apply_trait_condition_modifier_change();

DROP TRIGGER IF EXISTS virtues_apply_condition_modifiers ON public.virtues;
CREATE TRIGGER virtues_apply_condition_modifiers
AFTER UPDATE OF modifiers ON public.virtues
FOR EACH ROW EXECUTE FUNCTION public.apply_trait_condition_modifier_change();

-- Override trait selection RPCs to apply initial Body/Sanity deltas in the same transaction.
CREATE OR REPLACE FUNCTION public.choose_character_race(
  _character_id uuid,
  _race_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _c public.characters;
  _race_bonus integer := 0;
  _old_body_mod integer := 0;
  _old_sanity_mod integer := 0;
  _new_body_mod integer := 0;
  _new_sanity_mod integer := 0;
  _master boolean := public.has_role(auth.uid(), 'master');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;

  SELECT * INTO _c FROM public.characters WHERE id = _character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;

  IF NOT _master THEN
    IF _c.owner_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Sem permissão'; END IF;
    IF _race_id IS NULL THEN RAISE EXCEPTION 'Escolha uma raça'; END IF;
    IF _c.race_id IS NOT NULL AND _c.race_id IS DISTINCT FROM _race_id THEN
      RAISE EXCEPTION 'A raça já foi escolhida; peça ao mestre para trocar';
    END IF;
  END IF;

  IF _c.race_id IS NOT NULL THEN
    SELECT COALESCE((r.modifiers ->> 'body')::integer, 0),
           COALESCE((r.modifiers ->> 'sanity')::integer, 0)
    INTO _old_body_mod, _old_sanity_mod
    FROM public.races r WHERE r.id = _c.race_id;
  END IF;

  IF _race_id IS NOT NULL THEN
    SELECT r.bonus_points,
           COALESCE((r.modifiers ->> 'body')::integer, 0),
           COALESCE((r.modifiers ->> 'sanity')::integer, 0)
    INTO _race_bonus, _new_body_mod, _new_sanity_mod
    FROM public.races r WHERE r.id = _race_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raça não encontrada'; END IF;
  END IF;

  UPDATE public.characters
  SET race_id = _race_id,
      body = GREATEST(0, LEAST(100, _c.body - _old_body_mod + _new_body_mod)),
      sanity = GREATEST(0, LEAST(100, _c.sanity - _old_sanity_mod + _new_sanity_mod)),
      available_points = GREATEST(0, available_points - COALESCE(race_points_granted, 0) + _race_bonus),
      race_points_granted = _race_bonus
  WHERE id = _character_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.choose_character_race(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.choose_character_race(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.choose_character_virtue(
  _character_id uuid,
  _virtue_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _c public.characters;
  _virtue_bonus integer := 0;
  _old_body_mod integer := 0;
  _old_sanity_mod integer := 0;
  _new_body_mod integer := 0;
  _new_sanity_mod integer := 0;
  _master boolean := public.has_role(auth.uid(), 'master');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;

  SELECT * INTO _c FROM public.characters WHERE id = _character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;

  IF NOT _master THEN
    IF _c.owner_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Sem permissão'; END IF;
    IF _c.race_id IS NULL THEN RAISE EXCEPTION 'Confirme sua raça antes de escolher a virtude'; END IF;
    IF _virtue_id IS NULL THEN RAISE EXCEPTION 'Escolha uma virtude'; END IF;
    IF _c.virtue_id IS NOT NULL AND _c.virtue_id IS DISTINCT FROM _virtue_id THEN
      RAISE EXCEPTION 'A virtude já foi escolhida; peça ao mestre para trocar';
    END IF;
  END IF;

  IF _c.virtue_id IS NOT NULL THEN
    SELECT COALESCE(v.modifiers ->> 'body', '0')::integer,
           COALESCE(v.modifiers ->> 'sanity', '0')::integer
    INTO _old_body_mod, _old_sanity_mod
    FROM public.virtues v WHERE v.id = _c.virtue_id;
  END IF;

  IF _virtue_id IS NOT NULL THEN
    SELECT v.bonus_points,
           COALESCE(v.modifiers ->> 'body', '0')::integer,
           COALESCE(v.modifiers ->> 'sanity', '0')::integer
    INTO _virtue_bonus, _new_body_mod, _new_sanity_mod
    FROM public.virtues v WHERE v.id = _virtue_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Virtude não encontrada'; END IF;
  END IF;

  UPDATE public.characters
  SET virtue_id = _virtue_id,
      body = GREATEST(0, LEAST(100, _c.body - _old_body_mod + _new_body_mod)),
      sanity = GREATEST(0, LEAST(100, _c.sanity - _old_sanity_mod + _new_sanity_mod)),
      available_points = GREATEST(0, available_points - COALESCE(virtue_points_granted, 0) + _virtue_bonus),
      virtue_points_granted = _virtue_bonus
  WHERE id = _character_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.choose_character_virtue(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.choose_character_virtue(uuid, uuid) TO authenticated;
