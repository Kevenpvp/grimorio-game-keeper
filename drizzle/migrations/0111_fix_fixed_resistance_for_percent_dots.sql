-- Fixed DoT resistance is a flat damage reduction even when the DoT itself is percentage-based.
BEGIN;

DO $patch$
DECLARE
  _definition text;
  _old text;
  _new text;
BEGIN
  SELECT pg_get_functiondef('public.apply_dot_resistance_before_insert()'::regprocedure)
  INTO _definition;

  _old := $old$  _new_duration integer;
BEGIN$old$;
  _new := $new$  _new_duration integer;
  _dot_mode text;
  _fixed_damage_reduction numeric := 0;
BEGIN$new$;
  IF position(_old IN _definition) = 0 THEN
    IF position('_fixed_damage_reduction' IN _definition) = 0 THEN RAISE EXCEPTION 'DoT resistance declaration anchor not found'; END IF;
  ELSE
    _definition := replace(_definition, _old, _new);
  END IF;

  _old := $old$  _new_duration := NEW.duration;$old$;
  _new := $new$  _new_duration := NEW.duration;
  _dot_mode := COALESCE(NULLIF(NEW.effect_data->>'damage_mode', ''), 'fixed');$new$;
  IF position('_dot_mode := COALESCE' IN _definition) = 0 THEN
    IF position(_old IN _definition) = 0 THEN RAISE EXCEPTION 'DoT mode anchor not found'; END IF;
    _definition := replace(_definition, _old, _new);
  END IF;

  _old := $old$      IF _value_mode = 'percent' THEN
        _new_damage := _new_damage * (1 - LEAST(100, GREATEST(0, _amount)) / 100);
      ELSE
        _new_damage := GREATEST(0, _new_damage - _amount);
      END IF;
      _new_damage := GREATEST(0, ROUND(_new_damage));$old$;
  _new := $new$      IF _value_mode = 'percent' THEN
        _new_damage := _new_damage * (1 - LEAST(100, GREATEST(0, _amount)) / 100);
      ELSIF _dot_mode = 'percent' THEN
        _fixed_damage_reduction := _fixed_damage_reduction + FLOOR(_amount);
      ELSE
        _new_damage := GREATEST(0, _new_damage - _amount);
      END IF;
      _new_damage := GREATEST(0, ROUND(_new_damage));$new$;
  IF position('_fixed_damage_reduction := _fixed_damage_reduction + FLOOR(_amount)' IN _definition) = 0 THEN
    IF position(_old IN _definition) = 0 THEN RAISE EXCEPTION 'Fixed DoT reduction anchor not found'; END IF;
    _definition := replace(_definition, _old, _new);
  END IF;

  _old := $old$  NEW.effect_data := jsonb_set(COALESCE(NEW.effect_data, '{}'::jsonb), '{damage_amount}', to_jsonb(_new_damage), true);
  RETURN NEW;$old$;
  _new := $new$  NEW.effect_data := jsonb_set(COALESCE(NEW.effect_data, '{}'::jsonb), '{damage_amount}', to_jsonb(_new_damage), true);
  IF _dot_mode = 'percent' THEN
    NEW.effect_data := jsonb_set(NEW.effect_data, '{dot_fixed_damage_reduction}', to_jsonb(_fixed_damage_reduction), true);
  ELSE
    NEW.effect_data := NEW.effect_data - 'dot_fixed_damage_reduction';
  END IF;
  RETURN NEW;$new$;
  IF position('dot_fixed_damage_reduction' IN _definition) = 0 THEN
    IF position(_old IN _definition) = 0 THEN RAISE EXCEPTION 'Dot resistance metadata anchor not found'; END IF;
    _definition := replace(_definition, _old, _new);
  END IF;
  EXECUTE _definition;

  SELECT pg_get_functiondef('public.advance_combat_turn(uuid,uuid,jsonb)'::regprocedure)
  INTO _definition;

  _old := $old$      _dot_raw_damage := CEIL(GREATEST(0, COALESCE(_dot_hp_max, 0)) * _dot_amount / 100);
    ELSE
      _dot_raw_damage := FLOOR(_dot_amount);
    END IF;
    _dot_raw_damage := LEAST(1000000, GREATEST(0, COALESCE(_dot_raw_damage, 0)));$old$;
  _new := $new$      _dot_raw_damage := CEIL(GREATEST(0, COALESCE(_dot_hp_max, 0)) * _dot_amount / 100);
    ELSE
      _dot_raw_damage := FLOOR(_dot_amount);
    END IF;
    _dot_raw_damage := _dot_raw_damage - COALESCE(NULLIF(_dot_data->>'dot_fixed_damage_reduction', '')::numeric, 0);
    _dot_raw_damage := LEAST(1000000, GREATEST(0, COALESCE(_dot_raw_damage, 0)));$new$;
  IF position('dot_fixed_damage_reduction' IN _definition) = 0 THEN
    IF position(_old IN _definition) = 0 THEN RAISE EXCEPTION 'DoT turn damage calculation anchor not found'; END IF;
    _definition := replace(_definition, _old, _new);
  END IF;
  EXECUTE _definition;
END;
$patch$;

NOTIFY pgrst, 'reload schema';
COMMIT;
