-- Continuous effects support registered DoTs, common effects, lifecycle cleanup,
-- and residual debuffs that count only the affected character's turns.

DO $patch$
DECLARE _sql text;_old text;_new text;
BEGIN
  SELECT pg_get_functiondef('public.resolve_continuous_turn(uuid,uuid,jsonb)'::regprocedure) INTO _sql;
  _old:=$old$      ELSE
        RAISE EXCEPTION 'Ação contínua não suportada: %',_action->>'kind';$old$;
  _new:=$new$      ELSIF _action->>'kind'='dot' THEN
        IF COALESCE(_action->>'template_id','') !~* '^[0-9a-f]{8}-[0-9a-f-]{27,36}$' THEN
          RAISE EXCEPTION 'Selecione um DoT registrado';
        END IF;
        IF NOT EXISTS(SELECT 1 FROM public.battle_effects e
          WHERE e.battle_id=_battle_id AND e.character_id=_i.target_character_id
            AND e.effect_type='damage_over_time'
            AND e.source_character_ability_id=_i.character_ability_id
            AND e.effect_data->>'dot_template_id'=_action->>'template_id'
            AND e.effect_data->>'source_ability_name'=_i.name)
          OR COALESCE((_action->>'repeat')::boolean,false)
        THEN
          PERFORM public.apply_ability_dot_effect_internal(
            _battle_id,_i.caster_character_id,_i.name,_i.target_character_id,
            jsonb_build_object(
              'id','periodic_'||_i.id::text,
              'template_id',_action->>'template_id',
              'damage_mode',COALESCE(_action->>'damage_mode','fixed'),
              'damage_amount',COALESCE((_action->>'damage_amount')::numeric,5),
              'duration',COALESCE((_action->>'duration')::integer,2)
            ),'{}'::jsonb,_i.character_ability_id);
        END IF;
      ELSIF _action->>'kind'='effect' THEN
        IF _action->>'effect_type' NOT IN ('stun','no_regen_hp','no_regen_mana','magic_prohibition','no_mana','invincible') THEN
          RAISE EXCEPTION 'Tipo de efeito periódico não permitido';
        END IF;
        IF COALESCE((_action->>'duration')::integer,0) NOT BETWEEN 1 AND 1000 THEN
          RAISE EXCEPTION 'Duração de efeito periódico inválida';
        END IF;
        IF COALESCE((_action->>'repeat')::boolean,false) OR NOT EXISTS(
          SELECT 1 FROM public.battle_effects e
          WHERE e.battle_id=_battle_id AND e.character_id=_i.target_character_id
            AND e.effect_type=_action->>'effect_type'
            AND e.effect_data->>'continuous_source_id'=_i.id::text
        ) THEN
          INSERT INTO public.battle_effects(battle_id,character_id,name,effect_type,
            polarity,value_mode,amount,duration,duration_scope,source_character_ability_id,effect_data)
          VALUES(_battle_id,_i.target_character_id,
            _i.name||' · '||COALESCE(NULLIF(_action->>'name',''),_action->>'effect_type'),
            _action->>'effect_type',
            CASE WHEN _action->>'effect_type'='invincible' THEN 'buff' ELSE 'debuff' END,
            'fixed',0,(_action->>'duration')::integer,'individual',_i.character_ability_id,
            jsonb_build_object('continuous_source_id',_i.id::text));
        END IF;
      ELSE
        RAISE EXCEPTION 'Ação contínua não suportada: %',_action->>'kind';$new$;
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Resolver de efeitos contínuos mudou'; END IF;
  EXECUTE replace(_sql,_old,_new);
END;
$patch$;

