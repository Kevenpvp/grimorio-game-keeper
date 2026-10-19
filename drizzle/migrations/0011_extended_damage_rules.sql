-- Expand damage rules for magical levels, hybrid and true damage.
-- Ensure the magical damage types table exists even when this file is applied manually by itself.
CREATE TABLE IF NOT EXISTS public.damage_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.damage_types (name)
SELECT v.name
FROM (VALUES ('Fogo'), ('Luz'), ('Trevas'), ('Sagrado')) AS v(name)
WHERE NOT EXISTS (
  SELECT 1 FROM public.damage_types dt WHERE lower(dt.name) = lower(v.name)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.damage_types TO authenticated;
GRANT ALL ON public.damage_types TO service_role;
ALTER TABLE public.damage_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "damage types readable" ON public.damage_types;
CREATE POLICY "damage types readable" ON public.damage_types
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "master manages damage types" ON public.damage_types;
CREATE POLICY "master manages damage types" ON public.damage_types
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master'))
  WITH CHECK (public.has_role(auth.uid(), 'master'));

-- Replace the earlier combat-only RPC with the extended signature.
DROP FUNCTION IF EXISTS public.apply_battle_damage(uuid, uuid, text, uuid, jsonb);

CREATE OR REPLACE FUNCTION public.apply_battle_damage(
  _battle_id uuid,
  _character_id uuid,
  _damage_kind text,
  _damage_type_id uuid,
  _damage_values jsonb,
  _magic_level text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _physical_defense numeric := 0;
  _magical_defense numeric := 0;
  _hp_before integer;
  _hp_after integer;
  _total_damage integer := 0;
  _hits integer := 0;
  _raw numeric;
  _rounded_raw integer;
  _dealt integer;
  _physical_part integer;
  _magical_part integer;
  _item jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode aplicar dano';
  END IF;

  IF _damage_kind IS NULL OR _damage_kind NOT IN ('physical', 'magical', 'hybrid', 'true') THEN
    RAISE EXCEPTION 'Tipo de dano inválido';
  END IF;

  IF _damage_values IS NULL
     OR jsonb_typeof(_damage_values) IS DISTINCT FROM 'array'
     OR jsonb_array_length(_damage_values) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Informe de 1 a 200 valores de dano';
  END IF;

  IF _battle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.battle_participants
    WHERE battle_id = _battle_id AND character_id = _character_id
  ) THEN
    RAISE EXCEPTION 'O alvo não participa desta batalha';
  END IF;

  IF _damage_kind IN ('magical', 'hybrid') THEN
    IF _damage_type_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.damage_types WHERE id = _damage_type_id
    ) THEN
      RAISE EXCEPTION 'Selecione um tipo de dano mágico válido';
    END IF;
    IF _magic_level IS NULL OR _magic_level NOT IN ('baixa', 'media', 'alta') THEN
      RAISE EXCEPTION 'Selecione o nível da magia: baixa, média ou alta';
    END IF;
  ELSIF _magic_level IS NOT NULL THEN
    RAISE EXCEPTION 'Nível de magia só pode ser usado em dano mágico ou híbrido';
  END IF;

  SELECT ca.current_value INTO _hp_before
  FROM public.character_attributes ca
  WHERE ca.character_id = _character_id AND ca.attribute_key = 'hp'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'O alvo não possui atributo de HP';
  END IF;

  -- Compute physical and magical defense once; hybrid damage uses both.
  SELECT
    COALESCE(MAX(CASE WHEN ad.key = 'phys_def' THEN
      CASE
        WHEN ad.accepts_points THEN
          round(ad.base_value + (ca.points + COALESCE((r.modifiers ->> ad.key)::numeric, 0)) * ad.points_multiplier + ca.bonus)
        ELSE
          ca.max_value + COALESCE((r.modifiers ->> ad.key)::numeric, 0) + ca.bonus
      END
    END), 0),
    COALESCE(MAX(CASE WHEN ad.key = 'mag_def' THEN
      CASE
        WHEN ad.accepts_points THEN
          round(ad.base_value + (ca.points + COALESCE((r.modifiers ->> ad.key)::numeric, 0)) * ad.points_multiplier + ca.bonus)
        ELSE
          ca.max_value + COALESCE((r.modifiers ->> ad.key)::numeric, 0) + ca.bonus
      END
    END), 0)
  INTO _physical_defense, _magical_defense
  FROM public.attribute_definitions ad
  JOIN public.character_attributes ca
    ON ca.attribute_key = ad.key AND ca.character_id = _character_id
  JOIN public.characters c ON c.id = ca.character_id
  LEFT JOIN public.races r ON r.id = c.race_id
  WHERE ad.key IN ('phys_def', 'mag_def');

  _physical_defense := GREATEST(0, COALESCE(_physical_defense, 0));
  _magical_defense := GREATEST(0, COALESCE(_magical_defense, 0));

  FOR _item IN SELECT elem FROM jsonb_array_elements(_damage_values) AS items(elem) LOOP
    IF jsonb_typeof(_item) <> 'number' THEN
      RAISE EXCEPTION 'Cada dano precisa ser um número';
    END IF;
    _raw := (_item #>> '{}')::numeric;
    IF _raw < 0 OR _raw > 1000000 THEN
      RAISE EXCEPTION 'Cada dano deve ficar entre 0 e 1000000';
    END IF;

    _rounded_raw := round(_raw)::integer;

    IF _damage_kind = 'physical' THEN
      _dealt := GREATEST(0, _rounded_raw - _physical_defense)::integer;
    ELSIF _damage_kind = 'magical' THEN
      _dealt := GREATEST(0, _rounded_raw - _magical_defense)::integer;
    ELSIF _damage_kind = 'hybrid' THEN
      -- Split odd values without losing damage: physical gets floor, magical gets the remainder.
      _physical_part := floor(_rounded_raw / 2.0)::integer;
      _magical_part := _rounded_raw - _physical_part;
      _dealt := (
        GREATEST(0, _physical_part - _physical_defense)
        + GREATEST(0, _magical_part - _magical_defense)
      )::integer;
    ELSE
      -- True damage ignores both defenses.
      _dealt := _rounded_raw;
    END IF;

    _total_damage := _total_damage + _dealt;
    _hits := _hits + 1;
  END LOOP;

  _hp_after := GREATEST(0, _hp_before - _total_damage);
  UPDATE public.character_attributes
  SET current_value = _hp_after, updated_at = now()
  WHERE character_id = _character_id AND attribute_key = 'hp';

  RETURN jsonb_build_object(
    'hits', _hits,
    'physical_defense', _physical_defense,
    'magical_defense', _magical_defense,
    'total_damage', _total_damage,
    'hp_before', _hp_before,
    'hp_after', _hp_after,
    'damage_kind', _damage_kind,
    'magic_level', _magic_level
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_battle_damage(uuid, uuid, text, uuid, jsonb, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.apply_battle_damage(uuid, uuid, text, uuid, jsonb, text) TO authenticated;
