-- Finalize cooldown reduction for virtue-linked abilities and transformations.
-- The live activation functions already calculate _effective_cooldown at the beginning;
-- their final UPDATE used the base cooldown and overwrote that computed value.
DO $migration$
DECLARE
  _signature text;
  _definition text;
  _old text;
  _new text;
BEGIN
  FOREACH _signature IN ARRAY ARRAY[
    'public.activate_character_ability(uuid,uuid,uuid,integer,jsonb,jsonb)',
    'public.activate_character_ability_attack(uuid,uuid,uuid,integer,uuid[],jsonb,jsonb,jsonb)'
  ]
  LOOP
    SELECT pg_get_functiondef(to_regprocedure(_signature)) INTO _definition;
    IF _definition IS NULL THEN RAISE EXCEPTION 'Função de ativação não encontrada: %', _signature; END IF;
    _old := 'SET cooldown_remaining = _assignment.cooldown_turns';
    _new := 'SET cooldown_remaining = _effective_cooldown';
    IF position(_old IN _definition) > 0 THEN
      _definition := replace(_definition, _old, _new);
      EXECUTE _definition;
    END IF;
  END LOOP;

  -- Trait-linked personal transformations follow the same virtue mechanics as granted
  -- transformations: percentage cooldown reduction and numeric effect multiplication.
  SELECT pg_get_functiondef('public.activate_character_transformation(uuid,uuid,uuid)'::regprocedure)
  INTO _definition;
  IF _definition IS NULL THEN RAISE EXCEPTION 'Função de ativação de transformação não encontrada'; END IF;

  IF position('_effective_cooldown integer' IN _definition) = 0 THEN
    _definition := replace(
      _definition,
      '  _new_mana_max numeric;',
      '  _new_mana_max numeric;' || E'\n' ||
      '  _cooldown_virtue_id uuid;' || E'\n' ||
      '  _cooldown_factor numeric := 1;' || E'\n' ||
      '  _effective_cooldown integer := 0;' || E'\n' ||
      '  _virtue_multiplier numeric := 1;' || E'\n' ||
      '  _race_mechanics jsonb := ''{}''::jsonb;' || E'\n' ||
      '  _class_mechanics jsonb := ''{}''::jsonb;'
    );

    _old := $old$IF NOT FOUND THEN RAISE EXCEPTION 'Transformação não encontrada'; END IF;$old$;
    _new := $new$IF NOT FOUND THEN RAISE EXCEPTION 'Transformação não encontrada'; END IF;

   _cooldown_virtue_id := CASE

   _cooldown_virtue_id := CASE
     WHEN _transformation.linked_by_virtue_id = _character.virtue_id THEN _transformation.linked_by_virtue_id
     ELSE (
       SELECT vt.virtue_id
       FROM public.virtue_transformations vt
       WHERE vt.transformation_id = _transformation_id
         AND vt.virtue_id = _character.virtue_id
       LIMIT 1
     )
   END;
   SELECT COALESCE(r.special_mechanics, '{}'::jsonb), COALESCE(cl.special_mechanics, '{}'::jsonb)
   INTO _race_mechanics, _class_mechanics
   FROM public.characters c
   LEFT JOIN public.races r ON r.id = c.race_id
   LEFT JOIN public.classes cl ON cl.id = c.class_id
   WHERE c.id = _character_id;

   IF _cooldown_virtue_id IS NOT NULL THEN
     IF COALESCE(NULLIF(_race_mechanics->>'virtue_cooldown_reduction_percent', '')::numeric, 0) > 0 THEN
       _cooldown_factor := _cooldown_factor * (1 - LEAST(100, GREATEST(0, (_race_mechanics->>'virtue_cooldown_reduction_percent')::numeric)) / 100);
     END IF;
     IF COALESCE(NULLIF(_class_mechanics->>'virtue_cooldown_reduction_percent', '')::numeric, 0) > 0 THEN
       _cooldown_factor := _cooldown_factor * (1 - LEAST(100, GREATEST(0, (_class_mechanics->>'virtue_cooldown_reduction_percent')::numeric)) / 100);
     END IF;
   END IF;
   _effective_cooldown := GREATEST(0, FLOOR(_transformation.cooldown_turns * _cooldown_factor)::integer);

   IF _cooldown_virtue_id IS NOT NULL THEN
     IF COALESCE((_race_mechanics->>'duplicate_virtue_effects')::boolean, false)
        AND NOT COALESCE((_race_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_cooldown_virtue_id::text), false) THEN
       _virtue_multiplier := _virtue_multiplier * GREATEST(1, LEAST(10, COALESCE(NULLIF(_race_mechanics->>'virtue_effect_multiplier', '')::numeric, 2)));
     END IF;
     IF COALESCE((_class_mechanics->>'duplicate_virtue_effects')::boolean, false)
        AND NOT COALESCE((_class_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_cooldown_virtue_id::text), false) THEN
       _virtue_multiplier := _virtue_multiplier * GREATEST(1, LEAST(10, COALESCE(NULLIF(_class_mechanics->>'virtue_effect_multiplier', '')::numeric, 2)));
     END IF;
     _virtue_multiplier := GREATEST(1, LEAST(100, _virtue_multiplier));
     IF _virtue_multiplier > 1 THEN
       _transformation.effects := public.scale_racial_virtue_effect_json(COALESCE(_transformation.effects, '[]'::jsonb), _virtue_multiplier);
       _transformation.end_effects := public.scale_racial_virtue_effect_json(COALESCE(_transformation.end_effects, '[]'::jsonb), _virtue_multiplier);
     END IF;
   END IF;
