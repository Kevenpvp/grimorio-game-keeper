-- Bulk damage in combat mode, with master-managed magical damage subtypes.
CREATE TABLE public.damage_types (
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

CREATE POLICY "damage types readable" ON public.damage_types
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "master manages damage types" ON public.damage_types
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master'))
  WITH CHECK (public.has_role(auth.uid(), 'master'));

CREATE OR REPLACE FUNCTION public.apply_battle_damage(
  _battle_id uuid,
  _character_id uuid,
  _damage_kind text,
  _damage_type_id uuid,
  _damage_values jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _defense_key text;
  _defense numeric;
  _hp_before integer;
  _hp_after integer;
  _total_damage integer := 0;
  _hits integer := 0;
  _raw numeric;
  _dealt integer;
  _item jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode aplicar dano';
  END IF;

  IF _damage_kind NOT IN ('physical', 'magical') THEN
    RAISE EXCEPTION 'Tipo de dano inválido';
  END IF;

  IF jsonb_typeof(_damage_values) <> 'array'
     OR jsonb_array_length(_damage_values) < 1
     OR jsonb_array_length(_damage_values) > 200 THEN
    RAISE EXCEPTION 'Informe de 1 a 200 valores de dano';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.battle_participants
    WHERE battle_id = _battle_id AND character_id = _character_id
  ) THEN
    RAISE EXCEPTION 'O alvo não participa desta batalha';
  END IF;

  IF _damage_kind = 'magical' THEN
    IF _damage_type_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.damage_types WHERE id = _damage_type_id
    ) THEN
      RAISE EXCEPTION 'Selecione um tipo de dano mágico válido';
    END IF;
    _defense_key := 'mag_def';
  ELSE
    _defense_key := 'phys_def';
  END IF;

  SELECT ca.current_value INTO _hp_before
  FROM public.character_attributes ca
  WHERE ca.character_id = _character_id AND ca.attribute_key = 'hp'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'O alvo não possui atributo de HP';
  END IF;

  SELECT CASE
    WHEN ad.accepts_points THEN
      round(ad.base_value + (ca.points + COALESCE((r.modifiers ->> ad.key)::numeric, 0)) * ad.points_multiplier + ca.bonus)
    ELSE
      ca.max_value + COALESCE((r.modifiers ->> ad.key)::numeric, 0) + ca.bonus
  END
  INTO _defense
  FROM public.attribute_definitions ad
  JOIN public.character_attributes ca
    ON ca.attribute_key = ad.key AND ca.character_id = _character_id
  JOIN public.characters c ON c.id = ca.character_id
  LEFT JOIN public.races r ON r.id = c.race_id
  WHERE ad.key = _defense_key;

  _defense := GREATEST(0, COALESCE(_defense, 0));

  FOR _item IN SELECT value FROM jsonb_array_elements(_damage_values) AS values(value) LOOP
    IF jsonb_typeof(_item) <> 'number' THEN
      RAISE EXCEPTION 'Cada dano precisa ser um número';
    END IF;
    _raw := (_item #>> '{}')::numeric;
    IF _raw < 0 OR _raw > 1000000 THEN
      RAISE EXCEPTION 'Cada dano deve ficar entre 0 e 1000000';
    END IF;

    _dealt := GREATEST(0, round(_raw) - _defense)::integer;
    _total_damage := _total_damage + _dealt;
    _hits := _hits + 1;
  END LOOP;

  _hp_after := GREATEST(0, _hp_before - _total_damage);
  UPDATE public.character_attributes
  SET current_value = _hp_after, updated_at = now()
  WHERE character_id = _character_id AND attribute_key = 'hp';

  RETURN jsonb_build_object(
    'hits', _hits,
    'defense', _defense,
    'total_damage', _total_damage,
    'hp_before', _hp_before,
    'hp_after', _hp_after
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_battle_damage(uuid, uuid, text, uuid, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.apply_battle_damage(uuid, uuid, text, uuid, jsonb) TO authenticated;
