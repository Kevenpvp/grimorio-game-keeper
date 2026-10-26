-- Support per-attribute one-off values in transformation activation dialogs.
DO $migration$
DECLARE
  _def text;
  _anchor text := '          IF _field.key NOT IN (';
  _addon text := $body$
          IF _field.key LIKE 'attribute_amount__%' THEN
            IF _template_effect->>'effect_type'<>'status'
              OR jsonb_typeof(_template_effect->'attribute_modifiers')<>'array'
              OR jsonb_typeof(_field.value)<>'number' THEN
              RAISE EXCEPTION 'Campo de atributo inválido na transformação';
            END IF;
            _field_value := (_field.value #>> '{}')::numeric;
            IF _field_value<0 OR _field_value>1000000 THEN RAISE EXCEPTION 'Valor de atributo inválido'; END IF;
            SELECT count(*), min(e.ordinality-1) INTO _attribute_matches,_attribute_index
            FROM jsonb_array_elements(_template_effect->'attribute_modifiers') WITH ORDINALITY e(value,ordinality)
            WHERE e.value->>'attribute_key'=substring(_field.key from length('attribute_amount__')+1);
            IF _attribute_matches<>1 THEN RAISE EXCEPTION 'Atributo não está presente no efeito'; END IF;
            _template_effect := jsonb_set(
              _template_effect,ARRAY['attribute_modifiers',_attribute_index::text,'amount'],_field.value,false
            );
            CONTINUE;
          END IF;
          IF _field.key NOT IN (
$body$;
BEGIN
  SELECT pg_get_functiondef('public.activate_character_transformation(uuid,uuid,uuid)'::regprocedure) INTO _def;
  IF position(_anchor in _def)=0 THEN RAISE EXCEPTION 'Formato original do validador mudou'; END IF;
  _def:=replace(_def, '  _field_max numeric;', E'  _field_max numeric;\n  _attribute_matches integer;\n  _attribute_index integer;');
  _def:=replace(_def,_anchor,_addon);
  EXECUTE _def;
END;
$migration$;