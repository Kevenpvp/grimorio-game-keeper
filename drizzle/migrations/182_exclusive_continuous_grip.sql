-- A creature can sustain multiple marked abilities on the SAME victim, but
-- moving a marked grip to another victim clears earlier marked grips/effects.
-- No extra ability columns: exclusive_grip is part of continuous_rules JSON.
-- The helper is only called by the existing authenticated master RPCs.
CREATE OR REPLACE FUNCTION public.switch_exclusive_continuous_grip_internal(
  _battle_id uuid, _character_ability_id uuid, _hit_target_ids uuid[]
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  _ability public.character_abilities%ROWTYPE;
  _old record;
  _removed integer := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode transferir a grudagem';
  END IF;
  IF _battle_id IS NULL OR _character_ability_id IS NULL
    OR COALESCE(cardinality(_hit_target_ids), 0)=0 THEN
    RETURN 0;
  END IF;
  SELECT * INTO _ability FROM public.character_abilities WHERE id=_character_ability_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Habilidade de grudagem não encontrada'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(_ability.continuous_rules)='array'
        THEN _ability.continuous_rules ELSE '[]'::jsonb END
    ) r WHERE r->>'exclusive_grip'='true'
  ) THEN RETURN 0; END IF;

  -- Serialize switches for this creature (or a specific borrowed creature)
  -- even when two masters submit actions near-simultaneously.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    _battle_id::text || ':' || _ability.character_id::text || ':' ||
    COALESCE(_ability.source_summon_grant_id::text, 'own'), 0));

  FOR _old IN
    SELECT ci.id,ci.character_ability_id,ci.target_character_id
    FROM public.continuous_effect_instances ci
    JOIN public.character_abilities ca ON ca.id=ci.character_ability_id
    WHERE ci.battle_id=_battle_id AND ci.active
      AND ci.caster_character_id=_ability.character_id
      AND ca.source_summon_grant_id IS NOT DISTINCT FROM _ability.source_summon_grant_id
      AND ci.rule->>'exclusive_grip'='true'
      AND NOT (ci.target_character_id = ANY(_hit_target_ids))
    ORDER BY ci.id FOR UPDATE OF ci
  LOOP
    -- A forced switch is a full release: no residual debuff, periodic DoT,
    -- or other previously attached combat effect may remain on the old victim.
    PERFORM public.finish_continuous_instance_internal(_old.id,true);
    DELETE FROM public.battle_effects e
    WHERE e.battle_id=_battle_id
      AND e.character_id=_old.target_character_id
      AND e.source_character_ability_id=_old.character_ability_id
      AND COALESCE(e.is_sheet_permanent,false)=false;
    _removed:=_removed+1;
  END LOOP;
  RETURN _removed;
END;
$fn$;
REVOKE ALL ON FUNCTION public.switch_exclusive_continuous_grip_internal(uuid,uuid,uuid[])
  FROM PUBLIC, anon, authenticated;

-- Patch all ways to use ongoing effects. The helper runs within the SAME
-- attack/activation transaction, so mana/cooldown/target validation failures
-- rollback every release. Send the full hit list to preserve old links
-- against ANY of those same targets in multi-target attacks.
DO $patch$
DECLARE _name text; _sql text; _old text; _new text; _count integer;
BEGIN
  FOREACH _name IN ARRAY ARRAY[
    'activate_character_ability',
    'activate_character_ability_attack',
    'repeat_character_ability_attack'
  ] LOOP
    SELECT pg_get_functiondef(p.oid) INTO _sql
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
      AND p.proname=_name AND (
        (_name='activate_character_ability' AND p.pronargs=6)
        OR (_name<>'activate_character_ability' AND p.pronargs=8)
      );
    IF _sql IS NULL THEN
      RAISE EXCEPTION 'RPC de habilidade não encontrada: %',_name;
    END IF;
    IF _name='activate_character_ability' THEN
      _old:='PERFORM public.begin_continuous_effects(_effective_battle_id,_assignment.id,_target_character_id);';
      _new:='PERFORM public.switch_exclusive_continuous_grip_internal(_effective_battle_id,_assignment.id,ARRAY[_target_character_id]::uuid[]);' || E'\n    ' || _old;
    ELSE
      _old:='PERFORM public.begin_continuous_effects(_effective_battle_id,_assignment.id,_hit_target_id);';
      _new:='PERFORM public.switch_exclusive_continuous_grip_internal(_effective_battle_id,_assignment.id,_hit_target_ids);' || E'\n      ' || _old;
    END IF;
    _count := (length(_sql)-length(replace(_sql,_old,''))) / length(_old);
    IF _count<>1 THEN RAISE EXCEPTION 'Âncora de grudagem inesperada em %: %',_name,_count; END IF;
    EXECUTE replace(_sql,_old,_new);
  END LOOP;
END;
$patch$;
