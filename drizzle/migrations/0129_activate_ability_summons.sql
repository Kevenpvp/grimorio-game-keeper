DO $patch$
DECLARE _old text;_patched text;_reg regprocedure;
BEGIN
  FOREACH _reg IN ARRAY ARRAY[
    'public.activate_character_ability(uuid,uuid,uuid,integer,jsonb,jsonb)'::regprocedure,
    'public.activate_character_ability_attack(uuid,uuid,uuid,integer,uuid[],jsonb,jsonb,jsonb)'::regprocedure
  ] LOOP
    SELECT pg_get_functiondef(_reg) INTO _old;
    IF POSITION('  return _effective_mana_cost;' IN _old)=0 THEN
      RAISE EXCEPTION 'Assinatura alterada de %',_reg;
    END IF;
    _patched := replace(_old,
      '  return _effective_mana_cost;',
      E'  -- Invoke configured creature templates as part of this paid activation.\n'
       || E'  IF _effective_battle_id IS NOT NULL THEN\n'
       || E'    PERFORM public.activate_ability_summons(_assignment.id,_effective_battle_id);\n'
       || E'  END IF;\n'
       || E'  return _effective_mana_cost;');
    EXECUTE _patched;
  END LOOP;
END;
$patch$;
NOTIFY pgrst,'reload schema';