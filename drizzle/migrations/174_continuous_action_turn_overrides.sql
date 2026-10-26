-- Per-turn master changes to individual continuous actions. Overrides are
-- one-use only and never mutate the ability template.
DO $patch$
DECLARE _sql text; _old text; _new text;
BEGIN
  SELECT pg_get_functiondef('public.resolve_continuous_turn(uuid,uuid,jsonb)'::regprocedure) INTO _sql;
  _old:='  _result jsonb; _processed int:=0; _effect record; _was_present boolean;';
  _new:='  _result jsonb; _processed int:=0; _effect record; _was_present boolean;
  _entry record; _override jsonb; _custom numeric;';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Continuous action declaration changed'; END IF;
  _sql:=replace(_sql,_old,_new);

  _old:='    FOR _action IN SELECT value FROM jsonb_array_elements(_i.rule->''actions'') LOOP';
  _new:=$body$
    FOR _entry IN SELECT value, ordinality
      FROM jsonb_array_elements(_i.rule->'actions') WITH ORDINALITY LOOP
      _action:=_entry.value;
      _override:=COALESCE(_choice->'actions'->((_entry.ordinality-1)::text),'{}'::jsonb);
      IF jsonb_typeof(_override)<>'object' THEN
        RAISE EXCEPTION 'Configuração avançada de ação inválida';
      END IF;
      IF COALESCE((_override->>'skip')::boolean,false) THEN CONTINUE; END IF;$body$;
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Continuous action loop changed'; END IF;
  _sql:=replace(_sql,_old,_new);

  _old:='          _points:=LEAST(_cap,_step*(_i.ticks+1));';
  _new:=$body$
          _points:=LEAST(_cap,_step*(_i.ticks+1));
          IF (_override->'attributes') ? _key THEN
            IF jsonb_typeof(_override->'attributes'->_key)<>'number' THEN
              RAISE EXCEPTION 'Ajuste numérico de atributo inválido';
            END IF;
            _custom:=(_override->'attributes'->>_key)::numeric;
            IF _custom<0 OR _custom>1000000 THEN RAISE EXCEPTION 'Ajuste de atributo fora do limite'; END IF;
            _points:=_custom;
          END IF;$body$;
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Continuous stacking point not found'; END IF;
  _sql:=replace(_sql,_old,_new);

  _old:='              ''damage_amount'',COALESCE((_action->>''damage_amount'')::numeric,5),
              ''duration'',COALESCE((_action->>''duration'')::integer,2)';
  _new:='              ''damage_amount'',COALESCE((_override->>''damage_amount'')::numeric,(_action->>''damage_amount'')::numeric,5),
              ''duration'',COALESCE((_override->>''duration'')::integer,(_action->>''duration'')::integer,2)';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Periodic registered DoT builder changed'; END IF;
  _sql:=replace(_sql,_old,_new);

  _old:='            ''fixed'',0,(_action->>''duration'')::integer,''individual'',_i.character_ability_id,';
  _new:='            ''fixed'',0,COALESCE((_override->>''duration'')::integer,(_action->>''duration'')::integer),''individual'',_i.character_ability_id,';
  IF position(_old in _sql)=0 THEN RAISE EXCEPTION 'Periodic extra-effect duration changed'; END IF;
  _sql:=replace(_sql,_old,_new);

  EXECUTE _sql;
END;
$patch$;