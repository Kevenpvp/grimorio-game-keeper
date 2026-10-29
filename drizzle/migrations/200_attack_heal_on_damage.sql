-- Attack damage healing ("Curar no Dano") is a master-authorized follow-up
-- to a confirmed hit. This function reads the saved configuration from the
-- ability/catalog, never from a free-form client-supplied healing amount.
-- Damage supplied by the caller is the final figure returned by ability-runtime
-- after defense, mitigation, criticals and custom script hooks.
CREATE OR REPLACE FUNCTION public.apply_ability_attack_on_hit_healing(
  _character_ability_id uuid,
  _battle_id uuid,
  _target_character_id uuid,
  _final_damage numeric
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = 'public'
AS $fn$
DECLARE
  _ability public.character_abilities%ROWTYPE;
  _config jsonb;
  _amount numeric;
  _heal_amount integer;
  _mode text;
  _hp_before integer;
  _hp_after integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode aplicar Curar no Dano';
  END IF;
  IF _battle_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.battles WHERE id=_battle_id AND active
  ) THEN RAISE EXCEPTION 'Curar no Dano exige batalha ativa'; END IF;
  IF _final_damage IS NULL OR _final_damage < 0 OR _final_damage > 1000000000 THEN
    RAISE EXCEPTION 'Dano final inválido para Curar no Dano';
  END IF;

  SELECT * INTO _ability FROM public.character_abilities
  WHERE id=_character_ability_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Habilidade não encontrada'; END IF;
  IF _target_character_id IS NULL OR _target_character_id=_ability.character_id OR NOT EXISTS (
    SELECT 1 FROM public.battle_participants bp
    WHERE bp.battle_id=_battle_id AND bp.character_id=_target_character_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.battle_participants bp
    WHERE bp.battle_id=_battle_id AND bp.character_id=_ability.character_id
  ) THEN
    RAISE EXCEPTION 'Curar no Dano exige um alvo atingido e um atacante na mesma batalha';
  END IF;

  IF _ability.ability_id IS NOT NULL THEN
    SELECT a.attack_damage INTO _config FROM public.abilities a
    WHERE a.id=_ability.ability_id AND a.attack_enabled IS TRUE;
    IF NOT FOUND THEN RETURN 0; END IF;
  ELSE
    IF _ability.attack_enabled IS DISTINCT FROM TRUE THEN RETURN 0; END IF;
    _config:=_ability.attack_damage;
  END IF;

  IF COALESCE((_config->>'heal_on_damage_enabled')::boolean,false) IS DISTINCT FROM TRUE THEN
    RETURN 0;
  END IF;
  _mode:=COALESCE(_config->>'heal_on_damage_mode','percent');
  IF _mode NOT IN ('fixed','percent') THEN RAISE EXCEPTION 'Modo de Curar no Dano inválido'; END IF;
  IF jsonb_typeof(_config->'heal_on_damage_amount') <> 'number' THEN
    RAISE EXCEPTION 'Quantidade de Curar no Dano inválida';
  END IF;
  _amount:=(_config->>'heal_on_damage_amount')::numeric;
  IF _amount < 0 OR _amount > (CASE WHEN _mode='percent' THEN 1000 ELSE 1000000 END)
    OR (_mode='fixed' AND _amount<>trunc(_amount)) THEN
    RAISE EXCEPTION 'Quantidade de Curar no Dano fora do limite permitido';
  END IF;
  -- Fixed healing triggers on any confirmed hit even when defense reduced
  -- its dealt damage to zero. Percent healing naturally yields zero there.
  _heal_amount:=CASE WHEN _mode='percent'
    THEN FLOOR(_final_damage*_amount/100)::integer ELSE _amount::integer END;
  IF _heal_amount<=0 THEN RETURN 0; END IF;

  SELECT current_value INTO _hp_before FROM public.character_attributes
  WHERE character_id=_ability.character_id AND attribute_key='hp' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'O usuário da habilidade não possui HP cadastrado'; END IF;

  -- Respect both the dynamic maximum HP and healing-blocked/reversal effects
  -- by using the same healing engine as regular abilities.
  PERFORM public.apply_ability_healing(_ability.character_id,_battle_id,
    jsonb_build_object(
      'healing_hp_enabled',true,
      'healing_hp_mode','fixed',
      'healing_hp_amount',_heal_amount,
      '_runtime_healer_character_id',_ability.character_id
    ),true,false);

  SELECT current_value INTO _hp_after FROM public.character_attributes
  WHERE character_id=_ability.character_id AND attribute_key='hp';
  RETURN GREATEST(0,COALESCE(_hp_after,0)-_hp_before);
END;
$fn$;

REVOKE ALL ON FUNCTION public.apply_ability_attack_on_hit_healing(uuid,uuid,uuid,numeric)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.apply_ability_attack_on_hit_healing(uuid,uuid,uuid,numeric)
  TO authenticated;