$new$;

    IF position('virtue_cooldown_reduction_percent' IN _definition) = 0
       OR position('_effective_cooldown' IN _definition) = 0 THEN
      RAISE EXCEPTION 'Não foi possível inserir a mecânica de cooldown e duplicação na ativação da transformação';
    END IF;
  END IF;

  _definition := replace(
    _definition,
    '_character_id,_transformation_id,_transformation.cooldown_turns,_transformation.duration_turns,true,_battle_id,',
    '_character_id,_transformation_id,_effective_cooldown,_transformation.duration_turns,true,_battle_id,'
  );
  _definition := replace(
    _definition,
    '''cooldown_remaining'',_transformation.cooldown_turns',
    '''cooldown_remaining'',_effective_cooldown'
  );
  EXECUTE _definition;

  -- Scale the ending effects with the same currently selected virtue at the time it ends.
  SELECT pg_get_functiondef('public.end_character_transformation_internal(uuid,uuid,boolean)'::regprocedure)
  INTO _definition;
  IF _definition IS NULL THEN RAISE EXCEPTION 'Função de encerramento da transformação não encontrada'; END IF;
  IF position('_virtue_multiplier numeric' IN _definition) = 0 THEN
    _definition := replace(
      _definition,
      '  _new_mana_max numeric;',
      '  _new_mana_max numeric;' || E'\n' ||
      '  _character public.characters;' || E'\n' ||
      '  _transformation public.transformations;' || E'\n' ||
      '  _cooldown_virtue_id uuid;' || E'\n' ||
      '  _virtue_multiplier numeric := 1;' || E'\n' ||
      '  _race_mechanics jsonb := ''{}''::jsonb;' || E'\n' ||
      '  _class_mechanics jsonb := ''{}''::jsonb;'
    );
    _old := $endold$SELECT t.name,t.end_effects INTO _name,_end_effects
   FROM public.transformations t WHERE t.id=_transformation_id;$endold$;
    _new := $endnew$SELECT * INTO _character FROM public.characters WHERE id=_character_id;
   SELECT * INTO _transformation FROM public.transformations WHERE id=_transformation_id;
   _name := _transformation.name;
   _end_effects := COALESCE(_transformation.end_effects, '[]'::jsonb);
   _cooldown_virtue_id := CASE
     WHEN _transformation.linked_by_virtue_id = _character.virtue_id THEN _transformation.linked_by_virtue_id
     ELSE (
       SELECT vt.virtue_id FROM public.virtue_transformations vt
       WHERE vt.transformation_id=_transformation_id AND vt.virtue_id=_character.virtue_id LIMIT 1
     )
   END;
   SELECT COALESCE(r.special_mechanics, '{}'::jsonb), COALESCE(cl.special_mechanics, '{}'::jsonb)
   INTO _race_mechanics, _class_mechanics
   FROM public.characters c
   LEFT JOIN public.races r ON r.id=c.race_id
   LEFT JOIN public.classes cl ON cl.id=c.class_id
   WHERE c.id=_character_id;
   IF _cooldown_virtue_id IS NOT NULL THEN
     IF COALESCE((_race_mechanics->>'duplicate_virtue_effects')::boolean,false)
        AND NOT COALESCE((_race_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_cooldown_virtue_id::text),false) THEN
       _virtue_multiplier := _virtue_multiplier * GREATEST(1,LEAST(10,COALESCE(NULLIF(_race_mechanics->>'virtue_effect_multiplier','')::numeric,2)));
     END IF;
     IF COALESCE((_class_mechanics->>'duplicate_virtue_effects')::boolean,false)
        AND NOT COALESCE((_class_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_cooldown_virtue_id::text),false) THEN
       _virtue_multiplier := _virtue_multiplier * GREATEST(1,LEAST(10,COALESCE(NULLIF(_class_mechanics->>'virtue_effect_multiplier','')::numeric,2)));
     END IF;
     _virtue_multiplier := GREATEST(1,LEAST(100,_virtue_multiplier));
     IF _virtue_multiplier > 1 THEN
       _end_effects := public.scale_racial_virtue_effect_json(COALESCE(_end_effects,'[]'::jsonb),_virtue_multiplier);
     END IF;
   END IF;
$endnew$;
    IF position('scale_racial_virtue_effect_json(COALESCE(_end_effects' IN _definition) = 0 THEN
      RAISE EXCEPTION 'Não foi possível inserir a mecânica de duplicação nos efeitos de encerramento da transformação';
    END IF;
  END IF;
  EXECUTE _definition;
END;
$migration$;

-- The harmful flag is handled in the client and ability-runtime edge function. Keep the
-- stored attribute metadata unchanged, so costs/penalties are never accidentally magnified.
NOTIFY pgrst, 'reload schema';
