-- Reusable, master-controlled continuous ability rules. No creature abilities are created.
ALTER TABLE public.abilities ADD COLUMN IF NOT EXISTS continuous_rules jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.character_abilities ADD COLUMN IF NOT EXISTS continuous_rules jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS public.continuous_effect_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  battle_id uuid NOT NULL REFERENCES public.battles(id) ON DELETE CASCADE,
  character_ability_id uuid NOT NULL REFERENCES public.character_abilities(id) ON DELETE CASCADE,
  caster_character_id uuid NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  target_character_id uuid NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  rule_index integer NOT NULL CHECK (rule_index >= 0 AND rule_index <= 19),
  rule jsonb NOT NULL,
  name text NOT NULL,
  ticks integer NOT NULL DEFAULT 0 CHECK(ticks BETWEEN 0 AND 10000),
  active boolean NOT NULL DEFAULT true,
  last_tick_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(battle_id, character_ability_id,target_character_id,rule_index)
);
CREATE INDEX IF NOT EXISTS idx_continuous_effect_turn ON public.continuous_effect_instances(battle_id,active,target_character_id,caster_character_id);
ALTER TABLE public.continuous_effect_instances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "masters_read_continuous_effects" ON public.continuous_effect_instances;
CREATE POLICY "masters_read_continuous_effects" ON public.continuous_effect_instances
 FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'master'));
REVOKE ALL ON public.continuous_effect_instances FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.continuous_effect_instances TO authenticated;

