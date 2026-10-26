-- Preserve continuous rules (and registered script assignment) when a creature
-- is summoned or its abilities are borrowed. Repair existing snapshots with
-- empty rules without overwriting independently edited copies.
DO $patch$
DECLARE _fn text; _sql text; _old text; _new text;
BEGIN
  SELECT pg_get_functiondef('public.create_summon_instance(uuid,uuid,uuid,jsonb)'::regprocedure) INTO _sql;
  _old:='attack_enabled,attack_damage,attack_effect_groups,dot_effects,summon_template_ability_id,duration_turns,attack_mana_cost';
  _new:='attack_enabled,attack_damage,attack_effect_groups,dot_effects,summon_template_ability_id,duration_turns,attack_mana_cost,continuous_rules,custom_script_key';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Summon create INSERT fields changed'; END IF;
  _sql:=replace(_sql,_old,_new);
  _old:='ca.attack_enabled,ca.attack_damage,ca.attack_effect_groups,ca.dot_effects,ca.id,ca.duration_turns,ca.attack_mana_cost';
  _new:='ca.attack_enabled,ca.attack_damage,ca.attack_effect_groups,ca.dot_effects,ca.id,ca.duration_turns,ca.attack_mana_cost,ca.continuous_rules,ca.custom_script_key';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Summon create SELECT fields changed'; END IF;
  EXECUTE replace(_sql,_old,_new);

  SELECT pg_get_functiondef('public.sync_summon_borrowed_abilities()'::regprocedure) INTO _sql;
  _old:='source_summon_grant_id,attack_enabled,attack_damage,attack_effect_groups,dot_effects,duration_turns,attack_mana_cost';
  _new:='source_summon_grant_id,attack_enabled,attack_damage,attack_effect_groups,dot_effects,duration_turns,attack_mana_cost,continuous_rules,custom_script_key';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Summon borrowed INSERT fields changed'; END IF;
  _sql:=replace(_sql,_old,_new);
  _old:='ca.toggle_mode,NEW.id,ca.attack_enabled,ca.attack_damage,ca.attack_effect_groups,ca.dot_effects,ca.duration_turns,ca.attack_mana_cost';
  _new:='ca.toggle_mode,NEW.id,ca.attack_enabled,ca.attack_damage,ca.attack_effect_groups,ca.dot_effects,ca.duration_turns,ca.attack_mana_cost,ca.continuous_rules,ca.custom_script_key';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Summon borrowed SELECT fields changed'; END IF;
  EXECUTE replace(_sql,_old,_new);

  -- Multi-strike attacks activate recurring links on newly hit targets,
  -- without resetting the stack for targets already linked this session.
  SELECT pg_get_functiondef('public.repeat_character_ability_attack(uuid,uuid,uuid,integer,uuid[],jsonb,jsonb,jsonb)'::regprocedure) INTO _sql;
  _old:='  return 0;
end;';
  _new:=$body$
  IF _effective_battle_id IS NOT NULL AND _hit_target_ids IS NOT NULL
     AND COALESCE(_assignment.continuous_rules,'[]'::jsonb)<>'[]'::jsonb THEN
    FOR _hit_target_id IN SELECT DISTINCT unnest(_hit_target_ids) LOOP
      IF NOT EXISTS(
        SELECT 1 FROM public.continuous_effect_instances ci
        WHERE ci.battle_id=_effective_battle_id
          AND ci.character_ability_id=_assignment.id
          AND ci.target_character_id=_hit_target_id AND ci.active
      ) THEN
        PERFORM public.begin_continuous_effects(_effective_battle_id,_assignment.id,_hit_target_id);
      END IF;
    END LOOP;
  END IF;
  return 0;
end;$body$;
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Multi-strike attack ending changed'; END IF;
  EXECUTE replace(_sql,_old,_new);
END;
$patch$;

-- Existing creature copies created before these columns were supported.
UPDATE public.character_abilities copy
SET continuous_rules=template.continuous_rules
FROM public.character_abilities template
WHERE copy.summon_template_ability_id=template.id
  AND COALESCE(copy.continuous_rules,'[]'::jsonb)='[]'::jsonb
  AND template.continuous_rules<>'[]'::jsonb;

UPDATE public.character_abilities copy
SET custom_script_key=template.custom_script_key
FROM public.character_abilities template
WHERE copy.summon_template_ability_id=template.id
  AND copy.custom_script_key IS NULL AND template.custom_script_key IS NOT NULL;