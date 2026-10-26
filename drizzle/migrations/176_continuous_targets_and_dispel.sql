-- Sustained links: cap simultaneous victims, support deliberate release/purification,
-- and preserve residual penalties when grip is interrupted.
-- SECURITY DEFINER RPCs are restricted to the authenticated master.

CREATE OR REPLACE FUNCTION public.finish_continuous_instance_internal(_id uuid,_dispel boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
DECLARE _i public.continuous_effect_instances%ROWTYPE; _linger integer; _prior text;
BEGIN
  SELECT * INTO _i FROM public.continuous_effect_instances WHERE id=_id FOR UPDATE;
  IF NOT FOUND OR NOT _i.active THEN
    IF _dispel AND FOUND THEN
      DELETE FROM public.battle_effects e WHERE e.battle_id=_i.battle_id AND
        (e.effect_data->>'continuous_instance_id'=_id::text
         OR e.effect_data->>'continuous_source_id'=_id::text);
    END IF;
    RETURN false;
  END IF;
  _prior:=current_setting('grimorio.continuous_cleanup',true);
  PERFORM set_config('grimorio.continuous_cleanup','on',true);
  UPDATE public.continuous_effect_instances SET active=false,updated_at=now() WHERE id=_id;
  _linger:=LEAST(1000,GREATEST(0,COALESCE((_i.rule->>'linger_turns')::integer,0)));
  IF _dispel OR _linger=0 THEN
    DELETE FROM public.battle_effects WHERE battle_id=_i.battle_id
      AND effect_data->>'continuous_instance_id'=_id::text;
  ELSE
    UPDATE public.battle_effects SET until_combat_end=false,duration=_linger,
      duration_scope='individual',created_at=now()
    WHERE battle_id=_i.battle_id AND effect_data->>'continuous_instance_id'=_id::text;
  END IF;
  DELETE FROM public.battle_effects WHERE battle_id=_i.battle_id
    AND effect_data->>'continuous_source_id'=_id::text;
  PERFORM set_config('grimorio.continuous_cleanup',COALESCE(_prior,''),true);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('grimorio.continuous_cleanup',COALESCE(_prior,''),true);
  RAISE;
END;
$fn$;
REVOKE ALL ON FUNCTION public.finish_continuous_instance_internal(uuid,boolean) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.finish_continuous_instance_internal(_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
BEGIN
  RETURN public.finish_continuous_instance_internal(_id,false);
END;
$fn$;
REVOKE ALL ON FUNCTION public.finish_continuous_instance_internal(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.control_continuous_effect(_id uuid,_mode text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
DECLARE _found boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode controlar vínculos contínuos';
  END IF;
  IF _mode NOT IN ('interrupt','dispel') THEN
    RAISE EXCEPTION 'Ação inválida: escolha interromper ou dissipar';
  END IF;
  RETURN public.finish_continuous_instance_internal(_id,_mode='dispel');
END;
$fn$;
REVOKE ALL ON FUNCTION public.control_continuous_effect(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.control_continuous_effect(uuid,text) TO authenticated;

DO $patch$
DECLARE _sql text; _old text; _new text;
BEGIN
  SELECT pg_get_functiondef('public.begin_continuous_effects(uuid,uuid,uuid)'::regprocedure) INTO _sql;
  _old:='DECLARE _ability public.character_abilities%ROWTYPE;
        _rules jsonb; _rule jsonb; _index int:=0; _count int:=0; _name text;';
  _new:='DECLARE _ability public.character_abilities%ROWTYPE;
        _rules jsonb; _rule jsonb; _index int:=0; _count int:=0; _name text;
        _cap integer; _used integer; _oldest uuid; _policy text;';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Expected begin declaration not found'; END IF;
  _sql:=replace(_sql,_old,_new);
  _old:='    _name:=LEFT(COALESCE(NULLIF(_rule->>''name'',''''),_ability.name),140);';
  _new:=$code$
    _name:=LEFT(COALESCE(NULLIF(_rule->>'name',''),_ability.name),140);
    -- Reattacking a victim already held keeps the current accumulated penalty.
    IF EXISTS(SELECT 1 FROM public.continuous_effect_instances ci
      WHERE ci.battle_id=_battle_id AND ci.character_ability_id=_character_ability_id
        AND ci.target_character_id=_target_character_id
        AND ci.rule_index=_index AND ci.active) THEN
      _count:=_count+1; _index:=_index+1;
      CONTINUE;
    END IF;
    IF _rule->>'max_targets' IS NOT NULL AND _rule->>'max_targets'<>'unlimited' THEN
      _cap:=COALESCE((_rule->>'max_targets')::integer,1);
      IF _cap<1 OR _cap>100 THEN RAISE EXCEPTION 'Limite de alvos inválido'; END IF;
      SELECT count(*) INTO _used FROM public.continuous_effect_instances ci
        WHERE ci.battle_id=_battle_id AND ci.character_ability_id=_character_ability_id
          AND ci.rule_index=_index AND ci.active;
      _policy:=COALESCE(_rule->>'on_limit','replace_oldest');
      WHILE _used>=_cap LOOP
        IF _policy='block' THEN
          RAISE EXCEPTION 'Esta habilidade já atingiu o limite de % alvo(s). Solte uma vítima antes de atacar outra.',_cap;
        ELSIF _policy='choose' THEN
          RAISE EXCEPTION 'Limite de % alvo(s) atingido. Escolha um vínculo anterior para soltar no painel de combate antes de confirmar o novo ataque.',_cap;
        ELSIF _policy='replace_oldest' THEN
          SELECT ci.id INTO _oldest FROM public.continuous_effect_instances ci
            WHERE ci.battle_id=_battle_id AND ci.character_ability_id=_character_ability_id
              AND ci.rule_index=_index AND ci.active
            ORDER BY ci.created_at,ci.id LIMIT 1 FOR UPDATE;
          IF _oldest IS NULL THEN EXIT; END IF;
          PERFORM public.finish_continuous_instance_internal(_oldest,false);
          _used:=_used-1;
        ELSE
          RAISE EXCEPTION 'Política de limite de alvos inválida';
        END IF;
      END LOOP;
    END IF;
    IF COALESCE((_rule->>'stop_on_caster_stun')::boolean,false) AND EXISTS(
      SELECT 1 FROM public.battle_effects e WHERE e.battle_id=_battle_id
        AND e.character_id=_ability.character_id AND e.effect_type='stun') THEN
      RAISE EXCEPTION 'O personagem está atordoado e não pode manter esta habilidade sustentada';
    END IF;$code$;
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Expected begin loop anchor not found'; END IF;
  EXECUTE replace(_sql,_old,_new);

  SELECT pg_get_functiondef('public.resolve_continuous_turn(uuid,uuid,jsonb)'::regprocedure) INTO _sql;
  _old:='      PERFORM public.stop_continuous_effect(_i.id);
      CONTINUE;';
  _new:='      PERFORM public.finish_continuous_instance_internal(_i.id,false);
      CONTINUE;';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Missing internal cleanup anchor'; END IF;
  _sql:=replace(_sql,_old,_new);
  _old:='    _token:= CASE WHEN _character_id IS NULL THEN';
  _new:=$code$
    IF _choice->>'resolution' IN ('interrupt','dispel') THEN
      PERFORM public.finish_continuous_instance_internal(_i.id,_choice->>'resolution'='dispel');
      _processed:=_processed+1;
      CONTINUE;
    END IF;
    IF _choice->>'resolution' IS NOT NULL AND _choice->>'resolution' NOT IN ('apply','skip','interrupt','dispel') THEN
      RAISE EXCEPTION 'Resolução de vínculo contínuo inválida';
    END IF;
    IF _choice->>'resolution'='skip' THEN
      _processed:=_processed+1;
      CONTINUE;
    END IF;
    _token:= CASE WHEN _character_id IS NULL THEN$code$;
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Missing resolve choice anchor'; END IF;
  _sql:=replace(_sql,_old,_new);
  -- Do not require links to remain active once the master ends them in this same transaction.
  _old:='WHERE i.id::text=chosen.id AND i.battle_id=_battle_id AND i.active';
  _new:='WHERE i.id::text=chosen.id AND i.battle_id=_battle_id';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Missing confirmation validation'; END IF;
  _sql:=replace(_sql,_old,_new);
  -- A stopped caster may leave and still maintain a curse if the rule explicitly allows it.
  _old:='    OR NOT EXISTS(SELECT 1 FROM public.battle_participants bp WHERE bp.battle_id=_battle_id AND bp.character_id=_i.caster_character_id)';
  _new:='    OR (COALESCE((_i.rule->>''stop_on_caster_leave'')::boolean,true)
          AND NOT EXISTS(SELECT 1 FROM public.battle_participants bp WHERE bp.battle_id=_battle_id
            AND bp.character_id=_i.caster_character_id))';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Missing caster presence guard'; END IF;
  _sql:=replace(_sql,_old,_new);
  _old:='CASE WHEN _i.caster_character_id=_i.target_character_id THEN NULL::uuid ELSE _i.caster_character_id END';
  _new:='CASE WHEN _i.caster_character_id=_i.target_character_id OR NOT EXISTS
    (SELECT 1 FROM public.battle_participants bp WHERE bp.battle_id=_battle_id
      AND bp.character_id=_i.caster_character_id)
    THEN NULL::uuid ELSE _i.caster_character_id END';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Missing damage source guard'; END IF;
  _sql:=replace(_sql,_old,_new);
  EXECUTE _sql;
END;
$patch$;

-- Preserve user choice when a caster leaves.
CREATE OR REPLACE FUNCTION public.autostop_continuous_on_exit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
DECLARE _item record;
BEGIN
  IF TG_TABLE_NAME='battle_participants' THEN
    FOR _item IN SELECT id FROM public.continuous_effect_instances
      WHERE battle_id=OLD.battle_id AND active AND
        (target_character_id=OLD.character_id OR
         (caster_character_id=OLD.character_id AND
          COALESCE((rule->>'stop_on_caster_leave')::boolean,true))) LOOP
      PERFORM public.finish_continuous_instance_internal(_item.id,false);
    END LOOP;
  ELSE
    IF OLD.active=true AND NEW.active=false THEN
      FOR _item IN SELECT id FROM public.continuous_effect_instances WHERE battle_id=NEW.id AND active LOOP
        PERFORM public.finish_continuous_instance_internal(_item.id,false);
      END LOOP;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$fn$;

-- When the master or a cleansing skill removes a linked attribute debuff,
-- also detach that target and purge remaining effects from the same link.
-- Disable recursively fired cleanup using a local GUC.
CREATE OR REPLACE FUNCTION public.autodispel_continuous_on_effect_removed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
DECLARE _id uuid;
BEGIN
  IF current_setting('grimorio.continuous_cleanup',true)='on' THEN RETURN OLD; END IF;
  IF OLD.effect_data->>'continuous_instance_id' IS NULL THEN RETURN OLD; END IF;
  _id:=(OLD.effect_data->>'continuous_instance_id')::uuid;
  IF EXISTS(SELECT 1 FROM public.continuous_effect_instances ci WHERE ci.id=_id AND ci.active) THEN
    PERFORM public.finish_continuous_instance_internal(_id,true);
  END IF;
  RETURN OLD;
END;
$fn$;
DROP TRIGGER IF EXISTS autodispel_continuous_on_effect_removed ON public.battle_effects;
CREATE TRIGGER autodispel_continuous_on_effect_removed AFTER DELETE ON public.battle_effects
FOR EACH ROW EXECUTE FUNCTION public.autodispel_continuous_on_effect_removed();
