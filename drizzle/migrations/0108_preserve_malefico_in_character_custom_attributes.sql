-- Preserve the catalog's Maléfico classification in per-character custom attribute overrides.
-- Without this, saving values in a sheet would discard the flag before the ability runtime reads it.
DO $migration$
DECLARE
  _definition text;
  _old text;
  _new text;
BEGIN
  SELECT pg_get_functiondef(
    'public.update_character_ability_custom_attributes(uuid,jsonb)'::regprocedure
  ) INTO _definition;

  _old := $old$_value := jsonb_build_object('key', _key, 'name', coalesce(_definition->>'name', _key), 'type', _type, 'value', to_jsonb(_number), 'scale_with_race', coalesce((_definition->>'scale_with_race')::boolean, true));$old$;
  _new := $new$_value := jsonb_build_object('key', _key, 'name', coalesce(_definition->>'name', _key), 'type', _type, 'value', to_jsonb(_number), 'scale_with_race', coalesce((_definition->>'scale_with_race')::boolean, true), 'malefico', coalesce((_definition->>'malefico')::boolean, false));$new$;

  IF position(_new IN _definition) = 0 THEN
    IF position(_old IN _definition) = 0 THEN
      RAISE EXCEPTION 'Não foi possível localizar a normalização de atributos personalizados';
    END IF;
    _definition := replace(_definition, _old, _new);
    EXECUTE _definition;
  END IF;
END;
$migration$;

NOTIFY pgrst, 'reload schema';
