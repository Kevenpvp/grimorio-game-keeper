-- Safe surgical patches to preserve the mature activation and turn logic.
DO $migration$
DECLARE _entry record; _sql text; _old text; _new text;
BEGIN
  FOR _entry IN SELECT proname,oid FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND
      ((proname='activate_character_ability' AND pronargs=6)
       OR (proname='activate_character_ability_attack' AND pronargs=8)
       OR (proname='advance_combat_turn' AND pronargs=3))
  LOOP
    _sql:=pg_get_functiondef(_entry.oid);
    IF _entry.proname='advance_combat_turn' THEN
      _old:='  -- Apply the configured base regeneration using current database modifiers before ticking durations.';
      _new:=$code$
  -- Apply continuous actions inside this same transaction; a missing confirmation
  -- aborts the turn and rolls back all counters and resources.
  PERFORM public.resolve_continuous_turn(_battle_id,_character_id,
    COALESCE(NULLIF(current_setting('grimorio.continuous_choices',true),'')::jsonb,'{}'::jsonb));

  -- Apply the configured base regeneration using current database modifiers before ticking durations.$code$;
    ELSIF _entry.proname='activate_character_ability' THEN
      _old:='  return _effective_mana_cost;';
      _new:=$code$
  IF _effective_battle_id IS NOT NULL THEN
    PERFORM public.begin_continuous_effects(_effective_battle_id,_assignment.id,_target_character_id);
  END IF;
  return _effective_mana_cost;$code$;
    ELSE
      _old:='  return _effective_mana_cost;';
      _new:=$code$
  IF _effective_battle_id IS NOT NULL AND _hit_target_ids IS NOT NULL THEN
    FOR _hit_target_id IN SELECT DISTINCT unnest(_hit_target_ids) LOOP
      PERFORM public.begin_continuous_effects(_effective_battle_id,_assignment.id,_hit_target_id);
    END LOOP;
  END IF;
  return _effective_mana_cost;$code$;
    END IF;
    IF position(_old in _sql)=0 THEN
      RAISE EXCEPTION 'Expected integration anchor missing from %',_entry.proname;
    END IF;
    _sql:=replace(_sql,_old,_new);
    EXECUTE _sql;
  END LOOP;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.confirm_continuous_and_advance(
  _battle_id uuid, _character_id uuid, _mana_regeneration_settings jsonb, _choices jsonb
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
DECLARE _result integer; _previous text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode confirmar e avançar turnos';
  END IF;
  IF jsonb_typeof(_choices)<>'object' THEN RAISE EXCEPTION 'Escolhas devem ser um objeto'; END IF;
  _previous:=current_setting('grimorio.continuous_choices',true);
  PERFORM set_config('grimorio.continuous_choices',_choices::text,true);
  _result:=public.advance_combat_turn(_battle_id,_character_id,_mana_regeneration_settings);
  PERFORM set_config('grimorio.continuous_choices',coalesce(_previous,''),true);
  RETURN _result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('grimorio.continuous_choices',coalesce(_previous,''),true);
  RAISE;
END;
$fn$;
REVOKE ALL ON FUNCTION public.confirm_continuous_and_advance(uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.confirm_continuous_and_advance(uuid,uuid,jsonb,jsonb) TO authenticated;