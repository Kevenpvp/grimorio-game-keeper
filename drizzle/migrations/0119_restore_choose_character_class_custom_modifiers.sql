-- Class picker sends the third _custom_modifiers argument; retain the existing
-- two-argument function as the validated class/point/HP implementation.
-- Only a master may set per-character class bonuses.
CREATE OR REPLACE FUNCTION public.choose_character_class(_character_id uuid, _class_id uuid, _custom_modifiers jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _is_master boolean := public.has_role(auth.uid(), 'master');
  _item record;
  _value numeric;
  _clean_modifiers jsonb := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;

  IF _custom_modifiers IS NULL OR jsonb_typeof(_custom_modifiers) <> 'object' THEN
    RAISE EXCEPTION 'Os bônus personalizados da classe devem ser um objeto JSON';
  END IF;

  -- The class picker sends {} when a regular player chooses their class.
  -- Only the master may assign character-specific stat bonuses.
  IF NOT _is_master AND _custom_modifiers <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Apenas o mestre pode definir bônus extras da classe';
  END IF;

  FOR _item IN SELECT key, value FROM jsonb_each(_custom_modifiers)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.attribute_definitions ad
      WHERE ad.key = _item.key AND ad.key NOT IN ('hp', 'mana')
    ) THEN
      RAISE EXCEPTION 'Atributo inválido para bônus extra da classe: %', _item.key;
    END IF;

    IF jsonb_typeof(_item.value) <> 'number' THEN
      RAISE EXCEPTION 'O bônus de % precisa ser um número inteiro', _item.key;
    END IF;
    _value := (_item.value #>> '{}')::numeric;
    IF _value < 0 OR _value > 1000000 OR trunc(_value) <> _value THEN
      RAISE EXCEPTION 'O bônus de % precisa ser um inteiro de 0 a 1.000.000', _item.key;
    END IF;

    IF _value > 0 THEN
      _clean_modifiers := _clean_modifiers || jsonb_build_object(_item.key, _value);
    END IF;
  END LOOP;

  -- Preserve existing class-change authorization, attribute point grants,
  -- class-related abilities/effects, and HP adjustments.
  PERFORM public.choose_character_class(_character_id, _class_id);

  -- Do not allow an ordinary player to overwrite custom bonuses.
  IF _is_master THEN
    UPDATE public.characters
    SET class_custom_modifiers =
      CASE WHEN _class_id IS NULL THEN '{}'::jsonb ELSE _clean_modifiers END
    WHERE id = _character_id
      AND class_custom_modifiers IS DISTINCT FROM
        CASE WHEN _class_id IS NULL THEN '{}'::jsonb ELSE _clean_modifiers END;
  END IF;
END;
$function$

REVOKE ALL ON FUNCTION public.choose_character_class(uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.choose_character_class(uuid,uuid,jsonb) TO authenticated;
NOTIFY pgrst,'reload schema';
