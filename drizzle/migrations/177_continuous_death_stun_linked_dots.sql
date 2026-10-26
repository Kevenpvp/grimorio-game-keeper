-- Optional automatic interruption on death or stun; tagged DoTs cleanly dissipate.
DO $patch$
DECLARE _sql text;_old text;_new text;
BEGIN
  SELECT pg_get_functiondef('public.apply_ability_dot_effect_internal(uuid,uuid,text,uuid,jsonb,jsonb)'::regprocedure) INTO _sql;
  _old:='  _dot_id text;';
  _new:='  _continuous_id text;
  _dot_id text;';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'DoT declaration changed'; END IF;
  _sql:=replace(_sql,_old,_new);
  _old:='  _dot := public.resolve_registered_ability_dot(_dot);';
  _new:='  _continuous_id := NULLIF(_dot->>''continuous_instance_id'','''');
  _dot := public.resolve_registered_ability_dot(_dot);';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'DoT resolution changed'; END IF;
  _sql:=replace(_sql,_old,_new);
  _old:='      ''fixed_damage'', _fixed_damage
    ),';
  _new:='      ''fixed_damage'', _fixed_damage,
      ''continuous_instance_id'',_continuous_id
    ),';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'DoT effect metadata changed'; END IF;
  EXECUTE replace(_sql,_old,_new);

  SELECT pg_get_functiondef('public.resolve_continuous_turn(uuid,uuid,jsonb)'::regprocedure) INTO _sql;
  _old:='              ''duration'',COALESCE((_override->>''duration'')::integer,(_action->>''duration'')::integer,2)';
  _new:='              ''duration'',COALESCE((_override->>''duration'')::integer,(_action->>''duration'')::integer,2),
              ''continuous_instance_id'',_i.id::text';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'DoT periodic metadata anchor changed'; END IF;
  EXECUTE replace(_sql,_old,_new);
END;
$patch$;

CREATE OR REPLACE FUNCTION public.autostop_continuous_on_caster_death() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
DECLARE _item record;
BEGIN
  IF NEW.attribute_key='hp' AND OLD.current_value>0 AND NEW.current_value<=0 THEN
    FOR _item IN SELECT ci.id FROM public.continuous_effect_instances ci
      JOIN public.battles b ON b.id=ci.battle_id AND b.active
      WHERE ci.caster_character_id=NEW.character_id AND ci.active
        AND COALESCE((ci.rule->>'stop_on_caster_death')::boolean,false) LOOP
      PERFORM public.finish_continuous_instance_internal(_item.id,false);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS autostop_continuous_on_caster_death ON public.character_attributes;
CREATE TRIGGER autostop_continuous_on_caster_death
AFTER UPDATE OF current_value ON public.character_attributes
FOR EACH ROW WHEN (NEW.attribute_key='hp' AND OLD.current_value>0 AND NEW.current_value<=0)
EXECUTE FUNCTION public.autostop_continuous_on_caster_death();

CREATE OR REPLACE FUNCTION public.autostop_continuous_on_caster_stun() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
DECLARE _item record;
BEGIN
  IF NEW.effect_type='stun' THEN
    FOR _item IN SELECT ci.id FROM public.continuous_effect_instances ci
      WHERE ci.active AND ci.battle_id=NEW.battle_id
        AND ci.caster_character_id=NEW.character_id
        AND COALESCE((ci.rule->>'stop_on_caster_stun')::boolean,false) LOOP
      PERFORM public.finish_continuous_instance_internal(_item.id,false);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS autostop_continuous_on_caster_stun ON public.battle_effects;
CREATE TRIGGER autostop_continuous_on_caster_stun
AFTER INSERT ON public.battle_effects
FOR EACH ROW WHEN (NEW.effect_type='stun')
EXECUTE FUNCTION public.autostop_continuous_on_caster_stun();

-- Caster death/stun already present when processing the turn also resolves according to rule.
DO $patch$
DECLARE _sql text;_old text;_new text;
BEGIN
  SELECT pg_get_functiondef('public.resolve_continuous_turn(uuid,uuid,jsonb)'::regprocedure) INTO _sql;
  _old:='    _choice:=_choices->_i.id::text;';
  _new:=$body$
    IF (COALESCE((_i.rule->>'stop_on_caster_death')::boolean,false) AND EXISTS(
      SELECT 1 FROM public.character_attributes a
      WHERE a.character_id=_i.caster_character_id AND a.attribute_key='hp' AND a.current_value<=0))
      OR (COALESCE((_i.rule->>'stop_on_caster_stun')::boolean,false) AND EXISTS(
      SELECT 1 FROM public.battle_effects e WHERE e.battle_id=_battle_id
        AND e.character_id=_i.caster_character_id AND e.effect_type='stun'))
    THEN
      PERFORM public.finish_continuous_instance_internal(_i.id,false);
      CONTINUE;
    END IF;
    _choice:=_choices->_i.id::text;$body$;
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Continuous resolution start changed'; END IF;
  EXECUTE replace(_sql,_old,_new);
END;
$patch$;