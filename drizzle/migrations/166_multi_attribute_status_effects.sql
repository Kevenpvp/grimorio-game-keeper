-- One configurable attribute buff/debuff may include several per-attribute values.
-- Expand only at application/calc boundaries; original ability and trait JSON
-- stays a single editable effect. Legacy single-attribute effects stay identical.
CREATE OR REPLACE FUNCTION public.expand_attribute_effects(_effects jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $fn$
DECLARE
  _effect jsonb;
  _modifier jsonb;
  _result jsonb := '[]'::jsonb;
  _items jsonb;
  _key text;
  _label text;
  _amount numeric;
  _mode text;
  _seen text[];
BEGIN
  IF _effects IS NULL THEN RETURN '[]'::jsonb; END IF;
  IF jsonb_typeof(_effects) <> 'array' THEN
    RAISE EXCEPTION 'Efeitos precisam ser uma lista';
  END IF;
  IF jsonb_array_length(_effects) > 250 THEN
    RAISE EXCEPTION 'Lista de efeitos excede o limite';
  END IF;
  FOR _effect IN SELECT value FROM jsonb_array_elements(_effects) LOOP
    _items := _effect->'attribute_modifiers';
    IF COALESCE(_effect->>'effect_type','') <> 'status' OR jsonb_typeof(_items) IS DISTINCT FROM 'array'
      OR jsonb_array_length(_items) = 0 THEN
      _result := _result || jsonb_build_array(_effect);
      CONTINUE;
    END IF;
    IF jsonb_array_length(_items) > 48 THEN RAISE EXCEPTION 'Muitos atributos no mesmo efeito'; END IF;
    _seen := ARRAY[]::text[];
    FOR _modifier IN SELECT value FROM jsonb_array_elements(_items) LOOP
      _key := _modifier->>'attribute_key';
      _mode := _modifier->>'value_mode';
      IF _key IS NULL OR _key = ANY(_seen) OR _mode NOT IN ('fixed','percent')
        OR jsonb_typeof(_modifier->'amount') IS DISTINCT FROM 'number'
        OR NOT EXISTS (SELECT 1 FROM public.attribute_definitions d WHERE d.key=_key) THEN
        RAISE EXCEPTION 'Atributo, modo ou valor inválido no efeito múltiplo';
      END IF;
      _amount := (_modifier->>'amount')::numeric;
      IF _amount < 0 OR _amount > 1000000 THEN
        RAISE EXCEPTION 'Valor de status fora do limite';
      END IF;
      SELECT label INTO _label FROM public.attribute_definitions WHERE key=_key;
      _seen := array_append(_seen,_key);
      _result := _result || jsonb_build_array(
        (_effect - 'attribute_modifiers') ||
        jsonb_build_object(
          'attribute_key',_key,
          'value_mode',_mode,
          'amount',_amount,
          'name',COALESCE(NULLIF(_effect->>'name',''),'Efeito') || ' · ' || COALESCE(_label,_key)
        )
      );
    END LOOP;
  END LOOP;
  RETURN _result;
END;
$fn$;

-- All insertion paths use existing legacy status validators and storage.
-- Expand at the point where an effect list is iterated, preserving the existing
-- combat, race/virtue/class permanent, end, transformation and manual behavior.
DO $migration$
DECLARE
  _entry record;
  _src text;
  _old text;
  _new text;
  _pattern text;
BEGIN
  FOR _entry IN SELECT proname,oid FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname IN (
      'activate_character_ability','activate_character_ability_attack','repeat_character_ability_attack',
      'apply_character_ability_end_effects','apply_character_transformation_effects',
      'apply_manual_character_effects','sync_character_race_effects','sync_character_class_effects',
      'sync_character_virtue_effects','trigger_damage_vulnerability_effects',
      'calculate_character_resource_max','calculate_character_effective_defense'
    )
  LOOP
    _src := pg_get_functiondef(_entry.oid);
    _old := NULL;
    IF _entry.proname IN ('activate_character_ability','activate_character_ability_attack','repeat_character_ability_attack') THEN
      _old := 'jsonb_array_elements(coalesce(_assignment.effects, ''[]''::jsonb))';
      _new := 'jsonb_array_elements(public.expand_attribute_effects(coalesce(_assignment.effects, ''[]''::jsonb)))';
    ELSIF _entry.proname='apply_character_ability_end_effects' THEN
      _old := 'jsonb_array_elements(coalesce(_end_effects, ''[]''::jsonb))';
      _new := 'jsonb_array_elements(public.expand_attribute_effects(coalesce(_end_effects, ''[]''::jsonb)))';
    ELSIF _entry.proname='apply_character_transformation_effects' THEN
      _old := 'jsonb_array_elements(COALESCE(_effects, ''[]''::jsonb))';
      _new := 'jsonb_array_elements(public.expand_attribute_effects(COALESCE(_effects, ''[]''::jsonb)))';
    ELSIF _entry.proname IN ('apply_manual_character_effects','trigger_damage_vulnerability_effects') THEN
      _old := 'jsonb_array_elements(COALESCE(_effects,''[]''::jsonb))';
      _new := 'jsonb_array_elements(public.expand_attribute_effects(COALESCE(_effects,''[]''::jsonb)))';
      IF position(_old in _src)=0 THEN
        _old := 'jsonb_array_elements(COALESCE(_effects, ''[]''::jsonb))';
        _new := 'jsonb_array_elements(public.expand_attribute_effects(COALESCE(_effects, ''[]''::jsonb)))';
      END IF;
    ELSIF _entry.proname IN ('sync_character_race_effects','sync_character_virtue_effects','sync_character_class_effects') THEN
      _old := 'jsonb_array_elements(COALESCE(_starting_effects, ''[]''::jsonb))';
      _new := 'jsonb_array_elements(public.expand_attribute_effects(COALESCE(_starting_effects, ''[]''::jsonb)))';
    END IF;
    IF _old IS NOT NULL THEN
      IF position(_old in _src)=0 THEN
        RAISE EXCEPTION 'Função % não possui ponto de inserção esperado',_entry.proname;
      END IF;
      _src := replace(_src,_old,_new);
    END IF;
    IF _entry.proname='activate_character_ability_attack' OR _entry.proname='repeat_character_ability_attack' THEN
      _old := 'jsonb_array_elements(_attack_group->''effects'')';
      _new := 'jsonb_array_elements(public.expand_attribute_effects(_attack_group->''effects''))';
      IF position(_old in _src)=0 THEN RAISE EXCEPTION 'Efeitos de grupo não encontrados para %',_entry.proname; END IF;
      _src := replace(_src,_old,_new);
    END IF;
    IF _entry.proname IN ('activate_character_ability','activate_character_ability_attack','repeat_character_ability_attack') THEN
      _old := 'jsonb_array_elements(ca.passive_effects)';
      _new := 'jsonb_array_elements(public.expand_attribute_effects(ca.passive_effects))';
      IF position(_old in _src)>0 THEN _src := replace(_src,_old,_new); END IF;
    END IF;
    IF _entry.proname='calculate_character_resource_max' THEN
      FOR _pattern IN SELECT unnest(ARRAY[
        'coalesce(ca.passive_effects, ''[]''::jsonb)',
        'coalesce(_extra_active_effects, ''[]''::jsonb)',
        'coalesce(_extra_passive_effects, ''[]''::jsonb)'
      ]) LOOP
        _old := 'jsonb_array_elements('||_pattern||')';
        _new := 'jsonb_array_elements(public.expand_attribute_effects('||_pattern||'))';
        IF position(_old in _src)=0 THEN RAISE EXCEPTION 'Fonte de HP/Mana ausente: %',_pattern; END IF;
        _src := replace(_src,_old,_new);
      END LOOP;
    END IF;
    IF _entry.proname='calculate_character_effective_defense' THEN
      _old := 'THEN ca.passive_effects ELSE';
      _new := 'THEN public.expand_attribute_effects(ca.passive_effects) ELSE';
      IF position(_old in _src)=0 THEN RAISE EXCEPTION 'Passivas de defesa não localizadas'; END IF;
      _src := replace(_src,_old,_new);
    END IF;
    EXECUTE _src;
  END LOOP;
END;
$migration$;