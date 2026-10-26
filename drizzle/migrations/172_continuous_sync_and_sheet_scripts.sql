-- Sync reusable periodic rules to character-granted catalog skills.
-- Sheet-exclusive skills may keep their own configuration.
CREATE OR REPLACE FUNCTION public.copy_continuous_rules_to_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
BEGIN
  IF NEW.ability_id IS NOT NULL AND
    (NEW.continuous_rules IS NULL OR NEW.continuous_rules='[]'::jsonb) THEN
    SELECT continuous_rules INTO NEW.continuous_rules FROM public.abilities WHERE id=NEW.ability_id;
    NEW.continuous_rules:=COALESCE(NEW.continuous_rules,'[]'::jsonb);
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS copy_continuous_rules_to_assignment ON public.character_abilities;
CREATE TRIGGER copy_continuous_rules_to_assignment BEFORE INSERT ON public.character_abilities
FOR EACH ROW EXECUTE FUNCTION public.copy_continuous_rules_to_assignment();

CREATE OR REPLACE FUNCTION public.refresh_continuous_rules_from_catalog() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
BEGIN
  UPDATE public.character_abilities ca SET continuous_rules=NEW.continuous_rules
  WHERE ca.ability_id=NEW.id AND ca.continuous_rules IS NOT DISTINCT FROM OLD.continuous_rules;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS refresh_continuous_rules_from_catalog ON public.abilities;
CREATE TRIGGER refresh_continuous_rules_from_catalog AFTER UPDATE OF continuous_rules ON public.abilities
FOR EACH ROW WHEN (OLD.continuous_rules IS DISTINCT FROM NEW.continuous_rules)
EXECUTE FUNCTION public.refresh_continuous_rules_from_catalog();

-- Only pre-reviewed server scripts can be selected on a personal sheet skill.
ALTER TABLE public.character_abilities ADD COLUMN IF NOT EXISTS custom_script_key text;
ALTER TABLE public.character_abilities DROP CONSTRAINT IF EXISTS custom_sheet_script_allowed;
ALTER TABLE public.character_abilities ADD CONSTRAINT custom_sheet_script_allowed
 CHECK (custom_script_key IS NULL OR custom_script_key IN
 ('example','demonio_interno','coracao_corrompido','sedento_por_sangue'));

-- Script event queue keeps global catalog script precedence while allowing
-- personal skills (ability_id IS NULL) to have a trusted script key.
DO $patch$
DECLARE _name text;_src text;_old text;_new text;
BEGIN
  SELECT pg_get_functiondef('public.queue_ability_script_event(text,uuid,uuid,uuid,uuid,uuid,jsonb)'::regprocedure) INTO _src;
  _old:='SELECT a.id, a.custom_script_key
  INTO _ability_id, _script_key
  FROM public.character_abilities ca
  JOIN public.abilities a ON a.id = ca.ability_id';
  _new:='SELECT a.id, COALESCE(ca.custom_script_key,a.custom_script_key)
  INTO _ability_id, _script_key
  FROM public.character_abilities ca
  LEFT JOIN public.abilities a ON a.id = ca.ability_id';
  IF position(_old in _src)=0 THEN RAISE EXCEPTION 'Script queue source changed'; END IF;
  EXECUTE replace(_src,_old,_new);

  FOR _name IN SELECT unnest(ARRAY[
    'enqueue_turn_script_events','enqueue_effect_script_events','enqueue_active_sedento_hp_change',
    'reset_demonio_interno_heat_on_battle_end'
  ])
  LOOP
    SELECT pg_get_functiondef(oid) INTO _src FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname=_name;
    IF _src IS NULL THEN RAISE EXCEPTION 'Script hook function absent: %',_name; END IF;
    _src:=replace(_src,'JOIN public.abilities a ON a.id = ca.ability_id','LEFT JOIN public.abilities a ON a.id = ca.ability_id');
    _src:=replace(_src,'JOIN public.abilities a ON a.id=ca.ability_id','LEFT JOIN public.abilities a ON a.id=ca.ability_id');
    _src:=replace(_src,'a.custom_script_key','COALESCE(ca.custom_script_key,a.custom_script_key)');
    EXECUTE _src;
  END LOOP;

  -- The damage-over-time hook also queries script definitions on assignment.
  SELECT pg_get_functiondef('public.advance_combat_turn(uuid,uuid,jsonb)'::regprocedure) INTO _src;
  _src:=replace(_src,'JOIN public.abilities a ON a.id = ca.ability_id','LEFT JOIN public.abilities a ON a.id = ca.ability_id');
  _src:=replace(_src,'NULLIF(TRIM(a.custom_script_key),','NULLIF(TRIM(COALESCE(ca.custom_script_key,a.custom_script_key)),');
  EXECUTE _src;

  SELECT pg_get_functiondef(oid) INTO _src FROM pg_proc
  WHERE pronamespace='public'::regnamespace AND proname='queue_coracao_corrompido_cooldown_exit';
  _old:='SELECT a.custom_script_key
    INTO _script_key
    FROM public.abilities a
    WHERE a.id = NEW.ability_id;';
  _new:='SELECT COALESCE(NEW.custom_script_key,a.custom_script_key)
    INTO _script_key
    FROM (SELECT 1) AS one LEFT JOIN public.abilities a ON a.id=NEW.ability_id;';
  IF position(_old in _src)>0 THEN EXECUTE replace(_src,_old,_new); END IF;
END;
$patch$;

-- Make existing catalogue assignments receive the current rules where
-- no per-character configuration was saved.
UPDATE public.character_abilities ca SET continuous_rules=a.continuous_rules
FROM public.abilities a
WHERE ca.ability_id=a.id AND ca.continuous_rules='[]'::jsonb
  AND a.continuous_rules<>'[]'::jsonb;