-- Internal-only lifecycle finalizer. Web clients can only use the master-only
-- stop_continuous_effect RPC, not call this function directly.
CREATE OR REPLACE FUNCTION public.finish_continuous_instance_internal(_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
DECLARE _i public.continuous_effect_instances%ROWTYPE; _linger integer;
BEGIN
  SELECT * INTO _i FROM public.continuous_effect_instances WHERE id=_id FOR UPDATE;
  IF NOT FOUND OR NOT _i.active THEN RETURN false; END IF;
  _linger:=LEAST(1000,GREATEST(0,COALESCE((_i.rule->>'linger_turns')::integer,0)));
  UPDATE public.continuous_effect_instances SET active=false,updated_at=now() WHERE id=_id;
  IF _linger>0 THEN
    UPDATE public.battle_effects SET until_combat_end=false,duration=_linger,
      duration_scope='individual',created_at=now()
    WHERE battle_id=_i.battle_id AND effect_data->>'continuous_instance_id'=_id::text;
  ELSE
    DELETE FROM public.battle_effects WHERE battle_id=_i.battle_id
      AND effect_data->>'continuous_instance_id'=_id::text;
  END IF;
  DELETE FROM public.battle_effects WHERE battle_id=_i.battle_id
    AND effect_data->>'continuous_source_id'=_id::text;
  RETURN true;
END;
$fn$;
REVOKE ALL ON FUNCTION public.finish_continuous_instance_internal(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.stop_continuous_effect(_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode interromper efeitos contínuos';
  END IF;
  RETURN public.finish_continuous_instance_internal(_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.autostop_continuous_on_ability() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
DECLARE _item record;
BEGIN
  IF (OLD.toggle_active AND NOT NEW.toggle_active)
    OR (OLD.active_duration_remaining>0 AND NEW.active_duration_remaining=0) THEN
    FOR _item IN SELECT id FROM public.continuous_effect_instances
      WHERE character_ability_id=NEW.id AND active LOOP
      PERFORM public.finish_continuous_instance_internal(_item.id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS autostop_continuous_on_ability ON public.character_abilities;
CREATE TRIGGER autostop_continuous_on_ability
AFTER UPDATE OF toggle_active,active_duration_remaining ON public.character_abilities
FOR EACH ROW EXECUTE FUNCTION public.autostop_continuous_on_ability();

CREATE OR REPLACE FUNCTION public.autostop_continuous_on_exit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
DECLARE _item record;
BEGIN
  IF TG_TABLE_NAME='battle_participants' THEN
    FOR _item IN SELECT id FROM public.continuous_effect_instances
      WHERE battle_id=OLD.battle_id AND active AND
      (caster_character_id=OLD.character_id OR target_character_id=OLD.character_id) LOOP
      PERFORM public.finish_continuous_instance_internal(_item.id);
    END LOOP;
  ELSE
    IF OLD.active=true AND NEW.active=false THEN
      FOR _item IN SELECT id FROM public.continuous_effect_instances
        WHERE battle_id=NEW.id AND active LOOP
        PERFORM public.finish_continuous_instance_internal(_item.id);
      END LOOP;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$fn$;
DROP TRIGGER IF EXISTS autostop_continuous_on_leave ON public.battle_participants;
CREATE TRIGGER autostop_continuous_on_leave
BEFORE DELETE ON public.battle_participants
FOR EACH ROW EXECUTE FUNCTION public.autostop_continuous_on_exit();
DROP TRIGGER IF EXISTS autostop_continuous_on_battle_end ON public.battles;
CREATE TRIGGER autostop_continuous_on_battle_end
AFTER UPDATE OF active ON public.battles
FOR EACH ROW EXECUTE FUNCTION public.autostop_continuous_on_exit();

-- Residual debuffs from these instances tick only on an individual's turn.
DO $patch$
DECLARE _sql text;_old text;_new text;
BEGIN
  SELECT pg_get_functiondef('public.advance_combat_turn(uuid,uuid,jsonb)'::regprocedure) INTO _sql;
  _old := '    AND e.source_race_id IS NULL';
  _new := '    AND e.source_race_id IS NULL
    AND (_character_id IS NOT NULL OR e.effect_data->>''continuous_instance_id'' IS NULL)';
  IF (length(_sql)-length(replace(_sql,_old,''))) / length(_old) < 2 THEN
    RAISE EXCEPTION 'Pontos de expiração de efeitos não encontrados';
  END IF;
  EXECUTE replace(_sql,_old,_new);
END;
$patch$;