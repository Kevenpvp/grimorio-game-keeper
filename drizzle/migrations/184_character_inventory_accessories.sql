-- RPG inventory and first item type: accessory.
ALTER TABLE public.characters ADD COLUMN IF NOT EXISTS inventory_slots integer NOT NULL DEFAULT 12
  CHECK (inventory_slots BETWEEN 0 AND 200);

CREATE TABLE IF NOT EXISTS public.item_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 140),
  description text NOT NULL DEFAULT '',
  item_type text NOT NULL DEFAULT 'accessory' CHECK (item_type IN ('accessory')),
  image_path text,
  effects jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(effects)='array'),
  ability_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  transformation_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  summon_character_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.character_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  item_template_id uuid NOT NULL REFERENCES public.item_templates(id) ON DELETE RESTRICT,
  slot_index integer NOT NULL CHECK (slot_index BETWEEN 1 AND 200),
  equipped boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (character_id,slot_index)
);
CREATE INDEX IF NOT EXISTS character_inventory_equipped_idx ON public.character_inventory(character_id,equipped);
ALTER TABLE public.character_abilities ADD COLUMN IF NOT EXISTS source_inventory_item_id uuid
  REFERENCES public.character_inventory(id) ON DELETE SET NULL;
ALTER TABLE public.transformations ADD COLUMN IF NOT EXISTS source_inventory_item_id uuid
  REFERENCES public.character_inventory(id) ON DELETE SET NULL;
ALTER TABLE public.summon_grants ADD COLUMN IF NOT EXISTS source_inventory_item_id uuid
  REFERENCES public.character_inventory(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS character_abilities_inventory_source_idx ON public.character_abilities(source_inventory_item_id);
CREATE INDEX IF NOT EXISTS transformations_inventory_source_idx ON public.transformations(source_inventory_item_id);
CREATE INDEX IF NOT EXISTS summon_grants_inventory_source_idx ON public.summon_grants(source_inventory_item_id);

ALTER TABLE public.item_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_inventory ENABLE ROW LEVEL SECURITY;
CREATE POLICY item_templates_master_all ON public.item_templates FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()),'master'))
  WITH CHECK (public.has_role((select auth.uid()),'master'));
CREATE POLICY item_templates_authenticated_read ON public.item_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY character_inventory_master_all ON public.character_inventory FOR SELECT TO authenticated
  USING (public.has_role((select auth.uid()),'master'));
CREATE POLICY character_inventory_owner_read ON public.character_inventory FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.characters c WHERE c.id=character_id AND c.owner_id=(select auth.uid())));
GRANT SELECT,INSERT,UPDATE,DELETE ON public.item_templates TO authenticated;
GRANT SELECT ON public.character_inventory TO authenticated;

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('item-images','item-images',true,8388608,ARRAY['image/jpeg','image/png','image/webp','image/gif'])
ON CONFLICT (id) DO NOTHING;
CREATE POLICY accessory_images_master_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id='item-images' AND public.has_role((select auth.uid()),'master'));
CREATE POLICY accessory_images_master_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id='item-images' AND public.has_role((select auth.uid()),'master'))
  WITH CHECK (bucket_id='item-images' AND public.has_role((select auth.uid()),'master'));
CREATE POLICY accessory_images_master_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id='item-images' AND public.has_role((select auth.uid()),'master'));
CREATE POLICY accessory_images_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id='item-images');

