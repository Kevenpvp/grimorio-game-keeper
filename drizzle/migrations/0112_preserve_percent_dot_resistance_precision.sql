-- Preserve fractional percent values in percent-based DoTs; the final damage is rounded at tick time.
DO $patch$
DECLARE
  _definition text;
  _old text := '_new_damage := GREATEST(0, ROUND(_new_damage));';
  _new text := 'IF _dot_mode = ''percent'' THEN _new_damage := GREATEST(0, _new_damage); ELSE _new_damage := GREATEST(0, ROUND(_new_damage)); END IF;';
BEGIN
  SELECT pg_get_functiondef('public.apply_dot_resistance_before_insert()'::regprocedure)
  INTO _definition;

  IF position(_new IN _definition) > 0 THEN RETURN; END IF;
  IF position(_old IN _definition) = 0 THEN
    RAISE EXCEPTION 'Percent DoT precision anchor not found';
  END IF;

  _definition := replace(_definition, _old, _new);
  EXECUTE _definition;
END;
$patch$;
