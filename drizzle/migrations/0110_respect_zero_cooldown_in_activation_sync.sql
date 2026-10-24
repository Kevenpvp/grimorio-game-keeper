-- The activation-field trigger must not silently turn a valid zero cooldown back into one.
DO $migration$
DECLARE
  _definition text;
  _old text := 'if new.cooldown_turns < 1 then new.cooldown_turns := 1; end if;';
  _new text := 'if new.cooldown_turns < 0 then new.cooldown_turns := 0; end if;';
BEGIN
  SELECT pg_get_functiondef('public.sync_ability_activation_fields()'::regprocedure)
  INTO _definition;

  IF position(_old IN _definition) = 0 THEN
    IF position(_new IN _definition) > 0 THEN RETURN; END IF;
    RAISE EXCEPTION 'Could not find cooldown normalization in sync_ability_activation_fields';
  END IF;

  _definition := replace(_definition, _old, _new);
  EXECUTE _definition;
END;
$migration$;
