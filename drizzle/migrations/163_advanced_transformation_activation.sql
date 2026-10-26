-- Optional per-use advanced transformation controls for masters. Templates remain untouched.
CREATE OR REPLACE FUNCTION public.activate_character_transformation(_character_id uuid, _transformation_id uuid, _battle_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _character public.characters;
  _transformation public.transformations;
  _state public.character_transformations;
  _master boolean := public.has_role(auth.uid(),'master');
  _available boolean := false;
  _mana_current integer;
  _mana_max integer;
  _group_id uuid := gen_random_uuid();
  _mod record;
  _delta integer;
  _before integer;
  _after integer;
  _applied_body integer := 0;
  _applied_sanity integer := 0;
  _applied_modifiers jsonb := '{}'::jsonb;
  _old_hp_max numeric;
  _old_mana_max numeric;
  _new_hp_max numeric;
  _new_mana_max numeric;
  _cooldown_virtue_id uuid;
  _cooldown_factor numeric := 1;
  _effective_cooldown integer := 0;
  _virtue_multiplier numeric := 1;
  _race_mechanics jsonb := '{}'::jsonb;
  _class_mechanics jsonb := '{}'::jsonb;
  _activation_overrides jsonb := NULL;
  _override jsonb;
  _template_effect jsonb;
  _overridden_effects jsonb;
  _effect_position integer;
  _field record;
  _field_value numeric;
  _field_max numeric;
  _advanced jsonb;
  _advanced_requested boolean := false;
  _advanced_entry record;
  _n numeric;
  _numeric_value integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  SELECT * INTO _character FROM public.characters WHERE id=_character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;
  IF NOT _master AND _character.owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Só o dono da ficha pode ativar esta transformação';
  END IF;

  SELECT * INTO _transformation FROM public.transformations WHERE id=_transformation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transformação não encontrada'; END IF;

  -- Apply values for this activation only; never update the template.
  -- Optional advanced controls are guarded by the master-only RPC overload.
  -- Ordinary activation (3-argument call) uses all stored defaults.
  _activation_overrides := NULLIF(current_setting('grimorio.transformation_activation_overrides', true), '')::jsonb;
  IF _activation_overrides IS NOT NULL THEN
    IF jsonb_typeof(_activation_overrides) <> 'object'
      OR jsonb_typeof(COALESCE(_transformation.effects, '[]'::jsonb)) <> 'array' THEN
      RAISE EXCEPTION 'Modificadores temporários da transformação inválidos';
    END IF;
    IF _activation_overrides ? '__advanced' THEN
      IF NOT _master THEN
        RAISE EXCEPTION 'Apenas o mestre pode personalizar uma transformação';
      END IF;
      _advanced := _activation_overrides->'__advanced';
      IF jsonb_typeof(_advanced) <> 'object'
        OR EXISTS (SELECT 1 FROM jsonb_object_keys(_advanced) AS x(key)
          WHERE x.key NOT IN ('duration_turns','cooldown_turns','mana_cost','modifiers')) THEN
        RAISE EXCEPTION 'Opções avançadas da transformação inválidas';
      END IF;
      _advanced_requested := true;

      FOR _advanced_entry IN SELECT key, value FROM jsonb_each(_advanced)
      LOOP
        IF _advanced_entry.key = 'modifiers' THEN
          IF jsonb_typeof(_advanced_entry.value) <> 'object' THEN
            RAISE EXCEPTION 'Atributos avançados precisam ser um objeto';
          END IF;
          FOR _field IN SELECT key,value FROM jsonb_each(_advanced_entry.value)
          LOOP
            IF jsonb_typeof(_field.value) <> 'number'
              OR (_field.key NOT IN ('body','sanity')
                AND NOT EXISTS (SELECT 1 FROM public.attribute_definitions ad WHERE ad.key=_field.key))
            THEN RAISE EXCEPTION 'Atributo avançado inválido: %',_field.key; END IF;
            _n := (_field.value #>> '{}')::numeric;
            IF _n <> trunc(_n) OR _n < CASE WHEN _field.key IN ('body','sanity') THEN -100 ELSE -1000000 END
              OR _n > CASE WHEN _field.key IN ('body','sanity') THEN 100 ELSE 1000000 END
            THEN RAISE EXCEPTION 'Valor fora do limite no atributo %',_field.key; END IF;
          END LOOP;
          _transformation.modifiers := _advanced_entry.value;
        ELSE
          IF jsonb_typeof(_advanced_entry.value) <> 'number' THEN
            RAISE EXCEPTION 'Valor de duração, recarga ou Mana precisa ser numérico';
          END IF;
          _n := (_advanced_entry.value #>> '{}')::numeric;
          IF _n <> trunc(_n) THEN
            RAISE EXCEPTION 'Os valores avançados devem ser inteiros';
          END IF;
          IF _advanced_entry.key = 'duration_turns' THEN
            IF _n < 1 OR _n > 1000 THEN RAISE EXCEPTION 'Duração deve ter entre 1 e 1000 turnos'; END IF;
            _transformation.duration_turns := _n::integer;
          ELSIF _advanced_entry.key = 'cooldown_turns' THEN
            IF _n < 0 OR _n > 1000 THEN RAISE EXCEPTION 'Recarga deve ter entre 0 e 1000 turnos'; END IF;
            _transformation.cooldown_turns := _n::integer;
          ELSIF _advanced_entry.key = 'mana_cost' THEN
            IF _n < 0 OR _n > 1000000 THEN RAISE EXCEPTION 'Custo de Mana deve ter entre 0 e 1000000'; END IF;
            _transformation.mana_cost := _n::integer;
          END IF;
        END IF;
      END LOOP;
      _activation_overrides := _activation_overrides - '__advanced';
    END IF;

    _overridden_effects := '[]'::jsonb;
    _effect_position := 0;
    FOR _template_effect IN SELECT value
      FROM jsonb_array_elements(COALESCE(_transformation.effects, '[]'::jsonb))
    LOOP
      _override := _activation_overrides -> _effect_position::text;
      IF _override IS NOT NULL THEN
        IF (COALESCE((_template_effect->>'modify_on_activate')::boolean, false) IS DISTINCT FROM true AND NOT _advanced_requested)
          OR jsonb_typeof(_override) <> 'object' THEN
          RAISE EXCEPTION 'Este efeito não permite modificar valores ao ativar';
        END IF;
        FOR _field IN SELECT key,value FROM jsonb_each(_override)
        LOOP
          IF _field.key NOT IN (
            'amount','dot_resistance_amount',
            'healing_hp_amount','healing_mana_amount','healing_body_amount','healing_sanity_amount',
            'healing_reduce_debuff_turns_fixed','healing_reduce_debuff_turns_percent',
            'healing_relieve_debuff_percent','magic_healing_reversal_custom_damage'
          ) OR jsonb_typeof(_field.value) <> 'number' THEN
            RAISE EXCEPTION 'Campo de modificação não permitido na transformação';
          END IF;
          IF (
            (_field.key='amount' AND _template_effect->>'effect_type' NOT IN (
              'status','regeneration','mana_regeneration','mana_used','damage_dealt',
              'damage_reduction','damage_received','mental_control_chance','mental_control_resistance'
            ))
            OR (_field.key='dot_resistance_amount' AND _template_effect->>'effect_type'<>'dot_resistance')
            OR (_field.key LIKE 'healing_%' AND _template_effect->>'effect_type'<>'healing')
            OR (_field.key='magic_healing_reversal_custom_damage' AND _template_effect->>'effect_type'<>'magic_healing_reversal')
          ) THEN RAISE EXCEPTION 'Campo incompatível com o tipo do efeito'; END IF;
          _field_value := (_field.value #>> '{}')::numeric;
          _field_max := CASE WHEN _field.key IN (
            'healing_reduce_debuff_turns_percent','healing_relieve_debuff_percent'
          ) THEN 100 WHEN _field.key = 'healing_reduce_debuff_turns_fixed' THEN 1000
          WHEN _field.key = 'dot_resistance_amount' AND
            COALESCE(_template_effect->>'dot_resistance_value_mode','percent') = 'percent'
          THEN 100 WHEN _field.key IN ('healing_hp_amount','healing_mana_amount',
             'healing_body_amount','healing_sanity_amount') AND
             _template_effect ->> replace(_field.key,'_amount','_mode') = 'percent'
          THEN 100 ELSE 1000000 END;
          IF _field_value < 0 OR _field_value > _field_max THEN
            RAISE EXCEPTION 'Valor temporário fora do intervalo permitido';
          END IF;
          _template_effect := jsonb_set(_template_effect,ARRAY[_field.key],_field.value,true);
        END LOOP;
        _activation_overrides := _activation_overrides - _effect_position::text;
      END IF;
      _overridden_effects := _overridden_effects || jsonb_build_array(_template_effect);
      _effect_position := _effect_position + 1;
    END LOOP;
    IF _activation_overrides <> '{}'::jsonb THEN
      RAISE EXCEPTION 'O índice de um efeito modificado não existe na transformação';
    END IF;
    _transformation.effects := _overridden_effects;
  END IF;

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
     IF COALESCE(NULLIF(_race_mechanics->>'virtue_cooldown_reduction_percent', '')::numeric, 0) > 0 AND NOT COALESCE((_race_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_cooldown_virtue_id::text), false) THEN
       _cooldown_factor := _cooldown_factor * (1 - LEAST(100, GREATEST(0, (_race_mechanics->>'virtue_cooldown_reduction_percent')::numeric)) / 100);
     END IF;
     IF COALESCE(NULLIF(_class_mechanics->>'virtue_cooldown_reduction_percent', '')::numeric, 0) > 0 AND NOT COALESCE((_class_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_cooldown_virtue_id::text), false) THEN
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


  SELECT EXISTS (
    SELECT 1 FROM public.race_transformations rt WHERE rt.race_id=_character.race_id AND rt.transformation_id=_transformation_id
    UNION ALL
    SELECT 1 FROM public.virtue_transformations vt WHERE vt.virtue_id=_character.virtue_id AND vt.transformation_id=_transformation_id
    UNION ALL
    SELECT 1 FROM public.class_transformations ct WHERE ct.class_id=_character.class_id AND ct.transformation_id=_transformation_id
    UNION ALL
    SELECT 1 FROM public.transformations t WHERE t.id=_transformation_id AND t.owner_character_id=_character_id
  ) INTO _available;
  IF NOT _available AND NOT _master THEN
    RAISE EXCEPTION 'Esta transformação não pertence ao personagem nem foi concedida pela raça ou virtude';
  END IF;

  IF _battle_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.battles b JOIN public.battle_participants bp ON bp.battle_id=b.id
    WHERE b.id=_battle_id AND b.active IS TRUE AND bp.character_id=_character_id
  ) THEN
    RAISE EXCEPTION 'O personagem precisa estar em uma batalha ativa para se transformar';
  END IF;

  IF EXISTS (SELECT 1 FROM public.character_transformations ct WHERE ct.character_id=_character_id AND ct.active) THEN
    RAISE EXCEPTION 'O personagem já está transformado';
  END IF;

  SELECT * INTO _state FROM public.character_transformations
  WHERE character_id=_character_id AND transformation_id=_transformation_id FOR UPDATE;
  IF FOUND AND _state.cooldown_remaining>0 THEN
    RAISE EXCEPTION 'Transformação em cooldown: faltam % turno(s)',_state.cooldown_remaining;
  END IF;

  IF _transformation.mana_cost>0 THEN
    IF public.character_has_no_mana(_character_id) THEN RAISE EXCEPTION 'O personagem está sem acesso à Mana'; END IF;
    SELECT current_value INTO _mana_current FROM public.character_attributes
    WHERE character_id=_character_id AND attribute_key='mana' FOR UPDATE;
    _mana_max := public.calculate_character_resource_max(_character_id,'mana')::integer;
    IF COALESCE(_mana_current,0)<_transformation.mana_cost THEN
      RAISE EXCEPTION 'Mana insuficiente: necessário %, disponível %',_transformation.mana_cost,COALESCE(_mana_current,0);
    END IF;
    UPDATE public.character_attributes SET current_value=GREATEST(0,current_value-_transformation.mana_cost),updated_at=now()
    WHERE character_id=_character_id AND attribute_key='mana';
  END IF;

  -- Snapshot maxima before the transformation changes direct attribute bonuses.
  _old_hp_max := public.calculate_character_resource_max(_character_id, 'hp');
  _old_mana_max := public.calculate_character_resource_max(_character_id, 'mana');

  FOR _mod IN SELECT key,value FROM jsonb_each_text(COALESCE(_transformation.modifiers,'{}'::jsonb))
  LOOP
    IF COALESCE(_mod.value,'') !~ '^-?[0-9]+([.][0-9]+)?$' THEN RAISE EXCEPTION 'Modificador inválido: %',_mod.key; END IF;
    _delta := ROUND(_mod.value::numeric)::integer;
    IF _delta < -1000000 OR _delta > 1000000 THEN RAISE EXCEPTION 'Modificador fora do limite: %',_mod.key; END IF;

    IF _mod.key='body' THEN
      SELECT body INTO _before FROM public.characters WHERE id=_character_id;
      UPDATE public.characters SET body=GREATEST(0,LEAST(100,body+_delta)),updated_at=now()
      WHERE id=_character_id RETURNING body INTO _after;
      _applied_body := _after-_before;
    ELSIF _mod.key='sanity' THEN
      SELECT sanity INTO _before FROM public.characters WHERE id=_character_id;
      UPDATE public.characters SET sanity=GREATEST(0,LEAST(100,sanity+_delta)),updated_at=now()
      WHERE id=_character_id RETURNING sanity INTO _after;
      _applied_sanity := _after-_before;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM public.attribute_definitions WHERE key=_mod.key) THEN
        RAISE EXCEPTION 'Atributo desconhecido na transformação: %',_mod.key;
      END IF;
      UPDATE public.character_attributes
      SET bonus=bonus+_delta,updated_at=now()
      WHERE character_id=_character_id AND attribute_key=_mod.key;
      IF NOT FOUND THEN RAISE EXCEPTION 'Atributo % não existe na ficha',_mod.key; END IF;
      _applied_modifiers := _applied_modifiers || jsonb_build_object(_mod.key,_delta);
    END IF;
  END LOOP;

  -- Keep the same current/max ratio when direct transformation modifiers change HP/Mana max.
  _new_hp_max := public.calculate_character_resource_max(_character_id, 'hp');
  _new_mana_max := public.calculate_character_resource_max(_character_id, 'mana');
  PERFORM public.scale_character_resource_current(_character_id, 'hp', _old_hp_max, _new_hp_max);
  PERFORM public.scale_character_resource_current(_character_id, 'mana', _old_mana_max, _new_mana_max);

  INSERT INTO public.character_transformations(
    character_id,transformation_id,cooldown_remaining,active_duration_remaining,active,active_battle_id,
    active_effect_group_id,applied_attribute_modifiers,applied_body_delta,applied_sanity_delta,activated_at,updated_at
  ) VALUES (
    _character_id,_transformation_id,_effective_cooldown,_transformation.duration_turns,true,_battle_id,
    _group_id,_applied_modifiers,_applied_body,_applied_sanity,now(),now()
  )
  ON CONFLICT (character_id,transformation_id) DO UPDATE SET
    cooldown_remaining=EXCLUDED.cooldown_remaining,active_duration_remaining=EXCLUDED.active_duration_remaining,active=true,active_battle_id=EXCLUDED.active_battle_id,
    active_effect_group_id=EXCLUDED.active_effect_group_id,applied_attribute_modifiers=EXCLUDED.applied_attribute_modifiers,
    applied_body_delta=EXCLUDED.applied_body_delta,applied_sanity_delta=EXCLUDED.applied_sanity_delta,
    activated_at=now(),updated_at=now();

  PERFORM public.apply_character_transformation_effects(
    _character_id,_battle_id,_transformation_id,COALESCE(_transformation.effects,'[]'::jsonb),
    _group_id,false,_transformation.duration_turns
  );

  FOR _mod IN SELECT unnest(ARRAY['hp','mana']) AS key
  LOOP
    UPDATE public.character_attributes ca
    SET current_value=LEAST(ca.current_value,public.calculate_character_resource_max(_character_id,_mod.key)::integer),
        updated_at=now()
    WHERE ca.character_id=_character_id AND ca.attribute_key=_mod.key;
  END LOOP;

  RETURN jsonb_build_object('ok',true,'transformation_id',_transformation_id,'cooldown_remaining',_effective_cooldown,'duration_remaining',_transformation.duration_turns);
END;
$function$
;
