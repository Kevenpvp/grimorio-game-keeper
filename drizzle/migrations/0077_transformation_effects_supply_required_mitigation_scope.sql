-- battle_effects.damage_reduction_scope is NOT NULL even for effects whose
-- type is not damage_reduction, so transformation effects must still supply it.
CREATE OR REPLACE FUNCTION public.apply_character_transformation_effects(_character_id uuid, _battle_id uuid, _transformation_id uuid, _effects jsonb, _effect_group_id uuid, _is_end_effect boolean, _active_duration integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _effect jsonb;
  _effect_type text;
  _insert_type text;
  _attribute_key text;
  _polarity text;
  _value_mode text;
  _amount numeric;
  _duration integer;
  _damage_scope text;
  _damage_reduction_scope text;
  _damage_reduction_type_id uuid;
  _damage_reduction_magic_level text;
  _damage_reduction_type_ids uuid[];
  _damage_reduction_magic_levels text[];
  _healing_timing text;
  _name text;
  _effect_data jsonb;
  _group_count integer := 0;
BEGIN
  IF jsonb_typeof(COALESCE(_effects, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Lista de efeitos da transformação inválida';
  END IF;

  FOR _effect IN SELECT value FROM jsonb_array_elements(COALESCE(_effects, '[]'::jsonb))
  LOOP
    _effect_data := NULL;
    _effect_type := NULLIF(_effect->>'effect_type','');
    IF _effect_type IS NULL OR _effect_type NOT IN (
      'status','regeneration','mana_regeneration','mana_used','no_regen_hp','no_regen_mana',
      'stun','magic_prohibition','damage_dealt','damage_reduction','damage_received',
      'damage_vulnerability','no_mana','healing','invincible','healing_blocked','magic_healing_reversal'
    ) THEN
      RAISE EXCEPTION 'Tipo de efeito inválido na transformação';
    END IF;

    _insert_type := _effect_type;
    _attribute_key := NULLIF(_effect->>'attribute_key','');
    _polarity := COALESCE(NULLIF(_effect->>'polarity',''), 'buff');
    _value_mode := COALESCE(NULLIF(_effect->>'value_mode',''), 'fixed');
    _amount := COALESCE(NULLIF(_effect->>'amount','')::numeric, 0);
    _duration := CASE
      WHEN COALESCE(_effect->>'duration','') ~ '^[0-9]+$' THEN LEAST(1000,GREATEST(1,(_effect->>'duration')::integer))
      ELSE 1
    END;
    _damage_scope := COALESCE(NULLIF(_effect->>'damage_scope',''), 'any');
    _damage_reduction_scope := COALESCE(NULLIF(_effect->>'damage_reduction_scope',''), 'physical');
    _damage_reduction_type_id := NULL;
    _damage_reduction_magic_level := NULL;
    _damage_reduction_type_ids := ARRAY[]::uuid[];
    _damage_reduction_magic_levels := ARRAY[]::text[];
    _healing_timing := COALESCE(NULLIF(_effect->>'healing_timing',''), 'instant');
    _name := COALESCE(NULLIF(_effect->>'name',''), _effect_type);

    IF _polarity NOT IN ('buff','debuff') OR _value_mode NOT IN ('fixed','percent') OR _amount < 0 OR _amount > 1000000 THEN
      RAISE EXCEPTION 'Valor ou polaridade inválida no efeito de transformação';
    END IF;

    IF _effect_type = 'status' THEN
      IF _attribute_key IS NULL OR NOT EXISTS (SELECT 1 FROM public.attribute_definitions d WHERE d.key = _attribute_key) THEN
        RAISE EXCEPTION 'Buff/debuff de transformação precisa de um atributo válido';
      END IF;
    ELSIF _effect_type = 'regeneration' THEN
      IF _attribute_key NOT IN ('hp','mana') THEN RAISE EXCEPTION 'Regeneração só pode afetar HP ou Mana'; END IF;
    ELSIF _effect_type = 'mana_regeneration' THEN
      _insert_type := 'regeneration';
      _attribute_key := 'mana';
    ELSIF _effect_type = 'mana_used' THEN
      _attribute_key := NULL;
    ELSIF _effect_type = 'damage_dealt' THEN
      _attribute_key := NULL;
      IF jsonb_typeof(_effect->'damage_dealt_physical_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_dealt_physical_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value AND dt.category = 'physical')
      ) THEN RAISE EXCEPTION 'Dano Causado contém um tipo físico inválido'; END IF;
    ELSIF _effect_type = 'damage_reduction' THEN
      IF _polarity <> 'buff' THEN RAISE EXCEPTION 'Mitigação de dano só pode ser um buff'; END IF;
      _attribute_key := NULL;
      IF _damage_reduction_scope NOT IN ('physical','magical') THEN RAISE EXCEPTION 'Categoria de mitigação inválida'; END IF;

      IF jsonb_typeof(_effect->'damage_reduction_type_ids') = 'array' THEN
        SELECT COALESCE(array_agg(value::uuid),ARRAY[]::uuid[]) INTO _damage_reduction_type_ids
        FROM jsonb_array_elements_text(_effect->'damage_reduction_type_ids') selected(value);
      ELSIF NULLIF(_effect->>'damage_reduction_type_id','') IS NOT NULL THEN
        _damage_reduction_type_ids := ARRAY[(_effect->>'damage_reduction_type_id')::uuid];
      END IF;

      IF cardinality(_damage_reduction_type_ids) > 0 AND EXISTS (
        SELECT 1 FROM unnest(_damage_reduction_type_ids) selected(id)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id = selected.id AND dt.category = _damage_reduction_scope)
      ) THEN RAISE EXCEPTION 'Tipo de dano inválido na mitigação'; END IF;

      IF jsonb_typeof(_effect->'damage_reduction_magic_levels') = 'array' THEN
        SELECT COALESCE(array_agg(value),ARRAY[]::text[]) INTO _damage_reduction_magic_levels
        FROM jsonb_array_elements_text(_effect->'damage_reduction_magic_levels') selected(value);
      ELSIF NULLIF(_effect->>'damage_reduction_magic_level','') IN ('baixa','media','alta') THEN
        _damage_reduction_magic_levels := ARRAY[_effect->>'damage_reduction_magic_level'];
      END IF;
      IF EXISTS (SELECT 1 FROM unnest(_damage_reduction_magic_levels) lv WHERE lv NOT IN ('baixa','media','alta')) THEN
        RAISE EXCEPTION 'Grau mágico inválido na mitigação';
      END IF;
    ELSIF _effect_type = 'damage_received' THEN
      _attribute_key := NULL;
      _polarity := 'debuff';
      IF COALESCE(NULLIF(_effect->>'damage_received_scope',''),'any') NOT IN ('any','physical','magical','race') THEN
        RAISE EXCEPTION 'Escopo de Dano Recebido inválido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'damage_received_scope',''),'any') = 'race'
        AND NOT EXISTS (SELECT 1 FROM public.races r WHERE r.id::text = _effect->>'damage_received_race_id') THEN
        RAISE EXCEPTION 'Selecione uma raça válida para Dano Recebido';
      END IF;
    ELSIF _effect_type = 'damage_vulnerability' THEN
      IF _attribute_key IS NULL OR NOT EXISTS (SELECT 1 FROM public.attribute_definitions d WHERE d.key=_attribute_key) THEN
        RAISE EXCEPTION 'Vulnerabilidade de Dano precisa de um atributo válido';
      END IF;
    ELSIF _effect_type IN ('healing_blocked','magic_healing_reversal') THEN
      _attribute_key := NULL;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'debuff';
      IF _effect_type = 'magic_healing_reversal' THEN _insert_type := 'healing_blocked'; END IF;
    ELSIF _effect_type = 'healing' THEN
      _attribute_key := NULL;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
      IF _healing_timing NOT IN ('instant','per_turn') THEN RAISE EXCEPTION 'Modo de cura inválido'; END IF;
      _effect_data := _effect || jsonb_build_object(
        '_runtime_healer_character_id', _character_id,
        'source_transformation_id', _transformation_id,
        'transformation_end_effect', _is_end_effect
      );
      IF _healing_timing = 'instant' THEN
        PERFORM public.apply_ability_healing(_character_id, _battle_id, _effect_data, true, true);
        _group_count := _group_count + 1;
        CONTINUE;
      END IF;
    ELSIF _effect_type = 'invincible' THEN
      _attribute_key := NULL;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
    ELSIF _effect_type IN ('no_mana','magic_prohibition') THEN
      _attribute_key := NULL;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'debuff';
      _damage_scope := 'any';
    ELSE
      _attribute_key := NULL;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
    END IF;

    IF _effect_type = 'healing' AND _healing_timing = 'per_turn' THEN
      _insert_type := 'healing';
    END IF;

    _effect_data := COALESCE(_effect_data, _effect) || jsonb_build_object(
      'source_transformation_id', _transformation_id,
      'transformation_end_effect', _is_end_effect
    );
    INSERT INTO public.battle_effects (
      battle_id,character_id,name,effect_type,attribute_key,polarity,value_mode,amount,
      duration,until_combat_end,duration_scope,source_character_ability_id,effect_group_id,
      is_end_effect,damage_scope,damage_reduction_scope,damage_reduction_type_id,
      damage_reduction_magic_level,damage_reduction_type_ids,damage_reduction_magic_levels,
      target_character_id,effect_data
    ) VALUES (
      CASE WHEN _is_end_effect THEN _battle_id ELSE _battle_id END,
      _character_id,
      'Transformação: ' || _name,
      _insert_type,
      _attribute_key,
      _polarity,
      _value_mode,
      _amount,
      CASE WHEN _is_end_effect THEN _duration ELSE GREATEST(1,COALESCE(_active_duration,1)) END,
      CASE WHEN _is_end_effect THEN COALESCE(NULLIF(_effect->>'until_combat_end','')::boolean,false) ELSE true END,
      'global',
      NULL,
      _effect_group_id,
      _is_end_effect,
      _damage_scope,
      _damage_reduction_scope,
      _damage_reduction_type_id,
      _damage_reduction_magic_level,
      CASE WHEN _insert_type='damage_reduction' THEN _damage_reduction_type_ids ELSE NULL END,
      CASE WHEN _insert_type='damage_reduction' THEN _damage_reduction_magic_levels ELSE NULL END,
      _character_id,
      _effect_data
    );
    _group_count := _group_count + 1;
  END LOOP;
  RETURN _group_count;
END;
$function$
;
