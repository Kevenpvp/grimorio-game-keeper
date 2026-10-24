-- DoT resistance, per-trait cooldown reduction, custom trait-linked rows, and zero cooldown support.
BEGIN;

-- Add the new configurable DoT resistance effect to existing effect checks.
DO $checks$
DECLARE _definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO _definition
  FROM pg_constraint
  WHERE conrelid = 'public.battle_effects'::regclass AND conname = 'battle_effects_check';
  IF _definition IS NULL THEN RAISE EXCEPTION 'battle_effects_check not found'; END IF;
  IF position('dot_resistance' IN _definition) = 0 THEN
    _definition := replace(
      _definition,
      'OR (effect_type = ANY (ARRAY[''mind_control''::text',
      'OR ((effect_type = ''dot_resistance''::text) AND (attribute_key IS NULL) AND (polarity = ''buff''::text) AND (value_mode = ANY (ARRAY[''fixed''::text, ''percent''::text]))) OR (effect_type = ANY (ARRAY[''mind_control''::text'
    );
    IF position('dot_resistance' IN _definition) = 0 THEN RAISE EXCEPTION 'Failed to extend battle_effects_check'; END IF;
    ALTER TABLE public.battle_effects DROP CONSTRAINT battle_effects_check;
    EXECUTE format('ALTER TABLE public.battle_effects ADD CONSTRAINT battle_effects_check %s', _definition);
  END IF;

  SELECT pg_get_constraintdef(oid) INTO _definition
  FROM pg_constraint
  WHERE conrelid = 'public.battle_effects'::regclass AND conname = 'battle_effects_effect_type_check';
  IF _definition IS NULL THEN RAISE EXCEPTION 'battle_effects_effect_type_check not found'; END IF;
  IF position('dot_resistance' IN _definition) = 0 THEN
    _definition := replace(_definition, '''debuff_relief''::text])))', '''debuff_relief''::text, ''dot_resistance''::text])))');
    IF position('dot_resistance' IN _definition) = 0 THEN RAISE EXCEPTION 'Failed to extend battle_effects_effect_type_check'; END IF;
    ALTER TABLE public.battle_effects DROP CONSTRAINT battle_effects_effect_type_check;
    EXECUTE format('ALTER TABLE public.battle_effects ADD CONSTRAINT battle_effects_effect_type_check %s', _definition);
  END IF;
END;
$checks$;

-- Existing skills retain their configured values; an activation calculates the effective cooldown
-- using the race/class mechanics and stores the resulting remaining turns.
DO $activation_patch$
DECLARE
  _function record;
  _definition text;
  _activation_anchor text;
  _activation_code text;
  _resistance_anchor text;
  _resistance_code text;
