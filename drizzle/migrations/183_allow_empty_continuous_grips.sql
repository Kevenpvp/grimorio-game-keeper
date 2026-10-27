-- A sustained link may be a pure grab: no periodic buffs, dots, or damage.
-- Keep JSON validation for the actions array and its existing 12-action cap.
DO $patch$
DECLARE _sql text; _old text; _new text;
BEGIN
  SELECT pg_get_functiondef('public.begin_continuous_effects(uuid,uuid,uuid)'::regprocedure) INTO _sql;
  _old := E'      OR jsonb_array_length(_rule->\'actions\')=0';
  IF _sql IS NULL OR position(_old IN _sql)=0 THEN
    RAISE EXCEPTION 'Validação de ações contínuas mudou';
  END IF;
  EXECUTE replace(_sql, _old, '');

  -- Every advance processes links with no actions without requiring an empty
  -- popup. Treat those links as implicitly confirmed, then advance their
  -- counters as usual; explicit interrupt/dispel choices still take precedence.
  SELECT pg_get_functiondef('public.resolve_continuous_turn(uuid,uuid,jsonb)'::regprocedure) INTO _sql;
  _old := '    _choice:=_choices->_i.id::text;';
  _new := $body$
    _choice:=_choices->_i.id::text;
    IF _choice IS NULL AND _i.rule->'actions'='[]'::jsonb THEN
      _choice:='{"resolution":"apply"}'::jsonb;
    END IF;$body$;
  IF _sql IS NULL OR position(_old IN _sql)=0 THEN
    RAISE EXCEPTION 'Confirmação contínua mudou';
  END IF;
  EXECUTE replace(_sql, _old, _new);
END;
$patch$;
