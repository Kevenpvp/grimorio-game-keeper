-- Preserve per-character edits of skills, transformations and summons from an accessory.
-- The definition in item_templates remains shared; this JSON belongs only to
-- one specific inventory copy, and is not exposed for direct client updates.
ALTER TABLE public.character_inventory
  ADD COLUMN IF NOT EXISTS grant_customizations jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(grant_customizations)='object');

CREATE OR REPLACE FUNCTION public.inventory_snapshot_grant_customizations_internal(_item_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='public'
AS $fn$
BEGIN
  UPDATE public.character_inventory i
  SET grant_customizations = jsonb_build_object(
    'abilities',
      COALESCE(i.grant_customizations->'abilities','{}'::jsonb)
      || COALESCE((
        SELECT jsonb_object_agg(ca.ability_id::text,
          jsonb_build_object(
            'name',ca.name,'description',ca.description,
            'is_passive',ca.is_passive,'can_activate',ca.can_activate,
            'is_magical',ca.is_magical,'self_target_only',ca.self_target_only,
            'cooldown_turns',ca.cooldown_turns,'mana_cost',ca.mana_cost,
            'once_per_battle',ca.once_per_battle,'toggle_mode',ca.toggle_mode,
            'duration_turns',ca.duration_turns,'attack_mana_cost',ca.attack_mana_cost,
            'effects',ca.effects,'passive_effects',ca.passive_effects,
            'end_effects',ca.end_effects,'continuous_rules',ca.continuous_rules,
            'custom_attributes',ca.custom_attributes,'custom_script_key',ca.custom_script_key,
            'attack_enabled',ca.attack_enabled,'attack_damage',ca.attack_damage,
            'attack_effect_groups',ca.attack_effect_groups,'dot_effects',ca.dot_effects
          ))
        FROM public.character_abilities ca
        WHERE ca.source_inventory_item_id=i.id AND ca.ability_id IS NOT NULL
      ),'{}'::jsonb),
    'transformations',
      COALESCE(i.grant_customizations->'transformations','{}'::jsonb)
      || COALESCE((
        SELECT jsonb_object_agg(t.source_transformation_id::text,
          jsonb_build_object(
            'name',t.name,'description',t.description,
            'duration_turns',t.duration_turns,'cooldown_turns',t.cooldown_turns,
            'mana_cost',t.mana_cost,'modifiers',t.modifiers,
            'effects',t.effects,'end_effects',t.end_effects,
            'grants',COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'ability_id',ta.ability_id,'only_while_transformed',ta.only_while_transformed
              ) ORDER BY ta.ability_id)
              FROM public.transformation_abilities ta WHERE ta.transformation_id=t.id
            ),'[]'::jsonb),
            'image_path',(SELECT ct.image_path FROM public.character_transformations ct
              WHERE ct.character_id=i.character_id AND ct.transformation_id=t.id),
            'cooldown_remaining',(SELECT ct.cooldown_remaining FROM public.character_transformations ct
              WHERE ct.character_id=i.character_id AND ct.transformation_id=t.id)
          ))
        FROM public.transformations t
        WHERE t.source_inventory_item_id=i.id AND t.source_transformation_id IS NOT NULL
      ),'{}'::jsonb),
    'summons',
      COALESCE(i.grant_customizations->'summons','{}'::jsonb)
      || COALESCE((
        SELECT jsonb_object_agg(sg.template_character_id::text,
          jsonb_build_object(
            'display_name',sg.display_name,'custom_stats',sg.custom_stats,
            'transfer_stats',sg.transfer_stats,
            'borrowed_assignment_ids',to_jsonb(sg.borrowed_assignment_ids)
          ))
        FROM public.summon_grants sg WHERE sg.source_inventory_item_id=i.id
      ),'{}'::jsonb)
  )
  WHERE i.id=_item_id;
