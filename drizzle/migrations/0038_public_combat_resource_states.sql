-- Player combat views need public health/mana conditions without exposing opponents' exact numbers.
CREATE OR REPLACE FUNCTION public.get_battle_character_public_states(_battle_id uuid)
RETURNS TABLE (
  character_id uuid,
  hp_state text,
  mana_state text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;

  IF NOT public.has_role(auth.uid(), 'master') AND NOT EXISTS (
    SELECT 1
    FROM public.battle_participants bp
    JOIN public.characters c ON c.id = bp.character_id
    WHERE bp.battle_id = _battle_id
      AND c.owner_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Você não participa desta batalha';
  END IF;

  RETURN QUERY
  SELECT
    c.id AS character_id,
    CASE
      WHEN COALESCE(hp.current_value, 0) <= 0 THEN 'Morto'
      WHEN COALESCE(hp.current_value, 0)::numeric
        / GREATEST(public.calculate_character_resource_max(c.id, 'hp'), 1) >= 0.7 THEN 'Saudável'
      WHEN COALESCE(hp.current_value, 0)::numeric
        / GREATEST(public.calculate_character_resource_max(c.id, 'hp'), 1) > 0.3 THEN 'Machucado'
      ELSE 'Crítico'
    END AS hp_state,
    CASE
      WHEN COALESCE(mana.current_value, 0) <= 0
        OR COALESCE(public.calculate_character_resource_max(c.id, 'mana'), 0) <= 0 THEN 'Sem Mana'
      WHEN COALESCE(mana.current_value, 0)::numeric
        / GREATEST(public.calculate_character_resource_max(c.id, 'mana'), 1) >= 0.7 THEN 'Cheia'
      WHEN COALESCE(mana.current_value, 0)::numeric
        / GREATEST(public.calculate_character_resource_max(c.id, 'mana'), 1) > 0.3 THEN 'Mediana'
      ELSE 'Acabando'
    END AS mana_state
  FROM public.battle_participants bp
  JOIN public.characters c ON c.id = bp.character_id
  LEFT JOIN public.character_attributes hp
    ON hp.character_id = c.id AND hp.attribute_key = 'hp'
  LEFT JOIN public.character_attributes mana
    ON mana.character_id = c.id AND mana.attribute_key = 'mana'
  WHERE bp.battle_id = _battle_id
  ORDER BY bp.sort_order;
END;
$$;

REVOKE ALL ON FUNCTION public.get_battle_character_public_states(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_battle_character_public_states(uuid) TO authenticated;
