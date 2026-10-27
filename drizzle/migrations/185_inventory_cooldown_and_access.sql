-- Equipment runtime cannot be reset by unequipping and re-equipping.
ALTER TABLE public.character_inventory
  ADD COLUMN IF NOT EXISTS ability_runtime jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(ability_runtime)='object');

DROP POLICY IF EXISTS item_templates_authenticated_read ON public.item_templates;
CREATE POLICY item_templates_owned_inventory_read ON public.item_templates FOR SELECT TO authenticated
USING (
  public.has_role((SELECT auth.uid()),'master')
  OR EXISTS (
    SELECT 1 FROM public.character_inventory i
    JOIN public.characters c ON c.id=i.character_id
    WHERE i.item_template_id=item_templates.id AND c.owner_id=(SELECT auth.uid())
  )
);

CREATE OR REPLACE FUNCTION public.inventory_set_equipped(_item_id uuid,_equipped boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='public'
AS $fn$
DECLARE
  _character uuid; _was_equipped boolean;
  _ability record; _saved jsonb; _battle_id uuid;
BEGIN
  SELECT i.character_id, i.equipped INTO _character,_was_equipped
  FROM public.character_inventory i WHERE i.id=_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item não encontrado'; END IF;
  IF auth.uid() IS NULL OR NOT (
    public.has_role(auth.uid(),'master')
    OR EXISTS(SELECT 1 FROM public.characters c WHERE c.id=_character AND c.owner_id=auth.uid())
  ) THEN RAISE EXCEPTION 'Você não pode equipar itens desta ficha'; END IF;

  PERFORM 1 FROM public.characters WHERE id=_character FOR UPDATE;
  -- Recheck item after locking the character, so simultaneous equip actions
  -- cannot accidentally restore/overwrite another state.
  SELECT equipped INTO _was_equipped
  FROM public.character_inventory WHERE id=_item_id AND character_id=_character FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item não encontrado'; END IF;
  IF _was_equipped=COALESCE(_equipped,false) THEN RETURN true; END IF;

  IF _was_equipped AND NOT COALESCE(_equipped,false) THEN
    FOR _ability IN
      SELECT ca.ability_id,ca.cooldown_remaining,
        COALESCE((
          SELECT jsonb_agg(u.battle_id::text)
          FROM public.character_ability_battle_uses u
          JOIN public.battles b ON b.id=u.battle_id AND b.active
          WHERE u.character_ability_id=ca.id
        ),'[]'::jsonb) AS used_battles
      FROM public.character_abilities ca
      WHERE ca.character_id=_character AND ca.source_inventory_item_id=_item_id
        AND ca.ability_id IS NOT NULL
    LOOP
      UPDATE public.character_inventory
      SET ability_runtime=jsonb_set(
        ability_runtime, ARRAY[_ability.ability_id::text],
        jsonb_build_object('cooldown',_ability.cooldown_remaining,'used_battles',_ability.used_battles),true)
      WHERE id=_item_id;
    END LOOP;
  END IF;

  UPDATE public.character_inventory SET equipped=COALESCE(_equipped,false) WHERE id=_item_id;
  PERFORM public.sync_character_inventory_internal(_character);

  IF NOT _was_equipped AND COALESCE(_equipped,false) THEN
    FOR _ability IN SELECT ca.id,ca.ability_id,ca.cooldown_turns,
      i.ability_runtime->ca.ability_id::text AS runtime
      FROM public.character_abilities ca
      JOIN public.character_inventory i ON i.id=ca.source_inventory_item_id
      WHERE ca.character_id=_character AND ca.source_inventory_item_id=_item_id
        AND ca.ability_id IS NOT NULL
    LOOP
      _saved:=_ability.runtime;
      IF jsonb_typeof(_saved)<>'object' THEN CONTINUE; END IF;
      UPDATE public.character_abilities SET
        cooldown_remaining=GREATEST(cooldown_remaining,
          LEAST(_ability.cooldown_turns,GREATEST(0,COALESCE((_saved->>'cooldown')::integer,0))))
      WHERE id=_ability.id;
      IF jsonb_typeof(_saved->'used_battles')='array' THEN
        FOR _battle_id IN SELECT value::uuid FROM jsonb_array_elements_text(_saved->'used_battles')
        LOOP
          IF EXISTS(SELECT 1 FROM public.battles WHERE id=_battle_id AND active)
            AND EXISTS(SELECT 1 FROM public.battle_participants bp
              WHERE bp.battle_id=_battle_id AND bp.character_id=_character)
          THEN
            INSERT INTO public.character_ability_battle_uses(battle_id,character_ability_id,character_id)
            VALUES (_battle_id,_ability.id,_character) ON CONFLICT DO NOTHING;
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END IF;
  RETURN true;
END;
$fn$;
REVOKE ALL ON FUNCTION public.inventory_set_equipped(uuid,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.inventory_set_equipped(uuid,boolean) TO authenticated;

-- Inventory details expose full grant names only to that character's owner/GM,
-- even when the source catalog character is otherwise outside player access.
CREATE OR REPLACE FUNCTION public.inventory_item_grant_details(_item_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='public'
AS $fn$
DECLARE _template public.item_templates%ROWTYPE; _character uuid; _template_id uuid;
BEGIN
  SELECT i.character_id,i.item_template_id INTO _character,_template_id
  FROM public.character_inventory i WHERE i.id=_item_id;
  IF FOUND THEN SELECT * INTO _template FROM public.item_templates WHERE id=_template_id; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item não encontrado'; END IF;
  IF auth.uid() IS NULL OR NOT (
    public.has_role(auth.uid(),'master') OR
    EXISTS(SELECT 1 FROM public.characters c WHERE c.id=_character AND c.owner_id=auth.uid())
  ) THEN RAISE EXCEPTION 'Você não pode consultar este item'; END IF;
  RETURN jsonb_build_object(
    'abilities',COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name) ORDER BY a.name)
      FROM public.abilities a WHERE a.id=ANY(_template.ability_ids)
    ),'[]'::jsonb),
    'transformations',COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.name) ORDER BY t.name)
      FROM public.transformations t WHERE t.id=ANY(_template.transformation_ids)
    ),'[]'::jsonb),
    'summons',COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) ORDER BY c.name)
      FROM public.characters c WHERE c.id=ANY(_template.summon_character_ids)
    ),'[]'::jsonb)
  );
END;
$fn$;
REVOKE ALL ON FUNCTION public.inventory_item_grant_details(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.inventory_item_grant_details(uuid) TO authenticated;

-- Reconcile an already-equipped item when another system revokes a manually
-- granted copy of the same catalog transformation.
CREATE OR REPLACE FUNCTION public.restore_equipped_transformation_after_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='public'
AS $fn$
BEGIN
  IF OLD.owner_character_id IS NOT NULL AND OLD.source_inventory_item_id IS NULL
    AND EXISTS (
      SELECT 1 FROM public.character_inventory i
      JOIN public.item_templates t ON t.id=i.item_template_id
      WHERE i.character_id=OLD.owner_character_id AND i.equipped
        AND OLD.source_transformation_id=ANY(t.transformation_ids)
    )
  THEN
    PERFORM public.sync_character_inventory_internal(OLD.owner_character_id);
  END IF;
  RETURN OLD;
END;
$fn$;
REVOKE ALL ON FUNCTION public.restore_equipped_transformation_after_delete() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS inventory_restore_transformation ON public.transformations;
CREATE TRIGGER inventory_restore_transformation
AFTER DELETE ON public.transformations
FOR EACH ROW EXECUTE FUNCTION public.restore_equipped_transformation_after_delete();
