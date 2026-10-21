-- Critical damage doubles the actual post-defense/post-mitigation result.
-- Keep base damage, critical multiplier, and final HP update inside one database transaction.

CREATE OR REPLACE FUNCTION public.apply_battle_damage_critical(
  _battle_id uuid,
  _character_id uuid,
  _damage_kind text,
  _damage_type_id uuid,
  _damage_values jsonb,
  _magic_level text,
  _source_character_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _result jsonb;
  _critical_values jsonb := '[]'::jsonb;
  _critical_total integer := 0;
  _hp_before integer := 0;
  _hp_after integer := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode aplicar dano crítico';
  END IF;

  -- Reuse the complete combat calculation, including attacker modifiers,
  -- defense, mitigation, Dano Recebido, and Invencível.
  _result := public.apply_battle_damage(
    _battle_id,
    _character_id,
    _damage_kind,
    _damage_type_id,
    _damage_values,
    _magic_level,
    _source_character_id
  );

  IF jsonb_typeof(_result->'final_damage_by_hit') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'O cálculo de dano não retornou os valores finais por golpe';
  END IF;

  SELECT
    COALESCE(jsonb_agg(to_jsonb(hit.critical_damage) ORDER BY hit.ordinality), '[]'::jsonb),
    COALESCE(SUM(hit.critical_damage), 0)::integer
  INTO _critical_values, _critical_total
  FROM (
    SELECT
      item.ordinality,
      LEAST(2000000, GREATEST(0, ROUND((item.value #>> '{}')::numeric * 2)))::integer AS critical_damage
    FROM jsonb_array_elements(_result->'final_damage_by_hit') WITH ORDINALITY AS item(value, ordinality)
  ) AS hit;

  _hp_before := COALESCE(NULLIF(_result->>'hp_before', '')::integer, 0);
  _hp_after := GREATEST(0, _hp_before - _critical_total);

  -- Apply the final HP in this same transaction. If anything fails, base damage
  -- rolls back too; a failed critical request can never leave only normal damage.
  UPDATE public.character_attributes
  SET current_value = _hp_after,
      updated_at = now()
  WHERE character_id = _character_id
    AND attribute_key = 'hp';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'O alvo não possui atributo de HP';
  END IF;

  RETURN _result || jsonb_build_object(
    'total_damage', _critical_total,
    'hp_after', _hp_after,
    'final_damage_by_hit', _critical_values,
    'critical_damage', true
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_battle_damage_critical(uuid, uuid, text, uuid, jsonb, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_battle_damage_critical(uuid, uuid, text, uuid, jsonb, text, uuid) TO authenticated;
