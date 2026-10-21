-- Make damage correction and per-ability numeric state increments safe against concurrent combat actions.

CREATE OR REPLACE FUNCTION public.adjust_character_hp_for_custom_damage(
  _character_id uuid,
  _damage_delta integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _hp_after integer;
  _hp_max numeric;
BEGIN
  IF _damage_delta IS NULL OR abs(_damage_delta) > 2000000000 THEN
    RAISE EXCEPTION 'Ajuste de dano inválido';
  END IF;

  _hp_max := GREATEST(0, public.calculate_character_resource_max(_character_id, 'hp'));

  UPDATE public.character_attributes
  SET current_value = GREATEST(0, LEAST(round(_hp_max), current_value - _damage_delta))::integer,
      updated_at = now()
  WHERE character_id = _character_id AND attribute_key = 'hp'
  RETURNING current_value INTO _hp_after;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'A ficha não possui atributo HP';
  END IF;

  RETURN _hp_after;
END;
$function$;

REVOKE ALL ON FUNCTION public.adjust_character_hp_for_custom_damage(uuid, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_character_hp_for_custom_damage(uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.increment_character_ability_custom_state_number(
  _character_ability_id uuid,
  _key text,
  _delta numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _state jsonb;
  _current numeric;
BEGIN
  IF _key IS NULL OR trim(_key) = '' OR length(_key) > 120 THEN
    RAISE EXCEPTION 'Chave de estado inválida';
  END IF;
  IF _delta IS NULL OR abs(_delta) > 1000000000000 THEN
    RAISE EXCEPTION 'Incremento de estado inválido';
  END IF;

  UPDATE public.character_abilities
  SET custom_state = jsonb_set(
    custom_state,
    ARRAY[_key],
    to_jsonb(COALESCE(NULLIF(custom_state->>_key, '')::numeric, 0) + _delta),
    true
  )
  WHERE id = _character_ability_id
  RETURNING custom_state INTO _state;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Habilidade não encontrada na ficha';
  END IF;

  RETURN _state;
END;
$function$;

REVOKE ALL ON FUNCTION public.increment_character_ability_custom_state_number(uuid, text, numeric) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_character_ability_custom_state_number(uuid, text, numeric) TO service_role;