END;
$fn$;
REVOKE ALL ON FUNCTION public.inventory_snapshot_grant_customizations_internal(uuid)
  FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.inventory_restore_grant_customizations_internal(_item_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='public'
AS $fn$
DECLARE
  _settings jsonb;
  _character uuid;
  _entry record;
  _copy_id uuid;
  _active boolean;
BEGIN
  SELECT grant_customizations,character_id INTO _settings,_character
  FROM public.character_inventory WHERE id=_item_id AND equipped;
  IF NOT FOUND THEN RETURN; END IF;

  FOR _entry IN SELECT key,value FROM jsonb_each(COALESCE(_settings->'abilities','{}'::jsonb))
  LOOP
    UPDATE public.character_abilities ca SET
      name=COALESCE(_entry.value->>'name',ca.name),
      description=CASE WHEN _entry.value ? 'description' THEN _entry.value->>'description' ELSE ca.description END,
      is_passive=COALESCE((_entry.value->>'is_passive')::boolean,ca.is_passive),
      can_activate=COALESCE((_entry.value->>'can_activate')::boolean,ca.can_activate),
      is_magical=COALESCE((_entry.value->>'is_magical')::boolean,ca.is_magical),
      self_target_only=COALESCE((_entry.value->>'self_target_only')::boolean,ca.self_target_only),
      cooldown_turns=COALESCE((_entry.value->>'cooldown_turns')::integer,ca.cooldown_turns),
      mana_cost=COALESCE((_entry.value->>'mana_cost')::integer,ca.mana_cost),
      once_per_battle=COALESCE((_entry.value->>'once_per_battle')::boolean,ca.once_per_battle),
      toggle_mode=COALESCE((_entry.value->>'toggle_mode')::boolean,ca.toggle_mode),
      duration_turns=COALESCE((_entry.value->>'duration_turns')::integer,ca.duration_turns),
      attack_mana_cost=CASE WHEN _entry.value ? 'attack_mana_cost'
        THEN (_entry.value->>'attack_mana_cost')::integer ELSE ca.attack_mana_cost END,
      effects=COALESCE(_entry.value->'effects',ca.effects),
      passive_effects=COALESCE(_entry.value->'passive_effects',ca.passive_effects),
      end_effects=COALESCE(_entry.value->'end_effects',ca.end_effects),
      continuous_rules=COALESCE(_entry.value->'continuous_rules',ca.continuous_rules),
      custom_attributes=COALESCE(_entry.value->'custom_attributes',ca.custom_attributes),
      custom_script_key=CASE WHEN _entry.value ? 'custom_script_key'
        THEN _entry.value->>'custom_script_key' ELSE ca.custom_script_key END,
      attack_enabled=COALESCE((_entry.value->>'attack_enabled')::boolean,ca.attack_enabled),
      attack_damage=COALESCE(_entry.value->'attack_damage',ca.attack_damage),
      attack_effect_groups=COALESCE(_entry.value->'attack_effect_groups',ca.attack_effect_groups),
      dot_effects=COALESCE(_entry.value->'dot_effects',ca.dot_effects)
    WHERE ca.source_inventory_item_id=_item_id AND ca.ability_id=_entry.key::uuid
      AND ca.character_id=_character;
  END LOOP;

  FOR _entry IN SELECT key,value FROM jsonb_each(COALESCE(_settings->'transformations','{}'::jsonb))
  LOOP
    SELECT id INTO _copy_id FROM public.transformations
    WHERE source_inventory_item_id=_item_id
      AND owner_character_id=_character
      AND source_transformation_id=_entry.key::uuid;
    IF _copy_id IS NULL THEN CONTINUE; END IF;

    UPDATE public.transformations t SET
      name=COALESCE(_entry.value->>'name',t.name),
      description=CASE WHEN _entry.value ? 'description' THEN _entry.value->>'description' ELSE t.description END,
      duration_turns=COALESCE((_entry.value->>'duration_turns')::integer,t.duration_turns),
      cooldown_turns=COALESCE((_entry.value->>'cooldown_turns')::integer,t.cooldown_turns),
      mana_cost=COALESCE((_entry.value->>'mana_cost')::integer,t.mana_cost),
      modifiers=COALESCE(_entry.value->'modifiers',t.modifiers),
      effects=COALESCE(_entry.value->'effects',t.effects),
      end_effects=COALESCE(_entry.value->'end_effects',t.end_effects)
    WHERE t.id=_copy_id;

    IF jsonb_typeof(_entry.value->'grants')='array' THEN
      DELETE FROM public.transformation_abilities WHERE transformation_id=_copy_id;
      INSERT INTO public.transformation_abilities(transformation_id,ability_id,only_while_transformed)
      SELECT _copy_id,(g.value->>'ability_id')::uuid,
        COALESCE((g.value->>'only_while_transformed')::boolean,false)
      FROM jsonb_array_elements(_entry.value->'grants') AS g(value)
      JOIN public.abilities a ON a.id=(g.value->>'ability_id')::uuid
      ON CONFLICT DO NOTHING;
      SELECT active INTO _active FROM public.character_transformations
        WHERE character_id=_character AND transformation_id=_copy_id;
      PERFORM public.sync_transformation_ability_grants_for_character(
        _character,_copy_id,COALESCE(_active,false)
      );
    END IF;

    UPDATE public.character_transformations ct
      SET image_path=CASE WHEN _entry.value ? 'image_path'
            THEN _entry.value->>'image_path' ELSE ct.image_path END,
          cooldown_remaining=GREATEST(ct.cooldown_remaining,
            COALESCE((_entry.value->>'cooldown_remaining')::integer,0))
    WHERE ct.character_id=_character AND ct.transformation_id=_copy_id;
  END LOOP;

  FOR _entry IN SELECT key,value FROM jsonb_each(COALESCE(_settings->'summons','{}'::jsonb))
  LOOP
    UPDATE public.summon_grants sg SET
      display_name=COALESCE(_entry.value->>'display_name',sg.display_name),
      custom_stats=COALESCE(_entry.value->'custom_stats',sg.custom_stats),
      transfer_stats=COALESCE(_entry.value->'transfer_stats',sg.transfer_stats),
      borrowed_assignment_ids=CASE
        WHEN jsonb_typeof(_entry.value->'borrowed_assignment_ids')='array'
          THEN COALESCE(ARRAY(SELECT x::uuid
            FROM jsonb_array_elements_text(_entry.value->'borrowed_assignment_ids') AS x
            WHERE EXISTS(SELECT 1 FROM public.character_abilities ca WHERE ca.id=x::uuid)),
            '{}'::uuid[])
        ELSE sg.borrowed_assignment_ids END
    WHERE sg.source_inventory_item_id=_item_id AND sg.template_character_id=_entry.key::uuid
      AND sg.summoner_character_id=_character;
  END LOOP;
END;
$fn$;
REVOKE ALL ON FUNCTION public.inventory_restore_grant_customizations_internal(uuid)
  FROM PUBLIC,anon,authenticated;

-- Patch the existing RPC in-place, retaining the cooldown/once-per-combat
-- safeguards added in migration 185.
DO $patch$
DECLARE _fn text;_before text;_after text;
BEGIN
  SELECT pg_get_functiondef('public.inventory_set_equipped(uuid,boolean)'::regprocedure) INTO _fn;
  _before := E'  UPDATE public.character_inventory SET equipped=COALESCE(_equipped,false) WHERE id=_item_id;\n  PERFORM public.sync_character_inventory_internal(_character);';
  _after := E'  IF _was_equipped AND NOT COALESCE(_equipped,false) THEN\n    PERFORM public.inventory_snapshot_grant_customizations_internal(_item_id);\n  END IF;\n  UPDATE public.character_inventory SET equipped=COALESCE(_equipped,false) WHERE id=_item_id;\n  PERFORM public.sync_character_inventory_internal(_character);\n  IF NOT _was_equipped AND COALESCE(_equipped,false) THEN\n    PERFORM public.inventory_restore_grant_customizations_internal(_item_id);\n  END IF;';
  IF position(_before in _fn)=0 THEN
    RAISE EXCEPTION 'A função inventory_set_equipped mudou; revisão manual necessária';
  END IF;
  EXECUTE replace(_fn,_before,_after);
END;
$patch$;
