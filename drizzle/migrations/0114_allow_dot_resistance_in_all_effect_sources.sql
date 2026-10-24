-- Make Resistência a DoTs available from all supported effect sources.
BEGIN;
DO $patch$
DECLARE _routine record; _body text; _replaced text; _old text; _new text;
BEGIN
 FOR _routine IN SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN
 ('sync_character_race_effects','sync_character_class_effects','sync_character_virtue_effects','apply_manual_character_effects')
 LOOP
  _body:=pg_get_functiondef(_routine.oid);
  _replaced:=regexp_replace(_body, '''dot_immunity''[[:space:]]*,[[:space:]]*''invisibility''',
    '''dot_immunity'',''dot_resistance'',''invisibility''','g');
  IF _replaced=_body AND position('''dot_resistance''' IN _body)=0 THEN
    RAISE EXCEPTION 'DoT effect list missing in %', _routine.proname;
  END IF;
  IF _replaced<>_body THEN EXECUTE _replaced; END IF;
 END LOOP;
 FOR _routine IN SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN
 ('apply_character_transformation_effects','trigger_damage_vulnerability_effects')
 LOOP
  _body:=pg_get_functiondef(_routine.oid);
  _old:='''healing_blocked'',''magic_healing_reversal''';
  _new:='''healing_blocked'',''magic_healing_reversal'',''dot_resistance''';
  IF position(_old IN _body)=0 AND position(_new IN _body)=0 THEN
    RAISE EXCEPTION 'DoT resistance insertion point missing in %', _routine.proname;
  END IF;
  IF position(_new IN _body)=0 THEN
    _replaced:=replace(_body,_old,_new);
    EXECUTE _replaced;
  END IF;
 END LOOP;
END;
$patch$;
-- Some legacy effects set all non-attribute amounts to zero during creation.
-- Recover the intended value from the original effect JSON prior to constraints.
CREATE OR REPLACE FUNCTION public.normalize_dot_resistance_before_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $function$
DECLARE
 _scope text; _mode text; _value_mode text; _amount numeric; _templates jsonb;
BEGIN
 IF NEW.effect_type IS DISTINCT FROM 'dot_resistance' THEN RETURN NEW; END IF;
 NEW.effect_data:=COALESCE(NEW.effect_data,'{}'::jsonb);
 _scope:=COALESCE(NULLIF(NEW.effect_data->>'dot_resistance_scope',''),'all');
 _mode:=COALESCE(NULLIF(NEW.effect_data->>'dot_resistance_mode',''),'damage');
 _value_mode:=COALESCE(NULLIF(NEW.effect_data->>'dot_resistance_value_mode',''),
   NULLIF(NEW.effect_data->>'value_mode',''), NEW.value_mode,'percent');
 _amount:=COALESCE(NULLIF(NEW.effect_data->>'dot_resistance_amount','')::numeric,
   NULLIF(NEW.effect_data->>'amount','')::numeric, NEW.amount,0);
 _templates:=COALESCE(NEW.effect_data->'dot_resistance_template_ids','[]'::jsonb);
 IF _scope NOT IN ('all','physical','magical','specific')
   OR _mode NOT IN ('damage','duration') THEN
   RAISE EXCEPTION 'Configuração de Resistência a DoTs inválida';
 END IF;
 IF _value_mode NOT IN ('fixed','percent') OR _amount IS NULL OR _amount<0
   OR (_value_mode='percent' AND _amount>100)
   OR (_value_mode='fixed' AND _amount>1000000) THEN
   RAISE EXCEPTION 'Valor de Resistência a DoTs inválido';
 END IF;
 IF jsonb_typeof(_templates) IS DISTINCT FROM 'array'
    OR (_scope='specific' AND jsonb_array_length(_templates)=0) THEN
   RAISE EXCEPTION 'Selecione os DoTs específicos para a resistência';
 END IF;
 NEW.attribute_key:=NULL;
 NEW.polarity:='buff';
 NEW.value_mode:=_value_mode;
 NEW.amount:=_amount;
 NEW.effect_data:=NEW.effect_data || jsonb_build_object(
  'dot_resistance_scope',_scope, 'dot_resistance_mode',_mode,
  'dot_resistance_value_mode',_value_mode,
  'dot_resistance_amount',_amount,
  'dot_resistance_template_ids',_templates
 );
 RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS normalize_dot_resistance_before_insert ON public.battle_effects;
CREATE TRIGGER normalize_dot_resistance_before_insert BEFORE INSERT
ON public.battle_effects FOR EACH ROW
EXECUTE FUNCTION public.normalize_dot_resistance_before_insert();
REVOKE ALL ON FUNCTION public.normalize_dot_resistance_before_insert() FROM PUBLIC, anon, authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;