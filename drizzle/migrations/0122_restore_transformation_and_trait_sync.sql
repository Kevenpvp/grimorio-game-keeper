-- Restore missing transformation grants, link synchronization, and class modifier cleanup.
-- Reconcile grants without resetting existing ability cooldown/custom state.
BEGIN;

CREATE OR REPLACE FUNCTION public.sync_transformation_ability_grants_for_character(
  _character_id uuid, _transformation_id uuid, _active boolean
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  -- Remove only grants that no longer correspond to a configured rule or
  -- grants that require an active transformation after deactivation.
  DELETE FROM public.character_abilities ca
  WHERE ca.character_id = _character_id
    AND ca.granted_by_transformation_id = _transformation_id
    AND NOT EXISTS (
      SELECT 1 FROM public.transformation_abilities ta
      WHERE ta.transformation_id = _transformation_id
        AND ta.ability_id = ca.ability_id
        AND ta.only_while_transformed = ca.granted_only_while_transformed
        AND (NOT ta.only_while_transformed OR COALESCE(_active,false))
    );

  INSERT INTO public.character_abilities (
    character_id, ability_id, name, description, can_activate, self_target_only,
    is_magical, is_passive, cooldown_turns, cooldown_remaining, mana_cost,
    effects, passive_effects, end_effects, once_per_battle,
    granted_by_transformation_id, granted_only_while_transformed
  )
  SELECT _character_id,a.id,a.name,a.description,a.can_activate,a.self_target_only,
         a.is_magical,NOT a.can_activate,
         CASE WHEN a.can_activate THEN a.cooldown_turns ELSE 0 END,
         0,CASE WHEN a.can_activate THEN a.mana_cost ELSE 0 END,
         a.effects,a.passive_effects,a.end_effects,a.once_per_battle,
         _transformation_id,ta.only_while_transformed
  FROM public.transformation_abilities ta
  JOIN public.abilities a ON a.id=ta.ability_id
  WHERE ta.transformation_id=_transformation_id
    AND (NOT ta.only_while_transformed OR COALESCE(_active,false))
  ON CONFLICT (character_id,ability_id) DO NOTHING;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_transformation_ability_grants()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    DELETE FROM public.character_abilities ca
    WHERE ca.character_id=OLD.character_id
      AND ca.granted_by_transformation_id=OLD.transformation_id;
    RETURN OLD;
  END IF;
  PERFORM public.sync_transformation_ability_grants_for_character(
    NEW.character_id,NEW.transformation_id,NEW.active
  );
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS sync_transformation_ability_grants_insert_trigger ON public.character_transformations;
CREATE TRIGGER sync_transformation_ability_grants_insert_trigger
AFTER INSERT ON public.character_transformations
FOR EACH ROW EXECUTE FUNCTION public.sync_transformation_ability_grants();
DROP TRIGGER IF EXISTS sync_transformation_ability_grants_update_trigger ON public.character_transformations;
CREATE TRIGGER sync_transformation_ability_grants_update_trigger
AFTER UPDATE OF active ON public.character_transformations
FOR EACH ROW WHEN (OLD.active IS DISTINCT FROM NEW.active)
EXECUTE FUNCTION public.sync_transformation_ability_grants();
DROP TRIGGER IF EXISTS sync_transformation_ability_grants_delete_trigger ON public.character_transformations;
CREATE TRIGGER sync_transformation_ability_grants_delete_trigger
AFTER DELETE ON public.character_transformations
FOR EACH ROW EXECUTE FUNCTION public.sync_transformation_ability_grants();

CREATE OR REPLACE FUNCTION public.sync_edited_transformation_ability_grants()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _transformation_id uuid; _ct record;
BEGIN
  _transformation_id := CASE WHEN TG_OP='DELETE' THEN OLD.transformation_id ELSE NEW.transformation_id END;
  FOR _ct IN
    SELECT character_id,active
    FROM public.character_transformations WHERE transformation_id=_transformation_id
  LOOP
    PERFORM public.sync_transformation_ability_grants_for_character(
      _ct.character_id,_transformation_id,_ct.active
    );
  END LOOP;
  IF TG_OP='UPDATE' AND OLD.transformation_id IS DISTINCT FROM NEW.transformation_id THEN
    FOR _ct IN
      SELECT character_id,active
      FROM public.character_transformations WHERE transformation_id=OLD.transformation_id
    LOOP
      PERFORM public.sync_transformation_ability_grants_for_character(
        _ct.character_id,OLD.transformation_id,_ct.active
      );
    END LOOP;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;
DROP TRIGGER IF EXISTS sync_edited_transformation_ability_grants_trigger ON public.transformation_abilities;
CREATE TRIGGER sync_edited_transformation_ability_grants_trigger
AFTER INSERT OR DELETE OR UPDATE ON public.transformation_abilities
FOR EACH ROW EXECUTE FUNCTION public.sync_edited_transformation_ability_grants();

-- A character's trait-update hooks already manage transformations when
-- switching race/virtue/class, but not when the master edits the trait's grant list.
CREATE OR REPLACE FUNCTION public.sync_transformation_link_states()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _transformation_id uuid;
  _trait_id uuid;
  _char record;
BEGIN
  IF TG_OP='DELETE' THEN
    _transformation_id:=OLD.transformation_id;
    _trait_id:=CASE TG_TABLE_NAME
      WHEN 'race_transformations' THEN OLD.race_id
      WHEN 'virtue_transformations' THEN OLD.virtue_id
      ELSE OLD.class_id END;
    FOR _char IN
      SELECT c.id FROM public.characters c
      WHERE (TG_TABLE_NAME='race_transformations' AND c.race_id=_trait_id)
         OR (TG_TABLE_NAME='virtue_transformations' AND c.virtue_id=_trait_id)
         OR (TG_TABLE_NAME='class_transformations' AND c.class_id=_trait_id)
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.characters c
        WHERE c.id=_char.id AND (
          EXISTS(SELECT 1 FROM public.race_transformations rt
                 WHERE rt.race_id=c.race_id AND rt.transformation_id=_transformation_id)
          OR EXISTS(SELECT 1 FROM public.virtue_transformations vt
                    WHERE vt.virtue_id=c.virtue_id AND vt.transformation_id=_transformation_id)
          OR EXISTS(SELECT 1 FROM public.class_transformations clt
                    WHERE clt.class_id=c.class_id AND clt.transformation_id=_transformation_id)
          OR EXISTS(SELECT 1 FROM public.transformations t
                    WHERE t.owner_character_id=c.id AND t.id=_transformation_id)
        )
      ) THEN
        IF EXISTS(SELECT 1 FROM public.character_transformations ct
                  WHERE ct.character_id=_char.id AND ct.transformation_id=_transformation_id AND ct.active) THEN
          PERFORM public.end_character_transformation_internal(_char.id,_transformation_id,false);
        END IF;
        DELETE FROM public.character_transformations ct
        WHERE ct.character_id=_char.id AND ct.transformation_id=_transformation_id;
      END IF;
    END LOOP;
    RETURN OLD;
  END IF;
  _transformation_id:=NEW.transformation_id;
  _trait_id:=CASE TG_TABLE_NAME
    WHEN 'race_transformations' THEN NEW.race_id
    WHEN 'virtue_transformations' THEN NEW.virtue_id
    ELSE NEW.class_id END;

  INSERT INTO public.character_transformations
    (character_id,transformation_id,active,cooldown_remaining)
  SELECT c.id,_transformation_id,false,0 FROM public.characters c
  WHERE (TG_TABLE_NAME='race_transformations' AND c.race_id=_trait_id)
     OR (TG_TABLE_NAME='virtue_transformations' AND c.virtue_id=_trait_id)
     OR (TG_TABLE_NAME='class_transformations' AND c.class_id=_trait_id)
  ON CONFLICT (character_id,transformation_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS sync_race_transformation_states ON public.race_transformations;
CREATE TRIGGER sync_race_transformation_states
AFTER INSERT OR DELETE ON public.race_transformations
FOR EACH ROW EXECUTE FUNCTION public.sync_transformation_link_states();
DROP TRIGGER IF EXISTS sync_virtue_transformation_states ON public.virtue_transformations;
CREATE TRIGGER sync_virtue_transformation_states
AFTER INSERT OR DELETE ON public.virtue_transformations
FOR EACH ROW EXECUTE FUNCTION public.sync_transformation_link_states();
DROP TRIGGER IF EXISTS sync_class_transformation_states ON public.class_transformations;
CREATE TRIGGER sync_class_transformation_states
AFTER INSERT OR DELETE ON public.class_transformations
FOR EACH ROW EXECUTE FUNCTION public.sync_transformation_link_states();

CREATE OR REPLACE FUNCTION public.clear_class_custom_modifiers_when_class_removed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.class_id IS NULL
     AND COALESCE(NEW.class_custom_modifiers,'{}'::jsonb)<>'{}'::jsonb THEN
    UPDATE public.characters SET class_custom_modifiers='{}'::jsonb
    WHERE id=NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS clear_class_custom_modifiers_when_class_removed ON public.characters;
CREATE TRIGGER clear_class_custom_modifiers_when_class_removed
AFTER UPDATE OF class_id ON public.characters
FOR EACH ROW WHEN (NEW.class_id IS NULL)
EXECUTE FUNCTION public.clear_class_custom_modifiers_when_class_removed();

-- Keep internal triggers inaccessible as direct authenticated RPC endpoints.
REVOKE ALL ON FUNCTION public.sync_transformation_ability_grants_for_character(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.sync_transformation_ability_grants() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.sync_edited_transformation_ability_grants() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.sync_transformation_link_states() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.clear_class_custom_modifiers_when_class_removed() FROM PUBLIC,anon,authenticated;

-- Reconcile preexisting assignments without removing grants from unrelated sources.
DO $reconcile$
DECLARE _item record;
BEGIN
  FOR _item IN SELECT character_id,transformation_id,active
    FROM public.character_transformations
  LOOP
    PERFORM public.sync_transformation_ability_grants_for_character(
      _item.character_id,_item.transformation_id,_item.active
    );
  END LOOP;
END;
$reconcile$;
COMMIT;
