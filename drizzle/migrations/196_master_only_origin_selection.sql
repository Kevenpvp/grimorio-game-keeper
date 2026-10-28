-- Only the game master may assign, change or remove a character's Race,
-- Virtue or Class. Previous SECURITY DEFINER RPCs allowed a player to select
-- a missing trait once; all entry points must now reject non-master callers.
-- Character update RLS already allows mutations only to masters.
DO $migration$
DECLARE
  _signature text;
  _fn text;
  _needle text := chr(10) || 'BEGIN' || chr(10);
  _pos integer;
  _master_check text := chr(10) || 'BEGIN' || chr(10) ||
    '  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), ''master'') THEN' || chr(10) ||
    '    RAISE EXCEPTION ''Apenas o mestre pode escolher ou alterar Raça, Virtude e Classe'';' || chr(10) ||
    '  END IF;' || chr(10);
BEGIN
  FOREACH _signature IN ARRAY ARRAY[
    'public.choose_character_race(uuid,uuid)',
    'public.choose_character_virtue(uuid,uuid)',
    'public.choose_character_class(uuid,uuid)',
    'public.choose_character_class(uuid,uuid,jsonb)',
    'public.choose_character_traits(uuid,uuid,uuid)',
    'public.choose_race(uuid,uuid)'
  ]
  LOOP
    SELECT pg_get_functiondef(_signature::regprocedure) INTO _fn;
    _pos:=strpos(upper(_fn),_needle);
    IF _pos=0 THEN
      RAISE EXCEPTION 'Não foi possível localizar o início da função %',_signature;
    END IF;
    IF strpos(_fn, 'Apenas o mestre pode escolher ou alterar Raça, Virtude e Classe')>0 THEN
      CONTINUE;
    END IF;
    _fn:=overlay(_fn PLACING _master_check FROM _pos FOR length(_needle));
    EXECUTE _fn;
  END LOOP;
END;
$migration$;