BEGIN
  FOR _function IN
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('activate_character_ability', 'activate_character_ability_attack')
  LOOP
    _definition := pg_get_functiondef(_function.oid);

    IF position('_effective_cooldown integer' IN _definition) = 0 THEN
      _definition := replace(
        _definition,
        '  _effective_mana_cost integer := 0;',
        '  _effective_mana_cost integer := 0;' || E'\n' ||
        '  _effective_cooldown integer := 0;' || E'\n' ||
        '  _cooldown_factor numeric := 1;' || E'\n' ||
        '  _cooldown_virtue_id uuid;' || E'\n' ||
        '  _race_mechanics jsonb := ''{}''::jsonb;' || E'\n' ||
        '  _class_mechanics jsonb := ''{}''::jsonb;' || E'\n' ||
        '  _virtue_multiplier numeric := 1;'
      );
    END IF;

    _activation_anchor := '  if not found then raise exception ''Habilidade não encontrada nesta ficha''; end if;';
    IF position(_activation_anchor IN _definition) = 0 THEN
      RAISE EXCEPTION 'Assignment lookup anchor missing in %', _function.proname;
    END IF;

    IF position('_cooldown_virtue_id :=' IN _definition) = 0 THEN
      _activation_code := _activation_anchor || E'\n\n' ||
        '  _cooldown_virtue_id := COALESCE(_assignment.granted_by_virtue_id, _assignment.linked_by_virtue_id);' || E'\n' ||
        '  SELECT COALESCE(r.special_mechanics, ''{}''::jsonb), COALESCE(cl.special_mechanics, ''{}''::jsonb)' || E'\n' ||
        '  INTO _race_mechanics, _class_mechanics' || E'\n' ||
        '  FROM public.characters c' || E'\n' ||
        '  LEFT JOIN public.races r ON r.id = c.race_id' || E'\n' ||
        '  LEFT JOIN public.classes cl ON cl.id = c.class_id' || E'\n' ||
        '  WHERE c.id = _assignment.character_id;' || E'\n' ||
        '  IF _cooldown_virtue_id IS NOT NULL THEN' || E'\n' ||
        '    IF COALESCE(NULLIF(_race_mechanics->>''virtue_cooldown_reduction_percent'', '''')::numeric, 0) > 0 THEN' || E'\n' ||
        '      _cooldown_factor := _cooldown_factor * (1 - LEAST(100, GREATEST(0, (_race_mechanics->>''virtue_cooldown_reduction_percent'')::numeric)) / 100);' || E'\n' ||
        '    END IF;' || E'\n' ||
        '    IF COALESCE(NULLIF(_class_mechanics->>''virtue_cooldown_reduction_percent'', '''')::numeric, 0) > 0 THEN' || E'\n' ||
        '      _cooldown_factor := _cooldown_factor * (1 - LEAST(100, GREATEST(0, (_class_mechanics->>''virtue_cooldown_reduction_percent'')::numeric)) / 100);' || E'\n' ||
        '    END IF;' || E'\n' ||
        '  END IF;' || E'\n' ||
        '  _effective_cooldown := GREATEST(0, FLOOR(_assignment.cooldown_turns * _cooldown_factor)::integer);' || E'\n\n' ||
        '  IF _assignment.ability_id IS NULL AND _assignment.linked_by_virtue_id IS NOT NULL THEN' || E'\n' ||
        '    IF COALESCE((_race_mechanics->>''duplicate_virtue_effects'')::boolean, false) AND NOT COALESCE((_race_mechanics->''virtue_effect_blacklist'') @> jsonb_build_array(_assignment.linked_by_virtue_id::text), false) THEN' || E'\n' ||
        '      _virtue_multiplier := _virtue_multiplier * GREATEST(1, LEAST(10, COALESCE(NULLIF(_race_mechanics->>''virtue_effect_multiplier'', '''')::numeric, 2)));' || E'\n' ||
        '    END IF;' || E'\n' ||
        '    IF COALESCE((_class_mechanics->>''duplicate_virtue_effects'')::boolean, false) AND NOT COALESCE((_class_mechanics->''virtue_effect_blacklist'') @> jsonb_build_array(_assignment.linked_by_virtue_id::text), false) THEN' || E'\n' ||
        '      _virtue_multiplier := _virtue_multiplier * GREATEST(1, LEAST(10, COALESCE(NULLIF(_class_mechanics->>''virtue_effect_multiplier'', '''')::numeric, 2)));' || E'\n' ||
        '    END IF;' || E'\n' ||
        '    _virtue_multiplier := GREATEST(1, LEAST(100, _virtue_multiplier));' || E'\n' ||
        '    IF _virtue_multiplier > 1 THEN' || E'\n' ||
        '      _assignment.effects := public.scale_racial_virtue_effect_json(COALESCE(_assignment.effects, ''[]''::jsonb), _virtue_multiplier);' || E'\n' ||
        '      _assignment.passive_effects := public.scale_racial_virtue_effect_json(COALESCE(_assignment.passive_effects, ''[]''::jsonb), _virtue_multiplier);' || E'\n' ||
        '      _assignment.end_effects := public.scale_racial_virtue_effect_json(COALESCE(_assignment.end_effects, ''[]''::jsonb), _virtue_multiplier);' || E'\n' ||
        '    END IF;' || E'\n' ||
        '  END IF;';
      _definition := replace(_definition, _activation_anchor, _activation_code);
    END IF;

    _definition := replace(_definition, 'set cooldown_remaining = cooldown_turns', 'set cooldown_remaining = _effective_cooldown');
    _definition := replace(_definition, 'SET cooldown_remaining = cooldown_turns', 'SET cooldown_remaining = _effective_cooldown');

    _definition := replace(
      _definition,
      '''mental_control_resistance'',''dot_immunity'',''invisibility''',
      '''mental_control_resistance'',''dot_immunity'',''dot_resistance'',''invisibility'''
    );

    _resistance_anchor := '    elsif _effect_type IN (''mental_control_chance'',''mental_control_resistance'') then';
    IF position(_resistance_anchor IN _definition) = 0 THEN RAISE EXCEPTION 'Mental effect anchor missing in %', _function.proname; END IF;
    IF position('elsif _effect_type = ''dot_resistance'' then' IN _definition) = 0 THEN
      _resistance_code :=
        '    elsif _effect_type = ''dot_resistance'' then' || E'\n' ||
        '      _attribute_key := null;' || E'\n' ||
        '      _polarity := ''buff'';' || E'\n' ||
        '      _value_mode := coalesce(nullif(_effect->>''dot_resistance_value_mode'', ''''), _value_mode);' || E'\n' ||
        '      _amount := coalesce(nullif(_effect->>''dot_resistance_amount'', '''')::numeric, _amount);' || E'\n' ||
        '      IF _value_mode NOT IN (''fixed'', ''percent'') OR _amount < 0 OR (_value_mode = ''percent'' AND _amount > 100) OR (_value_mode = ''fixed'' AND _amount > 1000000) THEN' || E'\n' ||
        '        RAISE EXCEPTION ''Resistência a DoTs precisa ser um valor válido'';' || E'\n' ||
        '      END IF;' || E'\n' ||
        '      IF COALESCE(NULLIF(_effect->>''dot_resistance_scope'', ''''), ''all'') NOT IN (''all'', ''physical'', ''magical'', ''specific'') THEN' || E'\n' ||
        '        RAISE EXCEPTION ''Escopo da Resistência a DoTs inválido'';' || E'\n' ||
        '      END IF;' || E'\n' ||
        '      IF COALESCE(NULLIF(_effect->>''dot_resistance_mode'', ''''), ''damage'') NOT IN (''damage'', ''duration'') THEN' || E'\n' ||
        '        RAISE EXCEPTION ''Modo da Resistência a DoTs inválido'';' || E'\n' ||
        '      END IF;' || E'\n' ||
        '      IF COALESCE(NULLIF(_effect->>''dot_resistance_scope'', ''''), ''all'') = ''specific'' AND (jsonb_typeof(_effect->''dot_resistance_template_ids'') IS DISTINCT FROM ''array'' OR jsonb_array_length(_effect->''dot_resistance_template_ids'') = 0) THEN' || E'\n' ||
        '        RAISE EXCEPTION ''Selecione ao menos um DoT específico para a resistência'';' || E'\n' ||
        '      END IF;' || E'\n' ||
        _resistance_anchor;
      _definition := replace(_definition, _resistance_anchor, _resistance_code);
    END IF;

    EXECUTE _definition;
  END LOOP;
END;
$activation_patch$;

-- Apply resistance when a DoT enters a character: both active effects and passive ability effects count.
CREATE OR REPLACE FUNCTION public.apply_dot_resistance_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _resistance record;
  _damage_kind text;
  _template_id text;
  _scope text;
  _resistance_mode text;
  _value_mode text;
  _amount numeric;
  _new_damage numeric;
  _new_duration integer;
BEGIN
  IF NEW.effect_type <> 'damage_over_time' THEN RETURN NEW; END IF;

  _damage_kind := COALESCE(NULLIF(NEW.effect_data->>'damage_kind', ''), NEW.damage_scope, 'any');
  _template_id := NEW.effect_data->>'dot_template_id';
  _new_damage := CASE
    WHEN COALESCE(NEW.effect_data->>'damage_amount', '') ~ '^[0-9]+([.][0-9]+)?$'
      THEN (NEW.effect_data->>'damage_amount')::numeric
    ELSE NEW.amount
  END;
  _new_duration := NEW.duration;

  FOR _resistance IN
    SELECT sources.config
    FROM (
      SELECT e.effect_data AS config, e.created_at AS sort_at
      FROM public.battle_effects e
      WHERE e.character_id = NEW.character_id
        AND e.effect_type = 'dot_resistance'
        AND e.duration > 0
        AND (e.battle_id IS NULL OR NEW.battle_id IS NULL OR e.battle_id = NEW.battle_id)
      UNION ALL
      SELECT passive_effect.value AS config, ca.created_at AS sort_at
      FROM public.character_abilities ca
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ca.passive_effects, '[]'::jsonb)) passive_effect(value)
      WHERE ca.character_id = NEW.character_id
        AND passive_effect.value->>'effect_type' = 'dot_resistance'
    ) sources
    ORDER BY sources.sort_at
  LOOP
    _scope := COALESCE(NULLIF(_resistance.config->>'dot_resistance_scope', ''), 'all');
    IF _scope = 'physical' AND _damage_kind <> 'physical' THEN CONTINUE; END IF;
    IF _scope = 'magical' AND _damage_kind <> 'magical' THEN CONTINUE; END IF;
    IF _scope = 'specific' AND (
      _template_id IS NULL OR
      NOT COALESCE(_resistance.config->'dot_resistance_template_ids' @> jsonb_build_array(_template_id), false)
    ) THEN CONTINUE; END IF;

    _resistance_mode := COALESCE(NULLIF(_resistance.config->>'dot_resistance_mode', ''), 'damage');
    _value_mode := COALESCE(NULLIF(_resistance.config->>'dot_resistance_value_mode', ''), _resistance.config->>'value_mode', 'percent');
    _amount := COALESCE(NULLIF(_resistance.config->>'dot_resistance_amount', '')::numeric,
                        NULLIF(_resistance.config->>'amount', '')::numeric, 0);
    IF _amount <= 0 THEN CONTINUE; END IF;

    IF _resistance_mode = 'damage' THEN
      IF _value_mode = 'percent' THEN
        _new_damage := _new_damage * (1 - LEAST(100, GREATEST(0, _amount)) / 100);
      ELSE
        _new_damage := GREATEST(0, _new_damage - _amount);
      END IF;
      _new_damage := GREATEST(0, ROUND(_new_damage));
    ELSIF _resistance_mode = 'duration' THEN
      IF _value_mode = 'percent' THEN
        _new_duration := FLOOR(_new_duration * (1 - LEAST(100, GREATEST(0, _amount)) / 100))::integer;
      ELSE
        _new_duration := _new_duration - FLOOR(_amount)::integer;
      END IF;
      IF _new_duration <= 0 THEN RETURN NULL; END IF;
    END IF;
  END LOOP;

  NEW.duration := _new_duration;
  NEW.amount := _new_damage;
  NEW.effect_data := jsonb_set(COALESCE(NEW.effect_data, '{}'::jsonb), '{damage_amount}', to_jsonb(_new_damage), true);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS battle_effects_apply_dot_resistance ON public.battle_effects;
CREATE TRIGGER battle_effects_apply_dot_resistance
BEFORE INSERT ON public.battle_effects
FOR EACH ROW EXECUTE FUNCTION public.apply_dot_resistance_before_insert();

-- Character-linked creations are discarded when the character stops using the trait.
CREATE OR REPLACE FUNCTION public.remove_character_linked_trait_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  DELETE FROM public.character_abilities ca
  WHERE ca.character_id = NEW.id
    AND (
      (ca.linked_by_race_id IS NOT NULL AND ca.linked_by_race_id IS DISTINCT FROM NEW.race_id)
      OR (ca.linked_by_virtue_id IS NOT NULL AND ca.linked_by_virtue_id IS DISTINCT FROM NEW.virtue_id)
      OR (ca.linked_by_class_id IS NOT NULL AND ca.linked_by_class_id IS DISTINCT FROM NEW.class_id)
    );

  DELETE FROM public.transformations t
  WHERE t.owner_character_id = NEW.id
    AND (
      (t.linked_by_race_id IS NOT NULL AND t.linked_by_race_id IS DISTINCT FROM NEW.race_id)
      OR (t.linked_by_virtue_id IS NOT NULL AND t.linked_by_virtue_id IS DISTINCT FROM NEW.virtue_id)
      OR (t.linked_by_class_id IS NOT NULL AND t.linked_by_class_id IS DISTINCT FROM NEW.class_id)
    );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS characters_remove_linked_trait_items ON public.characters;
CREATE TRIGGER characters_remove_linked_trait_items
AFTER UPDATE OF race_id, virtue_id, class_id ON public.characters
FOR EACH ROW
WHEN (OLD.race_id IS DISTINCT FROM NEW.race_id OR OLD.virtue_id IS DISTINCT FROM NEW.virtue_id OR OLD.class_id IS DISTINCT FROM NEW.class_id)
EXECUTE FUNCTION public.remove_character_linked_trait_items();

-- Honour the Maléfico flag in the server-side Coração Corrompido attribute scaling.
DO $coracao$
DECLARE _definition text;
BEGIN
  SELECT pg_get_functiondef('public.sync_coracao_corrompido_strength_effect_internal(uuid,numeric)'::regprocedure) INTO _definition;
  _definition := replace(
    _definition,
    'WHERE lower(regexp_replace(coalesce(attr.value->>''key'', ''''), ''[^a-zA-Z0-9]'', '''', ''g'')) = ''forcabonus''' || E'\n' ||
    '        AND attr.value->>''type'' = ''number'';',
    'WHERE lower(regexp_replace(coalesce(attr.value->>''key'', ''''), ''[^a-zA-Z0-9]'', '''', ''g'')) = ''forcabonus''' || E'\n' ||
    '        AND attr.value->>''type'' = ''number''' || E'\n' ||
    '        AND COALESCE((attr.value->>''malefico'')::boolean, false) = false;'
  );
  EXECUTE _definition;
END;
$coracao$;

NOTIFY pgrst, 'reload schema';
COMMIT;
