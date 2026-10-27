-- Damage from continuous abilities uses an explicit master-confirmed roll (Discord),
-- fixed amount, or an attribute-based preview. No hidden server-side dice roll.
-- Per-turn signed modifiers and defense bypass follow the normal attack pipeline.
DO $migration$
DECLARE
 _src text;
 _old text;
 _next text;
 _head text;
 _tail text;
BEGIN
 SELECT pg_get_functiondef('public.resolve_continuous_turn(uuid,uuid,jsonb)'::regprocedure) INTO _src;
 IF position('  _entry record; _override jsonb; _custom numeric;' in _src)=0 THEN
  RAISE EXCEPTION 'Continuous resolver declarations changed unexpectedly';
 END IF;
 _src:=replace(_src,
 '  _entry record; _override jsonb; _custom numeric;',
 '  _entry record; _override jsonb; _custom numeric;
  _turn_fixed numeric; _turn_percent numeric; _ignore_config jsonb;
  _damage_type_id uuid; _physical_damage_type_id uuid; _magic_level text;');

 _head:='      ELSIF _action->>''kind''=''damage'' THEN';
 _tail:='      ELSIF _action->>''kind''=''dot'' THEN';
 IF position(_head in _src)=0 OR position(_tail in _src)=0
    OR position(_tail in _src)<position(_head in _src) THEN
   RAISE EXCEPTION 'Continuous resolver damage branch not found';
 END IF;
 _old:=substring(_src from position(_head in _src)
   for position(_tail in _src)-position(_head in _src));
 _next:=$code$
      ELSIF _action->>'kind'='damage' THEN
        -- Dice are rolled externally on Discord. The master must enter the
        -- value on each turn; the database never chooses a random outcome.
        IF COALESCE(_action->>'damage_source','dice') NOT IN ('dice','fixed','attribute') THEN
          RAISE EXCEPTION 'Fonte de dano contínuo desconhecida';
        END IF;
        IF _action->>'damage_source'='attribute' AND NOT EXISTS (
          SELECT 1 FROM public.attribute_definitions d
          WHERE d.key=_action->>'attribute_key'
        ) THEN
          RAISE EXCEPTION 'Atributo do dano contínuo inválido';
        END IF;
        IF _override ? 'damage' THEN
          IF jsonb_typeof(_override->'damage')<>'number' THEN
            RAISE EXCEPTION 'Informe o resultado numérico do dano do turno';
          END IF;
          _damage:=(_override->>'damage')::numeric;
        ELSIF _choice ? 'damage' THEN
          -- Compatibility with already-open browser sessions, which sent one
          -- confirmed roll per continuous rule instead of one per action.
          IF jsonb_typeof(_choice->'damage')<>'number' THEN
            RAISE EXCEPTION 'Resultado de dano inválido';
          END IF;
          _damage:=(_choice->>'damage')::numeric;
        ELSIF _action->>'damage_source'='fixed' THEN
          _damage:=COALESCE((_action->>'fixed_damage')::numeric,(_action->>'flat')::numeric,0);
        ELSE
          RAISE EXCEPTION 'Informe o resultado do dado rolado no Discord antes de avançar o turno';
        END IF;
        IF _damage<>trunc(_damage) OR _damage<0 OR _damage>1000000 THEN
          RAISE EXCEPTION 'Valor base do dano contínuo fora do limite';
        END IF;
        IF (_override ? 'fixed_adjustment' AND jsonb_typeof(_override->'fixed_adjustment')<>'number')
           OR (_override ? 'percent_adjustment' AND jsonb_typeof(_override->'percent_adjustment')<>'number') THEN
          RAISE EXCEPTION 'Ajustes extras de dano devem ser números';
        END IF;
        _turn_fixed:=COALESCE((_override->>'fixed_adjustment')::numeric,0);
        _turn_percent:=COALESCE((_override->>'percent_adjustment')::numeric,0);
        IF _turn_fixed<>trunc(_turn_fixed) OR _turn_fixed NOT BETWEEN -1000000 AND 1000000
           OR _turn_percent NOT BETWEEN -100 AND 1000 THEN
          RAISE EXCEPTION 'Modificadores adicionais fora do limite';
        END IF;
        -- Exactly like an ability attack: signed fixed first, then percent.
        _damage:=LEAST(1000000,GREATEST(0,ROUND(
          GREATEST(0,_damage+_turn_fixed)*(1+_turn_percent/100)
        )));
        IF COALESCE((_override->>'neutralize')::boolean,(_choice->>'neutralize')::boolean,false) THEN
          IF COALESCE((_action->>'neutralizable')::boolean,false) IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'Esta habilidade não permite neutralização do dano';
          END IF;
          _damage:=0;
        END IF;
        _kind:=COALESCE(_override->>'damage_kind',_choice->>'damage_kind',_action->>'damage_kind','true');
        IF _kind NOT IN ('true','physical','magical') THEN
          RAISE EXCEPTION 'Tipo do dano contínuo inválido';
        END IF;
        _ignore_config:=COALESCE(_override->'defense_ignore','{}'::jsonb);
        PERFORM public.validate_attack_defense_ignore(_ignore_config);
        IF _kind='true' THEN _ignore_config:='{}'::jsonb; END IF;
        _damage_type_id:=NULLIF(COALESCE(_override->>'damage_type_id',_action->>'damage_type_id'),'')::uuid;
        _physical_damage_type_id:=NULLIF(COALESCE(_override->>'physical_damage_type_id',_action->>'physical_damage_type_id'),'')::uuid;
        _magic_level:=CASE WHEN _kind='magical' THEN
          COALESCE(_override->>'magic_level',_action->>'magic_level','baixa') ELSE NULL END;
        IF _kind<>'magical' THEN _damage_type_id:=NULL; END IF;
        IF _kind<>'physical' THEN _physical_damage_type_id:=NULL; END IF;
        -- With zero damage, do not call the HP pipeline: other buffs or a
        -- negative defense could turn an intentional zero into HP loss.
        IF _damage>0 THEN
          _result:=public.apply_battle_damage(
            _battle_id,_i.target_character_id,_kind,_damage_type_id,
            jsonb_build_array(_damage),_magic_level,
            CASE WHEN _i.caster_character_id=_i.target_character_id OR NOT EXISTS
              (SELECT 1 FROM public.battle_participants bp
                WHERE bp.battle_id=_battle_id AND bp.character_id=_i.caster_character_id)
              THEN NULL::uuid ELSE _i.caster_character_id END,
            _physical_damage_type_id,_ignore_config
          );
        END IF;
$code$;
 _src:=replace(_src,_old,_next);
 EXECUTE _src;
END;
$migration$;