CREATE OR REPLACE FUNCTION public.stop_continuous_effect(_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
DECLARE _item public.continuous_effect_instances%ROWTYPE;
        _linger integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode interromper efeitos contínuos';
  END IF;
  SELECT * INTO _item FROM public.continuous_effect_instances WHERE id=_id FOR UPDATE;
  IF NOT FOUND OR NOT _item.active THEN RETURN false; END IF;
  _linger:=LEAST(1000,GREATEST(0,COALESCE((_item.rule->>'linger_turns')::integer,0)));
  UPDATE public.continuous_effect_instances SET active=false,updated_at=now() WHERE id=_id;
  IF _linger>0 THEN
    UPDATE public.battle_effects SET until_combat_end=false, duration=_linger,
      duration_scope='individual',created_at=now()
    WHERE battle_id=_item.battle_id AND effect_data->>'continuous_instance_id'=_id::text;
  ELSE
    DELETE FROM public.battle_effects WHERE battle_id=_item.battle_id
      AND effect_data->>'continuous_instance_id'=_id::text;
  END IF;
  RETURN true;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.begin_continuous_effects(_battle_id uuid,_character_ability_id uuid,_target_character_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
DECLARE _ability public.character_abilities%ROWTYPE;
        _rules jsonb; _rule jsonb; _index int:=0; _count int:=0; _name text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN RAISE EXCEPTION 'Apenas o mestre pode iniciar efeitos contínuos'; END IF;
  SELECT * INTO _ability FROM public.character_abilities WHERE id=_character_ability_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Habilidade não encontrada'; END IF;
  IF _battle_id IS NULL OR _target_character_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM public.battles b WHERE b.id=_battle_id AND b.active
  ) OR NOT EXISTS(SELECT 1 FROM public.battle_participants p WHERE p.battle_id=_battle_id AND p.character_id=_target_character_id)
     OR NOT EXISTS(SELECT 1 FROM public.battle_participants p WHERE p.battle_id=_battle_id AND p.character_id=_ability.character_id)
  THEN RAISE EXCEPTION 'Alvo ou usuário não pertence ao combate'; END IF;
  _rules:=_ability.continuous_rules;
  IF jsonb_typeof(_rules)<>'array' OR jsonb_array_length(_rules)>20 THEN RAISE EXCEPTION 'Regras contínuas inválidas'; END IF;
  FOR _rule IN SELECT value FROM jsonb_array_elements(_rules) LOOP
    IF jsonb_typeof(_rule)<>'object'
      OR _rule->>'trigger' NOT IN ('target','caster','global')
      OR jsonb_typeof(_rule->'actions')<>'array'
      OR jsonb_array_length(_rule->'actions')>12
      OR jsonb_array_length(_rule->'actions')=0 THEN
      RAISE EXCEPTION 'Configuração de efeito contínuo inválida';
    END IF;
    _name:=LEFT(COALESCE(NULLIF(_rule->>'name',''),_ability.name),140);
    INSERT INTO public.continuous_effect_instances
      (battle_id,character_ability_id,caster_character_id,target_character_id,rule_index,rule,name,ticks,active,last_tick_token)
    VALUES (_battle_id,_character_ability_id,_ability.character_id,_target_character_id,_index,_rule,_name,0,true,NULL)
    ON CONFLICT (battle_id,character_ability_id,target_character_id,rule_index) DO UPDATE SET
      rule=excluded.rule, name=excluded.name,active=true,ticks=0,last_tick_token=NULL,updated_at=now();
    _count:=_count+1; _index:=_index+1;
  END LOOP;
  RETURN _count;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.resolve_continuous_turn(_battle_id uuid,_character_id uuid,_choices jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
DECLARE
  _i public.continuous_effect_instances%ROWTYPE;
  _item jsonb; _action jsonb; _choice jsonb; _token text;
  _attribute jsonb; _key text; _label text;
  _value numeric; _step numeric; _cap numeric; _points numeric;
  _roll integer; _count integer; _sides integer; _flat integer; _damage numeric; _kind text;
  _result jsonb; _processed int:=0; _effect record; _was_present boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN RAISE EXCEPTION 'Somente o mestre pode confirmar efeitos contínuos'; END IF;
  IF _choices IS NULL OR jsonb_typeof(_choices)<>'object' THEN RAISE EXCEPTION 'Confirmação dos efeitos contínuos obrigatória'; END IF;
  FOR _i IN SELECT * FROM public.continuous_effect_instances i
    WHERE i.battle_id=_battle_id AND i.active AND
      ( (_character_id IS NULL AND i.rule->>'trigger'='global')
       OR (_character_id IS NOT NULL AND
          ((i.rule->>'trigger'='target' AND i.target_character_id=_character_id)
          OR (i.rule->>'trigger'='caster' AND i.caster_character_id=_character_id))))
    ORDER BY i.created_at,i.id FOR UPDATE
  LOOP
    IF NOT EXISTS(SELECT 1 FROM public.battle_participants bp WHERE bp.battle_id=_battle_id AND bp.character_id=_i.target_character_id)
    OR NOT EXISTS(SELECT 1 FROM public.battle_participants bp WHERE bp.battle_id=_battle_id AND bp.character_id=_i.caster_character_id)
    THEN
      PERFORM public.stop_continuous_effect(_i.id);
      CONTINUE;
    END IF;
    _choice:=_choices->_i.id::text;
    IF jsonb_typeof(_choice)<>'object' OR (_choice ? 'neutralize' AND jsonb_typeof(_choice->'neutralize')<>'boolean') THEN
      RAISE EXCEPTION 'Confirmação ausente para %',_i.name;
    END IF;
    _token:= CASE WHEN _character_id IS NULL THEN 'global:' ELSE 'individual:'||_character_id::text||':' END||
      (CASE WHEN _character_id IS NULL THEN (SELECT turn_count FROM public.battles WHERE id=_battle_id)
        ELSE (SELECT turn_count FROM public.battle_participants WHERE battle_id=_battle_id AND character_id=_character_id) END)::text;
    IF _i.last_tick_token=_token THEN RAISE EXCEPTION 'Este efeito já foi processado neste turno'; END IF;
    FOR _action IN SELECT value FROM jsonb_array_elements(_i.rule->'actions') LOOP
      IF _action->>'kind'='status' THEN
        IF jsonb_typeof(_action->'attributes')<>'array' OR jsonb_array_length(_action->'attributes')>48 THEN
          RAISE EXCEPTION 'Atributos contínuos inválidos';
        END IF;
        FOR _attribute IN SELECT value FROM jsonb_array_elements(_action->'attributes') LOOP
          _key:=_attribute->>'key';
          IF NOT EXISTS(SELECT 1 FROM public.attribute_definitions WHERE key=_key) THEN RAISE EXCEPTION 'Atributo inválido: %',_key; END IF;
          _step:=COALESCE((_attribute->>'step')::numeric,0);
          _cap:=COALESCE((_attribute->>'cap')::numeric,1000000);
          IF _step<0 OR _step>1000000 OR _cap<0 OR _cap>1000000 THEN RAISE EXCEPTION 'Valor de acúmulo inválido'; END IF;
          _points:=LEAST(_cap,_step*(_i.ticks+1));
          _label:= (SELECT label FROM public.attribute_definitions WHERE key=_key);
          UPDATE public.battle_effects SET amount=_points,until_combat_end=true,
            polarity=CASE WHEN _action->>'polarity'='buff' THEN 'buff' ELSE 'debuff' END,
            value_mode=CASE WHEN _attribute->>'mode'='fixed' THEN 'fixed' ELSE 'percent' END
          WHERE battle_id=_battle_id AND character_id=_i.target_character_id AND attribute_key=_key
            AND effect_data->>'continuous_instance_id'=_i.id::text;
          GET DIAGNOSTICS _roll = ROW_COUNT;
          IF _roll=0 THEN
            INSERT INTO public.battle_effects(battle_id,character_id,name,effect_type,attribute_key,polarity,value_mode,amount,
              duration,until_combat_end,duration_scope,source_character_ability_id,effect_data)
            VALUES (_battle_id,_i.target_character_id,_i.name||' · '||_label,'status',_key,
              CASE WHEN _action->>'polarity'='buff' THEN 'buff' ELSE 'debuff' END,
              CASE WHEN _attribute->>'mode'='fixed' THEN 'fixed' ELSE 'percent' END,
              _points,1,true,'individual',_i.character_ability_id,
              jsonb_build_object('continuous_instance_id',_i.id::text));
          END IF;
        END LOOP;
      ELSIF _action->>'kind'='damage' THEN
        _count:=COALESCE((_action->>'dice_count')::integer,1);
        _sides:=COALESCE((_action->>'dice_sides')::integer,50);
        _flat:=COALESCE((_action->>'flat')::integer,0);
        IF _count<0 OR _count>20 OR _sides<1 OR _sides>1000 OR _flat<0 OR _flat>1000000 THEN
          RAISE EXCEPTION 'Dados do dano contínuo inválidos';
        END IF;
        _damage:=_flat;
        FOR _roll IN 1.._count LOOP _damage:=_damage+floor(random()*_sides)::integer+1; END LOOP;
        IF _choice ? 'damage' THEN
          IF jsonb_typeof(_choice->'damage') <> 'number' THEN RAISE EXCEPTION 'Dano deve ser numérico'; END IF;
          _damage:=(_choice->>'damage')::numeric;
        END IF;
        IF _damage<>trunc(_damage) OR _damage<0 OR _damage>1000000 THEN RAISE EXCEPTION 'Dano contínuo fora do limite'; END IF;
        IF COALESCE((_choice->>'neutralize')::boolean,false) THEN
          IF COALESCE((_action->>'neutralizable')::boolean,false) IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'Este dano não pode ser neutralizado';
          END IF;
          _damage:=0;
        END IF;
        _kind:=COALESCE(_choice->>'damage_kind',_action->>'damage_kind','true');
        IF _kind NOT IN ('true','physical','magical') THEN RAISE EXCEPTION 'Tipo de dano inválido'; END IF;
        IF _damage>0 THEN
          _result:=public.apply_battle_damage(_battle_id,_i.target_character_id,_kind,
            NULL,jsonb_build_array(_damage),'baixa',_i.caster_character_id,NULL);
        END IF;
      ELSE
        RAISE EXCEPTION 'Ação contínua não suportada: %',_action->>'kind';
      END IF;
    END LOOP;
    UPDATE public.continuous_effect_instances SET ticks=ticks+1,last_tick_token=_token,updated_at=now()
    WHERE id=_i.id;
    _processed:=_processed+1;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(_choices) chosen(id)
    WHERE NOT EXISTS(SELECT 1 FROM public.continuous_effect_instances i
      WHERE i.id::text=chosen.id AND i.battle_id=_battle_id AND i.active)) THEN
    RAISE EXCEPTION 'Confirmação contém efeito desconhecido';
  END IF;
  RETURN _processed;
END;
$fn$;

REVOKE ALL ON FUNCTION public.begin_continuous_effects(uuid,uuid,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.stop_continuous_effect(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.resolve_continuous_turn(uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.begin_continuous_effects(uuid,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stop_continuous_effect(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_continuous_turn(uuid,uuid,jsonb) TO authenticated;