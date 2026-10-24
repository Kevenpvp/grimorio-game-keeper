-- Keep DoT resistance scoped to the same battle and scale its numeric value when a virtue multiplier applies.
BEGIN;

CREATE OR REPLACE FUNCTION public.scale_racial_virtue_effect_json(_value jsonb, _multiplier numeric)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  _result jsonb;
  _key text;
  _item jsonb;
BEGIN
  IF jsonb_typeof(_value) = 'array' THEN
    SELECT coalesce(jsonb_agg(public.scale_racial_virtue_effect_json(value, _multiplier) ORDER BY ord), '[]'::jsonb)
      INTO _result
      FROM jsonb_array_elements(_value) WITH ORDINALITY AS items(value, ord);
    RETURN _result;
  ELSIF jsonb_typeof(_value) = 'object' THEN
    _result := '{}'::jsonb;
    FOR _key, _item IN SELECT key, value FROM jsonb_each(_value)
    LOOP
      IF _key IN (
        'amount', 'healing_hp_amount', 'healing_mana_amount',
        'healing_body_amount', 'healing_sanity_amount',
        'magic_healing_reversal_custom_damage', 'dot_resistance_amount'
      ) AND jsonb_typeof(_item) = 'number' THEN
        _result := _result || jsonb_build_object(_key, to_jsonb((_item #>> '{}')::numeric * _multiplier));
      ELSE
        _result := _result || jsonb_build_object(_key, public.scale_racial_virtue_effect_json(_item, _multiplier));
      END IF;
    END LOOP;
    RETURN _result;
  END IF;
  RETURN _value;
END;
$function$;

DO $security$
DECLARE
  _definition text;
BEGIN
  SELECT pg_get_functiondef('public.apply_dot_resistance_before_insert()'::regprocedure) INTO _definition;
  _definition := replace(
    _definition,
    'AND (e.battle_id IS NULL OR NEW.battle_id IS NULL OR e.battle_id = NEW.battle_id)',
    'AND (e.battle_id IS NULL OR e.battle_id = NEW.battle_id)'
  );
  EXECUTE _definition;

  REVOKE ALL ON FUNCTION public.apply_dot_resistance_before_insert() FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.remove_character_linked_trait_items() FROM PUBLIC, anon, authenticated;
END;
$security$;

NOTIFY pgrst, 'reload schema';
COMMIT;