-- Internal single-character reconciliation is atomic, including removal of grants.
-- No public EXECUTE. Every caller must authenticate and validate access.
CREATE OR REPLACE FUNCTION public.sync_character_inventory_internal(_character_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='public'
AS $fn$
DECLARE
  _old record; _inv record; _id uuid; _copy_id uuid; _other_id uuid;
  _template public.transformations%ROWTYPE;
  _summon record; _continuous record;
BEGIN
  IF _character_id IS NULL THEN RETURN; END IF;
  PERFORM 1 FROM public.characters WHERE id=_character_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  -- Rehome catalog abilities from unequipped accessories to an alternative
  -- equipped item, preserving the same assignment, cooldown and custom state.
  FOR _old IN SELECT ca.id,ca.ability_id,ca.source_inventory_item_id
    FROM public.character_abilities ca
    WHERE ca.character_id=_character_id AND ca.source_inventory_item_id IS NOT NULL
      AND ca.ability_id IS NOT NULL
  LOOP
    SELECT i.id INTO _other_id FROM public.character_inventory i
      JOIN public.item_templates t ON t.id=i.item_template_id
      WHERE i.character_id=_character_id AND i.equipped AND _old.ability_id=ANY(t.ability_ids)
      ORDER BY i.created_at,i.id LIMIT 1;
    IF _other_id IS NULL THEN
      FOR _continuous IN SELECT id FROM public.continuous_effect_instances
        WHERE character_ability_id=_old.id AND active
      LOOP PERFORM public.finish_continuous_instance_internal(_continuous.id,true); END LOOP;
      DELETE FROM public.battle_effects WHERE source_character_ability_id=_old.id
        AND NOT COALESCE(is_sheet_permanent,false);
      DELETE FROM public.character_abilities WHERE id=_old.id;
    ELSIF _other_id IS DISTINCT FROM _old.source_inventory_item_id THEN
      UPDATE public.character_abilities SET source_inventory_item_id=_other_id WHERE id=_old.id;
    END IF;
  END LOOP;

  -- Equipment-only passive effects use the existing passive ability engine.
  -- They are not copied into independent permanent battle effects.
  FOR _old IN SELECT ca.id,ca.source_inventory_item_id
    FROM public.character_abilities ca
    WHERE ca.character_id=_character_id AND ca.source_inventory_item_id IS NOT NULL
      AND ca.ability_id IS NULL
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.character_inventory i JOIN public.item_templates t ON t.id=i.item_template_id
      WHERE i.id=_old.source_inventory_item_id AND i.equipped AND jsonb_array_length(t.effects)>0
    ) THEN
      DELETE FROM public.character_abilities WHERE id=_old.id;
    END IF;
  END LOOP;

  -- Remove lost transformation copies; leave independent race/virtue/class
  -- transformations and unrelated private customizations alone.
  FOR _old IN SELECT t.id,t.source_inventory_item_id,t.source_transformation_id
    FROM public.transformations t WHERE t.owner_character_id=_character_id
      AND t.source_inventory_item_id IS NOT NULL
  LOOP
    SELECT i.id INTO _other_id FROM public.character_inventory i JOIN public.item_templates it
      ON it.id=i.item_template_id
      WHERE i.character_id=_character_id AND i.equipped AND _old.source_transformation_id=ANY(it.transformation_ids)
      ORDER BY i.created_at,i.id LIMIT 1;
    IF _other_id IS NULL THEN
      PERFORM public.end_character_transformation_internal(_character_id,_old.id,false);
      DELETE FROM public.transformations WHERE id=_old.id;
    ELSIF _other_id IS DISTINCT FROM _old.source_inventory_item_id THEN
      UPDATE public.transformations SET source_inventory_item_id=_other_id WHERE id=_old.id;
    END IF;
  END LOOP;

  -- Invocations belong to the exact inventory item. Active snapshots are
  -- cleaned before revoking the summon grant.
  FOR _summon IN SELECT sg.id,sg.source_inventory_item_id,sg.template_character_id
    FROM public.summon_grants sg
    WHERE sg.summoner_character_id=_character_id AND sg.source_inventory_item_id IS NOT NULL
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.character_inventory i JOIN public.item_templates t ON t.id=i.item_template_id
      WHERE i.id=_summon.source_inventory_item_id AND i.equipped
        AND _summon.template_character_id=ANY(t.summon_character_ids)
    ) THEN
      FOR _old IN SELECT summoned_character_id FROM public.active_summons WHERE grant_id=_summon.id
      LOOP
        DELETE FROM public.characters WHERE id=_old.summoned_character_id;
      END LOOP;
      DELETE FROM public.summon_grants WHERE id=_summon.id;
    END IF;
  END LOOP;

  FOR _inv IN
    SELECT i.id,t.name,t.effects,t.ability_ids,t.transformation_ids,t.summon_character_ids
    FROM public.character_inventory i
    JOIN public.item_templates t ON t.id=i.item_template_id
    WHERE i.character_id=_character_id AND i.equipped
    ORDER BY i.created_at,i.id
  LOOP
    IF jsonb_array_length(_inv.effects)>0 THEN
      SELECT id INTO _copy_id FROM public.character_abilities
        WHERE character_id=_character_id AND source_inventory_item_id=_inv.id
          AND ability_id IS NULL LIMIT 1;
      IF _copy_id IS NULL THEN
        INSERT INTO public.character_abilities
          (character_id,name,description,is_passive,can_activate,is_magical,
           cooldown_turns,mana_cost,passive_effects,source_inventory_item_id)
        VALUES
          (_character_id,'Acessório: '||_inv.name,'Efeitos passivos do acessório equipado',
           true,false,false,0,0,_inv.effects,_inv.id);
      ELSE
        UPDATE public.character_abilities
          SET name='Acessório: '||_inv.name,passive_effects=_inv.effects
        WHERE id=_copy_id;
      END IF;
    END IF;

    FOR _id IN SELECT DISTINCT unnest(_inv.ability_ids) LOOP
      INSERT INTO public.character_abilities
        (character_id,ability_id,name,description,is_passive,can_activate,self_target_only,is_magical,
         cooldown_turns,mana_cost,effects,passive_effects,end_effects,once_per_battle,custom_attributes,
         toggle_mode,attack_enabled,attack_damage,attack_effect_groups,dot_effects,
         duration_turns,attack_mana_cost,continuous_rules,custom_script_key,source_inventory_item_id)
      SELECT _character_id,a.id,a.name,a.description,a.is_passive,a.can_activate,a.self_target_only,
        a.is_magical,a.cooldown_turns,a.mana_cost,a.effects,a.passive_effects,a.end_effects,
        a.once_per_battle,a.custom_attributes,a.toggle_mode,a.attack_enabled,a.attack_damage,
        a.attack_effect_groups,a.dot_effects,a.duration_turns,a.attack_mana_cost,a.continuous_rules,
        a.custom_script_key,_inv.id
      FROM public.abilities a WHERE a.id=_id
      ON CONFLICT (character_id,ability_id) DO NOTHING;
    END LOOP;

    FOR _id IN SELECT DISTINCT unnest(_inv.transformation_ids) LOOP
      -- Other sources may already have an equivalent private copy.
      IF NOT EXISTS (
        SELECT 1 FROM public.transformations t
        WHERE t.owner_character_id=_character_id AND t.source_transformation_id=_id
      ) THEN
        SELECT * INTO _template FROM public.transformations
          WHERE id=_id AND owner_character_id IS NULL AND source_transformation_id IS NULL;
        IF FOUND THEN
          INSERT INTO public.transformations
            (owner_character_id,source_transformation_id,source_inventory_item_id,
             name,description,duration_turns,cooldown_turns,mana_cost,modifiers,effects,end_effects)
          VALUES (_character_id,_id,_inv.id,_template.name,_template.description,
            _template.duration_turns,_template.cooldown_turns,_template.mana_cost,
            _template.modifiers,_template.effects,_template.end_effects)
          RETURNING id INTO _copy_id;
          INSERT INTO public.transformation_abilities
            (transformation_id,ability_id,only_while_transformed)
          SELECT _copy_id,ability_id,only_while_transformed
          FROM public.transformation_abilities WHERE transformation_id=_id
          ON CONFLICT (transformation_id,ability_id) DO NOTHING;
          INSERT INTO public.character_transformations(character_id,transformation_id,active,cooldown_remaining)
          VALUES (_character_id,_copy_id,false,0)
          ON CONFLICT DO NOTHING;
        END IF;
      END IF;
    END LOOP;

    FOR _id IN SELECT DISTINCT unnest(_inv.summon_character_ids) LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.summon_grants sg WHERE sg.summoner_character_id=_character_id
          AND sg.source_inventory_item_id=_inv.id AND sg.template_character_id=_id
      ) AND EXISTS(SELECT 1 FROM public.characters c WHERE c.id=_id AND NOT c.is_summon_snapshot) THEN
        INSERT INTO public.summon_grants
          (summoner_character_id,template_character_id,source_inventory_item_id,
           display_name,custom_stats,transfer_stats,borrowed_assignment_ids)
        SELECT _character_id,c.id,_inv.id,c.name||' · '||_inv.name,
          '{}'::jsonb,'{}'::jsonb,'{}'::uuid[]
        FROM public.characters c WHERE c.id=_id;
      END IF;
    END LOOP;
  END LOOP;
