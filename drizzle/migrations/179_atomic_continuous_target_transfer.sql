-- Atomically transfer a sustained link while executing the attack.
-- If mana, targeting, effect validation, or activation fails, the release is
-- rolled back with the rest of the attack. Existing RPCs remain unchanged.
CREATE OR REPLACE FUNCTION public.attack_with_continuous_transfer(
  _character_ability_id uuid, _target_character_id uuid, _battle_id uuid,
  _extra_mana_cost integer, _hit_target_ids uuid[], _hit_effect_groups jsonb,
  _dot_target_selections jsonb, _dot_attribute_values jsonb,
  _release_continuous_ids uuid[], _repeat boolean
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='public' AS $fn$
DECLARE _release_id uuid; _link public.continuous_effect_instances%ROWTYPE;
        _result integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode transferir vínculos contínuos';
  END IF;
  IF _battle_id IS NULL OR _character_ability_id IS NULL THEN
    RAISE EXCEPTION 'Combate e habilidade são obrigatórios';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.battles WHERE id=_battle_id AND active) THEN
    RAISE EXCEPTION 'A batalha não está ativa';
  END IF;
  IF COALESCE(cardinality(_release_continuous_ids),0)>20 OR
    EXISTS(SELECT 1 FROM unnest(COALESCE(_release_continuous_ids,array[]::uuid[])) x WHERE x IS NULL) THEN
    RAISE EXCEPTION 'Seleção de vínculos para liberação inválida';
  END IF;
  IF (
    SELECT count(DISTINCT x)
    FROM unnest(COALESCE(_release_continuous_ids,array[]::uuid[])) AS x
  )<>COALESCE(cardinality(_release_continuous_ids),0) THEN
    RAISE EXCEPTION 'Existem vínculos duplicados na seleção';
  END IF;
  IF COALESCE(cardinality(_release_continuous_ids),0)>0
    AND COALESCE(cardinality(_hit_target_ids),0)=0 THEN
    RAISE EXCEPTION 'Não há alvo atingido para receber a transferência';
  END IF;
  -- Locks of all targets being released protect against concurrent transfer
  -- attempts. Releasing in ascending UUID order avoids cyclic lock ordering.
  FOR _release_id IN SELECT DISTINCT x FROM unnest(COALESCE(_release_continuous_ids,array[]::uuid[])) x ORDER BY x LOOP
    SELECT * INTO _link FROM public.continuous_effect_instances ci
    WHERE ci.id=_release_id FOR UPDATE;
    IF NOT FOUND OR NOT _link.active OR _link.battle_id<>_battle_id OR
      _link.character_ability_id<>_character_ability_id OR
      COALESCE(_link.rule->>'on_limit','replace_oldest')<>'choose' OR
      _link.target_character_id=ANY(COALESCE(_hit_target_ids,array[]::uuid[])) THEN
      RAISE EXCEPTION 'A vítima anterior não está mais vinculada a esta habilidade. Atualize a lista de alvos.';
    END IF;
    PERFORM public.finish_continuous_instance_internal(_release_id,false);
  END LOOP;
  IF _repeat THEN
    _result:=public.repeat_character_ability_attack(
      _character_ability_id,_target_character_id,_battle_id,
      _extra_mana_cost,_hit_target_ids,_hit_effect_groups,
      _dot_target_selections,_dot_attribute_values);
  ELSE
    _result:=public.activate_character_ability_attack(
      _character_ability_id,_target_character_id,_battle_id,
      _extra_mana_cost,_hit_target_ids,_hit_effect_groups,
      _dot_target_selections,_dot_attribute_values);
  END IF;
  RETURN _result;
END;
$fn$;
REVOKE ALL ON FUNCTION public.attack_with_continuous_transfer(uuid,uuid,uuid,integer,uuid[],jsonb,jsonb,jsonb,uuid[],boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.attack_with_continuous_transfer(uuid,uuid,uuid,integer,uuid[],jsonb,jsonb,jsonb,uuid[],boolean) TO authenticated;
