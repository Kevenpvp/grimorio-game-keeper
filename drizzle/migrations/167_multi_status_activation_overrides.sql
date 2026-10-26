-- Per-attribute overrides for status effects flagged "Modificar ao ativar".
-- This happens before the multi-attribute group is expanded to legacy entries.
DO $patch$
DECLARE
  _def text;
  _old text := '      _allowed:=false;';
  _inject text := $code$
      IF _type='status' AND _field LIKE 'attribute_amount__%' THEN
        IF jsonb_typeof(_value)<>'number' OR jsonb_typeof(_effect->'attribute_modifiers')<>'array' THEN
          RAISE EXCEPTION 'Valor de atributo inválido ao ativar';
        END IF;
        _number:=(_value#>>'{}')::numeric;
        IF _number<0 OR _number>1000000 THEN
          RAISE EXCEPTION 'Valor de atributo fora do limite';
        END IF;
        SELECT count(*) INTO _matches
        FROM jsonb_array_elements(_effect->'attribute_modifiers') item(value)
        WHERE item.value->>'attribute_key'=substring(_field from length('attribute_amount__')+1);
        IF _matches <> 1 THEN
          RAISE EXCEPTION 'Atributo não pertence a este efeito';
        END IF;
        SELECT item.ordinality-1 INTO _attribute_index
        FROM jsonb_array_elements(_effect->'attribute_modifiers') WITH ORDINALITY item(value,ordinality)
        WHERE item.value->>'attribute_key'=substring(_field from length('attribute_amount__')+1);
        _effect:=jsonb_set(_effect,ARRAY['attribute_modifiers',_attribute_index::text,'amount'],_value,false);
        CONTINUE;
      END IF;
      _allowed:=false;
$code$;
BEGIN
  SELECT pg_get_functiondef('public.apply_activation_effect_value_overrides(jsonb,jsonb)'::regprocedure) INTO _def;
  IF position(_old IN _def)=0 THEN RAISE EXCEPTION 'Original activation checker changed'; END IF;
  _def := replace(_def, '  _resource text;', E'  _resource text;\n  _matches integer;\n  _attribute_index integer;');
  -- Replace only the exact source code separator, not escaped delimiters.
  _def := replace(_def, _old, _inject);
  EXECUTE _def;
END;
$patch$;