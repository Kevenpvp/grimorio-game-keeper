-- Install the sustained drain at the very end of the turn transaction.
-- The initial migration accidentally escaped newlines inside a comment;
-- this removes that entire comment fragment and inserts executable SQL.
DO $patch$
DECLARE
  _fn text;
  _start text := '  -- Drain each sustained ability on its owner''s turn';
  _stop text := '  -- Apply the configured base regeneration';
  _a integer;
  _b integer;
BEGIN
  SELECT pg_get_functiondef('public.advance_combat_turn(uuid,uuid,jsonb)'::regprocedure) INTO _fn;
  _a:=strpos(_fn,_start);
  _b:=strpos(_fn,_stop);
  IF _a=0 OR _b<=_a OR strpos(_fn,'  return _result_turn;')=0 THEN
    RAISE EXCEPTION 'O avanço de turnos mudou. Revise o consumo sustentado.';
  END IF;
  _fn:=left(_fn,_a-1) || substring(_fn from _b);
  _fn:=replace(_fn,'  return _result_turn;',
    '  -- Charge after cooldowns and DoTs: auto-deactivation starts a full cooldown.' || chr(10) ||
    '  PERFORM public.tick_sustained_ability_costs_internal(_battle_id,_character_id);' || chr(10) || chr(10) ||
    '  return _result_turn;');
  EXECUTE _fn;
END;
$patch$;