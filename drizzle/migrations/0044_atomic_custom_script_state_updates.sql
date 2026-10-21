-- Atomic numeric custom-state adjustment for custom ability event handlers.
CREATE OR REPLACE FUNCTION public.adjust_character_ability_custom_state_number(
  _character_ability_id uuid,
  _key text,
  _delta numeric,
  _minimum numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _state jsonb;
BEGIN
  IF _key IS NULL OR trim(_key) = '' OR length(_key) > 120 THEN
    RAISE EXCEPTION 'Chave de estado inválida';
  END IF;
  IF _delta IS NULL OR abs(_delta) > 1000000000000 THEN
    RAISE EXCEPTION 'Ajuste de estado inválido';
  END IF;
  IF _minimum IS NULL OR abs(_minimum) > 1000000000000 THEN
    RAISE EXCEPTION 'Limite mínimo de estado inválido';
  END IF;

  UPDATE public.character_abilities
  SET custom_state = jsonb_set(
    custom_state,
    ARRAY[_key],
    to_jsonb(GREATEST(
      _minimum,
      COALESCE(NULLIF(custom_state->>_key, '')::numeric, 0) + _delta
    )),
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

REVOKE ALL ON FUNCTION public.adjust_character_ability_custom_state_number(uuid, text, numeric, numeric)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_character_ability_custom_state_number(uuid, text, numeric, numeric)
  TO service_role;
