-- Validate independent physical/magical penetration for a paid attack.
CREATE OR REPLACE FUNCTION public.validate_attack_defense_ignore(_config jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path TO public
AS $function$
DECLARE _item record; _n numeric;
BEGIN
  IF _config IS NULL OR jsonb_typeof(_config)<>'object' THEN
    RAISE EXCEPTION 'Ignorar defesa deve ser um objeto';
  END IF;
  FOR _item IN SELECT key,value FROM jsonb_each(_config) LOOP
    IF _item.key NOT IN ('physical_fixed','physical_percent','magical_fixed','magical_percent')
       OR jsonb_typeof(_item.value)<>'number' THEN
      RAISE EXCEPTION 'Campo inválido para ignorar defesa: %',_item.key;
    END IF;
    _n := (_item.value#>>'{}')::numeric;
    IF _n<0
      OR (_item.key LIKE '%_percent' AND _n>100)
      OR (_item.key LIKE '%_fixed' AND (_n>1000000 OR _n<>trunc(_n))) THEN
      RAISE EXCEPTION 'Valor inválido para ignorar defesa: %',_item.key;
    END IF;
  END LOOP;
  RETURN _config;
END;
$function$;

CREATE OR REPLACE FUNCTION public.defense_after_ignore(_defense numeric,_config jsonb,_kind text)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path TO public
AS 'SELECT greatest(0,floor(_defense*(1-coalesce((_config->>(_kind||''_percent''))::numeric,0)/100)-coalesce((_config->>(_kind||''_fixed''))::numeric,0)))';

CREATE OR REPLACE FUNCTION public.apply_battle_damage(
  _battle_id uuid,_character_id uuid,_damage_kind text,_damage_type_id uuid,
  _damage_values jsonb,_magic_level text,_source_character_id uuid,
  _physical_damage_type_id uuid,_defense_ignore jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public
AS $function$
DECLARE _previous text := current_setting('grimorio.attack_defense_ignore',true); _answer jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode aplicar dano';
  END IF;
  PERFORM public.validate_attack_defense_ignore(_defense_ignore);
  PERFORM set_config('grimorio.attack_defense_ignore',_defense_ignore::text,true);
  _answer := public.apply_battle_damage(_battle_id,_character_id,_damage_kind,_damage_type_id,
    _damage_values,_magic_level,_source_character_id,_physical_damage_type_id);
  PERFORM set_config('grimorio.attack_defense_ignore',COALESCE(_previous,''),true);
  RETURN _answer;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('grimorio.attack_defense_ignore',COALESCE(_previous,''),true);
  RAISE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_battle_damage_critical(
  _battle_id uuid,_character_id uuid,_damage_kind text,_damage_type_id uuid,
  _damage_values jsonb,_magic_level text,_source_character_id uuid,
  _physical_damage_type_id uuid,_defense_ignore jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public
AS $function$
DECLARE _previous text := current_setting('grimorio.attack_defense_ignore',true); _answer jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode aplicar dano crítico';
  END IF;
  PERFORM public.validate_attack_defense_ignore(_defense_ignore);
  PERFORM set_config('grimorio.attack_defense_ignore',_defense_ignore::text,true);
  _answer := public.apply_battle_damage_critical(_battle_id,_character_id,_damage_kind,_damage_type_id,
    _damage_values,_magic_level,_source_character_id,_physical_damage_type_id);
  PERFORM set_config('grimorio.attack_defense_ignore',COALESCE(_previous,''),true);
  RETURN _answer;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('grimorio.attack_defense_ignore',COALESCE(_previous,''),true);
  RAISE;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_battle_damage(uuid,uuid,text,uuid,jsonb,text,uuid,uuid,jsonb) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.apply_battle_damage_critical(uuid,uuid,text,uuid,jsonb,text,uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.apply_battle_damage(uuid,uuid,text,uuid,jsonb,text,uuid,uuid,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_battle_damage_critical(uuid,uuid,text,uuid,jsonb,text,uuid,uuid,jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.validate_attack_defense_ignore(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.defense_after_ignore(numeric,jsonb,text) FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';