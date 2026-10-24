-- Restore the server-side helper used by the live combat ability cleanup rules.
CREATE OR REPLACE FUNCTION public.remove_attack_cancellable_effects(_character_id uuid, _battle_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _removed integer := 0;
BEGIN
  DELETE FROM public.battle_effects e
  WHERE e.character_id = _character_id
    AND NOT e.is_sheet_permanent
    AND NOT e.is_end_effect
    AND e.effect_data->>'remove_on_attack' = 'true'
    AND (e.battle_id IS NULL OR e.battle_id = _battle_id)
    AND e.effect_type <> 'damage_over_time';
  GET DIAGNOSTICS _removed = ROW_COUNT;
  RETURN _removed;
END
$function$;

REVOKE ALL ON FUNCTION public.remove_attack_cancellable_effects(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_attack_cancellable_effects(uuid,uuid) TO service_role;
