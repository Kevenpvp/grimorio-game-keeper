-- Last compatibility guard: ordinary abilities without periodic rules must
-- not require a combat target, and reactivation clears obsolete stacks.
DO $patch$
DECLARE _sql text; _old text; _new text;
BEGIN
  SELECT pg_get_functiondef('public.begin_continuous_effects(uuid,uuid,uuid)'::regprocedure) INTO _sql;
  _old:='  IF _battle_id IS NULL OR _target_character_id IS NULL';
  _new:='  IF COALESCE(_ability.continuous_rules,''[]''::jsonb)=''[]''::jsonb THEN RETURN 0; END IF;
  IF _battle_id IS NULL OR _target_character_id IS NULL';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Continuous begin target check missing'; END IF;
  _sql:=replace(_sql,_old,_new);

  _old:='    INSERT INTO public.continuous_effect_instances
      (battle_id,character_ability_id,caster_character_id,target_character_id,rule_index,rule,name,ticks,active,last_tick_token)';
  _new:='    DELETE FROM public.battle_effects e
    WHERE e.battle_id=_battle_id AND (
       e.effect_data->>''continuous_instance_id'' IN (
         SELECT x.id::text FROM public.continuous_effect_instances x
         WHERE x.battle_id=_battle_id AND x.character_ability_id=_character_ability_id
           AND x.target_character_id=_target_character_id AND x.rule_index=_index)
       OR e.effect_data->>''continuous_source_id'' IN (
         SELECT x.id::text FROM public.continuous_effect_instances x
         WHERE x.battle_id=_battle_id AND x.character_ability_id=_character_ability_id
           AND x.target_character_id=_target_character_id AND x.rule_index=_index)
    );
    INSERT INTO public.continuous_effect_instances
      (battle_id,character_ability_id,caster_character_id,target_character_id,rule_index,rule,name,ticks,active,last_tick_token)';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Continuous begin insert changed'; END IF;
  EXECUTE replace(_sql,_old,_new);

  SELECT pg_get_functiondef('public.resolve_continuous_turn(uuid,uuid,jsonb)'::regprocedure) INTO _sql;
  _old:='_i.caster_character_id,NULL)';
  _new:='CASE WHEN _i.caster_character_id=_i.target_character_id THEN NULL::uuid ELSE _i.caster_character_id END,NULL)';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Continuous damage source not found'; END IF;
  EXECUTE replace(_sql,_old,_new);
END;
$patch$;