END;
$fn$;
REVOKE ALL ON FUNCTION public.sync_character_inventory_internal(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.inventory_set_equipped(_item_id uuid,_equipped boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='public'
AS $fn$
DECLARE _character uuid;
BEGIN
  SELECT i.character_id INTO _character FROM public.character_inventory i
  WHERE i.id=_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item não encontrado'; END IF;
  IF auth.uid() IS NULL OR NOT (
    public.has_role(auth.uid(),'master') OR
    EXISTS(SELECT 1 FROM public.characters c WHERE c.id=_character AND c.owner_id=auth.uid())
  ) THEN RAISE EXCEPTION 'Você não pode equipar itens desta ficha'; END IF;
  PERFORM 1 FROM public.characters WHERE id=_character FOR UPDATE;
  UPDATE public.character_inventory SET equipped=COALESCE(_equipped,false) WHERE id=_item_id;
  PERFORM public.sync_character_inventory_internal(_character);
  RETURN true;
END;
$fn$;
REVOKE ALL ON FUNCTION public.inventory_set_equipped(uuid,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.inventory_set_equipped(uuid,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.inventory_add_item(_character_id uuid,_template_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='public'
AS $fn$
DECLARE _slots integer;_slot integer;_new uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode entregar itens'; END IF;
  SELECT inventory_slots INTO _slots FROM public.characters WHERE id=_character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.item_templates WHERE id=_template_id) THEN
    RAISE EXCEPTION 'Item do catálogo não encontrado'; END IF;
  SELECT s.n INTO _slot FROM generate_series(1,_slots) s(n)
    WHERE NOT EXISTS (SELECT 1 FROM public.character_inventory i
      WHERE i.character_id=_character_id AND i.slot_index=s.n)
    ORDER BY s.n LIMIT 1;
  IF _slot IS NULL THEN RAISE EXCEPTION 'Inventário cheio'; END IF;
  INSERT INTO public.character_inventory(character_id,item_template_id,slot_index)
  VALUES (_character_id,_template_id,_slot) RETURNING id INTO _new;
  RETURN _new;
END;
$fn$;
REVOKE ALL ON FUNCTION public.inventory_add_item(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.inventory_add_item(uuid,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.inventory_remove_item(_item_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='public'
AS $fn$
DECLARE _character uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode remover itens'; END IF;
  SELECT character_id INTO _character FROM public.character_inventory WHERE id=_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item não encontrado'; END IF;
  PERFORM 1 FROM public.characters WHERE id=_character FOR UPDATE;
  UPDATE public.character_inventory SET equipped=false WHERE id=_item_id;
  PERFORM public.sync_character_inventory_internal(_character);
  DELETE FROM public.character_inventory WHERE id=_item_id;
  RETURN true;
END;
$fn$;
REVOKE ALL ON FUNCTION public.inventory_remove_item(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.inventory_remove_item(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.inventory_set_slots(_character_id uuid,_slots integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='public'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode alterar a capacidade'; END IF;
  IF _slots IS NULL OR _slots < 0 OR _slots > 200 THEN
    RAISE EXCEPTION 'A capacidade deve ser de 0 a 200 slots'; END IF;
  PERFORM 1 FROM public.characters WHERE id=_character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;
  IF EXISTS (SELECT 1 FROM public.character_inventory
    WHERE character_id=_character_id AND slot_index>_slots) THEN
    RAISE EXCEPTION 'Retire os itens dos slots acima do novo limite antes de reduzir'; END IF;
  UPDATE public.characters SET inventory_slots=_slots,updated_at=now() WHERE id=_character_id;
  RETURN _slots;
END;
$fn$;
REVOKE ALL ON FUNCTION public.inventory_set_slots(uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.inventory_set_slots(uuid,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_inventory_template_on_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='public'
AS $fn$
DECLARE _character uuid;
BEGIN
  FOR _character IN SELECT DISTINCT i.character_id FROM public.character_inventory i
    WHERE i.item_template_id=NEW.id AND i.equipped
  LOOP PERFORM public.sync_character_inventory_internal(_character); END LOOP;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.sync_inventory_template_on_update() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER inventory_template_refresh
AFTER UPDATE OF name,effects,ability_ids,transformation_ids,summon_character_ids
ON public.item_templates FOR EACH ROW EXECUTE FUNCTION public.sync_inventory_template_on_update();
