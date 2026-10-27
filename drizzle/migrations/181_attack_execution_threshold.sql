-- Optional finishing blow for Attack-enabled abilities.
-- Percent compares current HP with maximum recorded HP, without rounding up.
-- Only confirmed hit targets are tested. The master is always required.
-- Activation and repeated-hit RPCs call this inside the attack transaction.

CREATE OR REPLACE FUNCTION public.execute_attack_targets_internal(
  _character_ability_id uuid, _battle_id uuid, _hit_target_ids uuid[]
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  _ca public.character_abilities%ROWTYPE;
  _config jsonb;
  _enabled boolean;
  _mode text;
  _threshold numeric;
  _target uuid;
  _current integer;
  _maximum integer;
  _executed integer := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode executar alvos por habilidade';
  END IF;
  IF _hit_target_ids IS NULL OR cardinality(_hit_target_ids)=0 THEN RETURN 0; END IF;
  IF _battle_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.battles WHERE id=_battle_id AND active) THEN
    RAISE EXCEPTION 'A execução exige uma batalha ativa';
  END IF;
  SELECT * INTO _ca FROM public.character_abilities WHERE id=_character_ability_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Habilidade não encontrada'; END IF;
  IF _ca.ability_id IS NOT NULL THEN
    SELECT a.attack_damage INTO _config FROM public.abilities a
      WHERE a.id=_ca.ability_id AND a.attack_enabled=true;
    IF NOT FOUND THEN RAISE EXCEPTION 'A habilidade do catálogo não permite Atacar'; END IF;
  ELSE
    IF _ca.attack_enabled IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Esta habilidade não permite Atacar';
    END IF;
    _config:=_ca.attack_damage;
  END IF;
  _enabled:=COALESCE((_config->>'execute_enabled')::boolean,false);
  IF NOT _enabled THEN RETURN 0; END IF;
  _mode:=COALESCE(_config->>'execute_mode','percent');
  IF _mode NOT IN ('percent','fixed') THEN RAISE EXCEPTION 'Modo de execução inválido'; END IF;
  IF jsonb_typeof(_config->'execute_threshold') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'Informe o limite de HP para a execução';
  END IF;
  _threshold:=(_config->>'execute_threshold')::numeric;
  IF _threshold<0 OR _threshold>(CASE WHEN _mode='percent' THEN 100 ELSE 1000000 END)
      OR (_mode='fixed' AND _threshold<>trunc(_threshold)) THEN
    RAISE EXCEPTION 'Limite de execução fora do intervalo permitido';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.battle_participants bp
    WHERE bp.battle_id=_battle_id AND bp.character_id=_ca.character_id) THEN
    RAISE EXCEPTION 'O usuário da habilidade não está na batalha';
  END IF;

  -- Stable ordering avoids deadlocks when more than one victim is hit.
  FOR _target IN SELECT DISTINCT id FROM unnest(_hit_target_ids) AS hits(id) ORDER BY id LOOP
    IF _target IS NULL OR _target=_ca.character_id OR NOT EXISTS(
      SELECT 1 FROM public.battle_participants bp
      WHERE bp.battle_id=_battle_id AND bp.character_id=_target
    ) THEN
      RAISE EXCEPTION 'Alvo de execução inválido ou não atingido';
    END IF;
    SELECT current_value,max_value INTO _current,_maximum
      FROM public.character_attributes
      WHERE character_id=_target AND attribute_key='hp' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'O alvo não possui HP cadastrado'; END IF;
    IF _current>0 AND _maximum>0 AND
       ((_mode='percent' AND _current::numeric*100<=_maximum::numeric*_threshold)
        OR (_mode='fixed' AND _current<=_threshold)) THEN
      UPDATE public.character_attributes SET current_value=0,updated_at=now()
      WHERE character_id=_target AND attribute_key='hp';
      _executed:=_executed+1;
    END IF;
  END LOOP;
  RETURN _executed;
END;
$fn$;
REVOKE ALL ON FUNCTION public.execute_attack_targets_internal(uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated;

-- Both paid first hits and subsequent hits in a multi-target sequence support
-- finishing blows, including attacks that deal zero direct damage.
DO $patch$
DECLARE _name text; _src text; _from text; _into text;
BEGIN
  FOR _name IN SELECT unnest(ARRAY['activate_character_ability_attack','repeat_character_ability_attack']) LOOP
    SELECT pg_get_functiondef(p.oid) INTO _src
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
      AND p.proname=_name;
    IF _src IS NULL THEN RAISE EXCEPTION 'RPC de ataque não encontrada: %',_name; END IF;

    IF _name='activate_character_ability_attack' THEN
      _from:='  return _effective_mana_cost;
end;';
      _into:='  IF _effective_battle_id IS NOT NULL AND _hit_target_ids IS NOT NULL THEN
    PERFORM public.execute_attack_targets_internal(_assignment.id,_effective_battle_id,_hit_target_ids);
  END IF;
  return _effective_mana_cost;
end;';
    ELSE
      _from:='  return 0;
end;';
      _into:='  IF _effective_battle_id IS NOT NULL AND _hit_target_ids IS NOT NULL THEN
    PERFORM public.execute_attack_targets_internal(_assignment.id,_effective_battle_id,_hit_target_ids);
  END IF;
  return 0;
end;';
    END IF;
    IF position(_from in _src)=0 THEN RAISE EXCEPTION 'Finalização do ataque mudou: %',_name; END IF;
    EXECUTE replace(_src,_from,_into);
  END LOOP;
END;
$patch$;