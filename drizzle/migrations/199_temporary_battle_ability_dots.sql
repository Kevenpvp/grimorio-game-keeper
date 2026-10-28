-- Temporary combat ability overrides now support guaranteed registered DoTs.
-- Preserve the normal DoT catalog, damage calculations and master-only checks.
-- One-use overrides must remain available until the DoT application is done.
DO $migration$
DECLARE
  _fn text;
  _before text;
  _after text;
  _name text;
  _signature text;
BEGIN
  SELECT pg_get_functiondef('public.apply_character_ability_dots(uuid,uuid,jsonb,jsonb)'::regprocedure) INTO _fn;
  _before := $frag$  IF jsonb_typeof(_guaranteed_dots) IS DISTINCT FROM 'array'
     OR jsonb_typeof(_attack_groups) IS DISTINCT FROM 'array' THEN$frag$;
  _after := $frag$  -- Prefer this battle's DoT list to the original ability list, if present.
  -- Even an explicit empty list means removing the default DoTs temporarily.
  SELECT bo.override_values->'dot_effects' INTO _current_guaranteed_dots
  FROM public.battle_ability_overrides bo
  WHERE bo.battle_id=_battle_id AND bo.character_ability_id=_character_ability_id
    AND jsonb_typeof(bo.override_values->'dot_effects')='array';
  IF FOUND THEN
    IF jsonb_array_length(_current_guaranteed_dots)>100 THEN
      RAISE EXCEPTION 'Limite de 100 DoTs temporários por habilidade';
    END IF;
    _guaranteed_dots:=_current_guaranteed_dots;
  END IF;

$frag$ || _before;
  IF strpos(_fn,_before)=0 THEN
    RAISE EXCEPTION 'O processamento de DoTs mudou e precisa ser revisado';
  END IF;
  EXECUTE replace(_fn,_before,_after);

  FOREACH _name IN ARRAY ARRAY['activate_character_ability','activate_character_ability_attack'] LOOP
    _signature := CASE WHEN _name='activate_character_ability'
      THEN 'public.activate_character_ability(uuid,uuid,uuid,integer,jsonb,jsonb)'
      ELSE 'public.activate_character_ability_attack(uuid,uuid,uuid,integer,uuid[],jsonb,jsonb,jsonb)' END;
    SELECT pg_get_functiondef(_signature::regprocedure) INTO _fn;
    _before := $frag$  if _effective_battle_id is not null then
    delete from public.battle_ability_overrides
    where battle_id = _effective_battle_id
      and character_ability_id = _assignment.id
      and keep_after_use = false;
  end if;

  PERFORM public.apply_character_ability_dots(_assignment.id, _effective_battle_id, _dot_target_selections, _dot_attribute_values);$frag$;
    _after := $frag$  -- Apply the DoT override before consuming this one-use battle edit.
  PERFORM public.apply_character_ability_dots(_assignment.id, _effective_battle_id, _dot_target_selections, _dot_attribute_values);

  if _effective_battle_id is not null then
    delete from public.battle_ability_overrides
    where battle_id = _effective_battle_id
      and character_ability_id = _assignment.id
      and keep_after_use = false;
  end if;$frag$;
    IF strpos(_fn,_before)=0 THEN
      RAISE EXCEPTION 'A ordem de consumo de alterações mudou em %',_name;
    END IF;
    EXECUTE replace(_fn,_before,_after);
  END LOOP;
END;
$migration$;