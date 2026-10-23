-- Preserve the effect editor's "until combat end" option for non-permanent manual effects.
DO $$
DECLARE
  _definition text;
  _old text;
BEGIN
  SELECT pg_get_functiondef('public.apply_manual_character_effects(uuid,uuid,uuid,jsonb,jsonb,boolean)'::regprocedure)
  INTO _definition;

  _old := $old$  _duration integer;$old$;
  IF position(_old in _definition) = 0 THEN RAISE EXCEPTION 'Não foi possível localizar a variável de duração'; END IF;
  _definition := replace(_definition, _old, $new$  _duration integer;
  _until_combat_end boolean;$new$);

  _old := $old$    _duration := CASE WHEN _permanent THEN 1 ELSE GREATEST(1,LEAST(1000,COALESCE(NULLIF(_effect->>'duration','')::integer,1))) END;$old$;
  IF position(_old in _definition) = 0 THEN RAISE EXCEPTION 'Não foi possível localizar o cálculo da duração'; END IF;
  _definition := replace(_definition, _old, $new$    _duration := CASE WHEN _permanent THEN 1 ELSE GREATEST(1,LEAST(1000,COALESCE(NULLIF(_effect->>'duration','')::integer,1))) END;
    _until_combat_end := NOT _permanent AND _target_battle_id IS NOT NULL
      AND COALESCE((_effect->>'until_combat_end')::boolean, false);$new$);

  _old := $old$_duration,'individual',false,_damage_scope,_reduction_scope$old$;
  IF position(_old in _definition) = 0 THEN RAISE EXCEPTION 'Não foi possível localizar os valores do efeito manual'; END IF;
  _definition := replace(_definition, _old, $new$_duration,'individual',_until_combat_end,_damage_scope,_reduction_scope$new$);

  EXECUTE _definition;
END $$;
