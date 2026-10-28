-- JSONB string elements include quotes when cast to text.
-- Extract the string contents before UUID casting.
DO $patch$
DECLARE _fn text;
BEGIN
  SELECT pg_get_functiondef('public.activate_character_ability(uuid,uuid,uuid,integer,jsonb,jsonb)'::regprocedure) INTO _fn;
  IF position('selected.value::text::uuid' IN _fn)=0 THEN
    RAISE EXCEPTION 'O parse dos UUIDs mudou; confira o fluxo de ativação em vários alvos';
  END IF;
  EXECUTE replace(_fn,'selected.value::text::uuid','(selected.value #>> ''{}'')::uuid');
END;
$patch$;