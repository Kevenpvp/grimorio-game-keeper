ALTER TABLE public.races
  ADD COLUMN IF NOT EXISTS special_mechanics jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.races
  DROP CONSTRAINT IF EXISTS races_special_mechanics_object_check;
ALTER TABLE public.races
  ADD CONSTRAINT races_special_mechanics_object_check CHECK (jsonb_typeof(special_mechanics) = 'object');

CREATE OR REPLACE FUNCTION public.scale_racial_virtue_effect_json(_value jsonb, _multiplier numeric)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
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
        'magic_healing_reversal_custom_damage'
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

CREATE OR REPLACE FUNCTION public.apply_racial_virtue_effect_scaling()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _base public.abilities%ROWTYPE;
  _mechanics jsonb;
  _multiplier numeric := 1;
BEGIN
  IF NEW.ability_id IS NULL OR NEW.granted_by_virtue_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT a.* INTO _base FROM public.abilities a WHERE a.id = NEW.ability_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT coalesce(r.special_mechanics, '{}'::jsonb) INTO _mechanics
  FROM public.characters c
  LEFT JOIN public.races r ON r.id = c.race_id
  WHERE c.id = NEW.character_id;

  IF coalesce((_mechanics ->> 'duplicate_virtue_effects')::boolean, false) THEN
    _multiplier := greatest(1, least(10, coalesce(nullif(_mechanics ->> 'virtue_effect_multiplier', '')::numeric, 2)));
  END IF;

  IF _multiplier > 1 THEN
    NEW.effects := public.scale_racial_virtue_effect_json(coalesce(_base.effects, '[]'::jsonb), _multiplier);
    NEW.passive_effects := public.scale_racial_virtue_effect_json(coalesce(_base.passive_effects, '[]'::jsonb), _multiplier);
    NEW.end_effects := public.scale_racial_virtue_effect_json(coalesce(_base.end_effects, '[]'::jsonb), _multiplier);
  ELSE
    NEW.effects := coalesce(_base.effects, '[]'::jsonb);
    NEW.passive_effects := coalesce(_base.passive_effects, '[]'::jsonb);
    NEW.end_effects := coalesce(_base.end_effects, '[]'::jsonb);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS character_abilities_racial_virtue_effect_scaling ON public.character_abilities;
CREATE TRIGGER character_abilities_racial_virtue_effect_scaling
BEFORE INSERT OR UPDATE OF ability_id, character_id, granted_by_virtue_id
ON public.character_abilities
FOR EACH ROW EXECUTE FUNCTION public.apply_racial_virtue_effect_scaling();

CREATE OR REPLACE FUNCTION public.refresh_racial_virtue_effect_scaling()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  UPDATE public.character_abilities ca
  SET granted_by_virtue_id = ca.granted_by_virtue_id
  FROM public.characters c
  WHERE c.id = ca.character_id
    AND c.race_id = NEW.id
    AND ca.granted_by_virtue_id = c.virtue_id
    AND ca.ability_id IS NOT NULL;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS races_refresh_racial_virtue_effect_scaling ON public.races;
CREATE TRIGGER races_refresh_racial_virtue_effect_scaling
AFTER UPDATE OF special_mechanics ON public.races
FOR EACH ROW EXECUTE FUNCTION public.refresh_racial_virtue_effect_scaling();

REVOKE ALL ON FUNCTION public.scale_racial_virtue_effect_json(jsonb, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scale_racial_virtue_effect_json(jsonb, numeric) TO service_role;
REVOKE ALL ON FUNCTION public.apply_racial_virtue_effect_scaling() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_racial_virtue_effect_scaling() FROM PUBLIC, anon, authenticated;
