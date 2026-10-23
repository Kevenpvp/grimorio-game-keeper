-- Per-character overrides for configured ability script attributes.
ALTER TABLE public.character_abilities
  ADD COLUMN IF NOT EXISTS custom_attributes jsonb;
ALTER TABLE public.character_abilities
  DROP CONSTRAINT IF EXISTS character_abilities_custom_attributes_array_check;
ALTER TABLE public.character_abilities
  ADD CONSTRAINT character_abilities_custom_attributes_array_check
  CHECK (custom_attributes IS NULL OR jsonb_typeof(custom_attributes) = 'array');

-- Owners may change values only, never the keys/types or the shared catalogue definition.
CREATE OR REPLACE FUNCTION public.update_character_ability_custom_attributes(
  _character_ability_id uuid,
  _custom_attributes jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _owner_id uuid;
  _ability_id uuid;
  _definitions jsonb;
  _normalized jsonb := '[]'::jsonb;
  _definition jsonb;
  _input jsonb;
  _key text;
  _type text;
  _number numeric;
  _value jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Faça login para alterar os atributos da habilidade'; END IF;
  IF jsonb_typeof(_custom_attributes) <> 'array' THEN RAISE EXCEPTION 'Os atributos personalizados precisam ser uma lista'; END IF;

  SELECT c.owner_id, ca.ability_id, a.custom_attributes
  INTO _owner_id, _ability_id, _definitions
  FROM public.character_abilities ca
  JOIN public.characters c ON c.id = ca.character_id
  LEFT JOIN public.abilities a ON a.id = ca.ability_id
  WHERE ca.id = _character_ability_id
  FOR UPDATE OF ca;

  IF NOT FOUND THEN RAISE EXCEPTION 'Habilidade não encontrada na ficha'; END IF;
  IF _owner_id IS DISTINCT FROM auth.uid() AND NOT public.has_role(auth.uid(), 'master') THEN
    RAISE EXCEPTION 'Você só pode alterar os atributos das habilidades da sua própria ficha';
  END IF;
  IF _ability_id IS NULL THEN RAISE EXCEPTION 'Esta habilidade exclusiva não possui atributos customizados do catálogo'; END IF;

  _definitions := CASE WHEN jsonb_typeof(coalesce(_definitions, '[]'::jsonb)) = 'array'
    THEN coalesce(_definitions, '[]'::jsonb) ELSE '[]'::jsonb END;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(_custom_attributes) AS provided(value)
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(_definitions) AS definition(value)
      WHERE definition.value->>'key' = provided.value->>'key'
    )
  ) THEN RAISE EXCEPTION 'A lista contém um atributo que não pertence a esta habilidade'; END IF;

  FOR _definition IN SELECT value FROM jsonb_array_elements(_definitions)
  LOOP
    _key := _definition->>'key';
    _type := _definition->>'type';
    SELECT value INTO _input
    FROM jsonb_array_elements(_custom_attributes) AS supplied(value)
    WHERE supplied.value->>'key' = _key
    LIMIT 1;
    IF NOT FOUND THEN _input := _definition;
    ELSIF _input->>'type' IS DISTINCT FROM _type THEN RAISE EXCEPTION 'Tipo inválido para o atributo %', _key;
    END IF;

    IF _type = 'number' THEN
      IF jsonb_typeof(_input->'value') <> 'number' THEN RAISE EXCEPTION 'O atributo % precisa ser numérico', _key; END IF;
      _number := (_input->>'value')::numeric;
      IF _number < -1000000 OR _number > 1000000 THEN RAISE EXCEPTION 'O atributo % precisa estar entre -1.000.000 e 1.000.000', _key; END IF;
      _value := jsonb_build_object('key', _key, 'name', coalesce(_definition->>'name', _key), 'type', _type, 'value', to_jsonb(_number));
    ELSIF _type = 'boolean' THEN
      IF jsonb_typeof(_input->'value') <> 'boolean' THEN RAISE EXCEPTION 'O atributo % precisa ser verdadeiro ou falso', _key; END IF;
      _value := jsonb_build_object('key', _key, 'name', coalesce(_definition->>'name', _key), 'type', _type, 'value', (_input->>'value')::boolean);
    ELSIF _type = 'string' THEN
      IF jsonb_typeof(_input->'value') <> 'string' OR length(_input->>'value') > 2000 THEN
        RAISE EXCEPTION 'O atributo % precisa ser um texto de até 2.000 caracteres', _key;
      END IF;
      _value := jsonb_build_object('key', _key, 'name', coalesce(_definition->>'name', _key), 'type', _type, 'value', _input->>'value');
    ELSE
      RAISE EXCEPTION 'Tipo de atributo não suportado: %', _type;
    END IF;
    _normalized := _normalized || jsonb_build_array(_value);
  END LOOP;

  UPDATE public.character_abilities SET custom_attributes = _normalized WHERE id = _character_ability_id;
  RETURN _normalized;
END;
$function$;
REVOKE ALL ON FUNCTION public.update_character_ability_custom_attributes(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_character_ability_custom_attributes(uuid, jsonb) TO authenticated;

-- Use the configured per-character Coração Corrompido ForcaBonus, then apply the
-- racial multiplier only for abilities granted by a virtue. The script passes
-- an already-scaled explicit bonus; calls without it resolve the saved setting here.
CREATE OR REPLACE FUNCTION public.sync_coracao_corrompido_strength_effect_internal(
  _character_id uuid,
  _bonus_strength numeric DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _heat numeric := 0;
  _heart record;
  _current_effects jsonb;
  _next_effects jsonb;
  _should_apply boolean;
  _attributes jsonb;
  _configured_bonus numeric;
  _effective_bonus numeric;
  _racial_multiplier numeric;
BEGIN
  IF _character_id IS NULL THEN RETURN; END IF;

  SELECT COALESCE(MAX(
    CASE
      WHEN ca.custom_state->>'dano_superaquecimento' ~ '^-?[0-9]+([.][0-9]+)?$'
        THEN GREATEST(0, (ca.custom_state->>'dano_superaquecimento')::numeric)
      ELSE 0
    END
  ), 0)
  INTO _heat
  FROM public.character_abilities ca
  JOIN public.abilities a ON a.id = ca.ability_id
  WHERE ca.character_id = _character_id
    AND (a.custom_script_key = 'demonio_interno' OR lower(btrim(a.name)) = lower('Demônio Interno'));

  FOR _heart IN
    SELECT ca.id, ca.cooldown_remaining, ca.passive_effects,
           ca.custom_attributes AS character_custom_attributes,
           ca.granted_by_virtue_id,
           a.custom_attributes AS catalog_custom_attributes,
           r.special_mechanics
    FROM public.character_abilities ca
    JOIN public.abilities a ON a.id = ca.ability_id
    JOIN public.characters c ON c.id = ca.character_id
    LEFT JOIN public.races r ON r.id = c.race_id
    WHERE ca.character_id = _character_id
      AND (a.custom_script_key = 'coracao_corrompido' OR lower(btrim(a.name)) = lower('Coração Corrompido'))
  LOOP
    _attributes := CASE
      WHEN jsonb_typeof(_heart.character_custom_attributes) = 'array' THEN _heart.character_custom_attributes
      WHEN jsonb_typeof(_heart.catalog_custom_attributes) = 'array' THEN _heart.catalog_custom_attributes
      ELSE '[]'::jsonb
    END;

    IF _bonus_strength IS NOT NULL THEN
      _effective_bonus := _bonus_strength; -- Already multiplied by the trusted Edge Function.
    ELSE
      SELECT COALESCE(MAX(
        CASE
          WHEN lower(regexp_replace(coalesce(attr.value->>'key', ''), '[^a-zA-Z0-9]', '', 'g')) = 'forcabonus'
            AND attr.value->>'type' = 'number'
            AND COALESCE(attr.value->>'value', '') ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN (attr.value->>'value')::numeric
          ELSE NULL
        END
      ), 0)
      INTO _configured_bonus
      FROM jsonb_array_elements(_attributes) AS attr(value);

      _racial_multiplier := 1;
      IF _heart.granted_by_virtue_id IS NOT NULL
         AND coalesce((_heart.special_mechanics->>'duplicate_virtue_effects')::boolean, false) THEN
        _racial_multiplier := greatest(1, least(10, coalesce(nullif(_heart.special_mechanics->>'virtue_effect_multiplier', '')::numeric, 2)));
      END IF;
      _effective_bonus := coalesce(_configured_bonus, 0) * _racial_multiplier;
    END IF;
    _effective_bonus := LEAST(1000000, GREATEST(0, COALESCE(_effective_bonus, 0)));

    _current_effects := CASE
      WHEN jsonb_typeof(COALESCE(_heart.passive_effects, '[]'::jsonb)) = 'array' THEN COALESCE(_heart.passive_effects, '[]'::jsonb)
      ELSE '[]'::jsonb
    END;

    SELECT COALESCE(jsonb_agg(item.effect ORDER BY item.ordinality), '[]'::jsonb)
    INTO _next_effects
    FROM jsonb_array_elements(_current_effects) WITH ORDINALITY AS item(effect, ordinality)
    WHERE item.effect->>'special_modifier_key' IS DISTINCT FROM 'coracao_corrompido_demonio_strength';

    _should_apply := COALESCE(_heart.cooldown_remaining, 0) > 0 AND _heat > 0 AND _effective_bonus > 0;
    IF _should_apply THEN
      _next_effects := _next_effects || jsonb_build_array(jsonb_build_object(
        'name', 'Coração Corrompido — Força do Demônio Interno',
        'effect_type', 'status', 'attribute_key', 'strength', 'polarity', 'buff',
        'value_mode', 'fixed', 'amount', _effective_bonus, 'duration', 1,
        'damage_scope', 'any', 'special_modifier_key', 'coracao_corrompido_demonio_strength'
      ));
    END IF;

    IF _current_effects IS DISTINCT FROM _next_effects THEN
      UPDATE public.character_abilities SET passive_effects = _next_effects WHERE id = _heart.id;
    END IF;
  END LOOP;
END;
$function$;

DROP TRIGGER IF EXISTS character_abilities_sync_coracao_strength_state ON public.character_abilities;
CREATE TRIGGER character_abilities_sync_coracao_strength_state
AFTER UPDATE OF custom_state, cooldown_remaining, can_activate, passive_effects, custom_attributes
ON public.character_abilities
FOR EACH ROW EXECUTE FUNCTION public.handle_coracao_corrompido_strength_sync();

-- Reapply virtue-granted values when a race's multiplier configuration changes.
CREATE OR REPLACE FUNCTION public.refresh_racial_virtue_effect_scaling()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE _character_id uuid;
BEGIN
  UPDATE public.character_abilities ca
  SET granted_by_virtue_id = ca.granted_by_virtue_id
  FROM public.characters c
  WHERE c.id = ca.character_id AND c.race_id = NEW.id
    AND ca.granted_by_virtue_id = c.virtue_id AND ca.ability_id IS NOT NULL;

  FOR _character_id IN
    SELECT c.id
    FROM public.characters c
    JOIN public.character_abilities ca ON ca.character_id = c.id
    JOIN public.abilities a ON a.id = ca.ability_id
    WHERE c.race_id = NEW.id
      AND (a.custom_script_key = 'coracao_corrompido' OR lower(btrim(a.name)) = lower('Coração Corrompido'))
  LOOP
    PERFORM public.sync_coracao_corrompido_strength_effect(_character_id);
  END LOOP;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_character_racial_virtue_abilities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  UPDATE public.character_abilities ca
  SET granted_by_virtue_id = ca.granted_by_virtue_id
  WHERE ca.character_id = NEW.id AND ca.granted_by_virtue_id IS NOT NULL AND ca.ability_id IS NOT NULL;
  PERFORM public.sync_coracao_corrompido_strength_effect(NEW.id);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS characters_refresh_racial_virtue_abilities ON public.characters;
CREATE TRIGGER characters_refresh_racial_virtue_abilities
AFTER UPDATE OF race_id, virtue_id ON public.characters
FOR EACH ROW EXECUTE FUNCTION public.refresh_character_racial_virtue_abilities();

-- When the catalogue default changes, refresh the runtime bonus for affected characters
-- unless they have a per-character override (the sync function handles the fallback).
CREATE OR REPLACE FUNCTION public.refresh_character_ability_custom_attributes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE _character_id uuid;
BEGIN
  FOR _character_id IN
    SELECT DISTINCT ca.character_id FROM public.character_abilities ca WHERE ca.ability_id = NEW.id
  LOOP
    PERFORM public.sync_coracao_corrompido_strength_effect(_character_id);
  END LOOP;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS abilities_refresh_character_coracao_attributes ON public.abilities;
CREATE TRIGGER abilities_refresh_character_coracao_attributes
AFTER UPDATE OF custom_attributes ON public.abilities
FOR EACH ROW EXECUTE FUNCTION public.refresh_character_ability_custom_attributes();

REVOKE ALL ON FUNCTION public.sync_coracao_corrompido_strength_effect_internal(uuid, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_racial_virtue_effect_scaling() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_character_racial_virtue_abilities() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_character_ability_custom_attributes() FROM PUBLIC, anon, authenticated;
