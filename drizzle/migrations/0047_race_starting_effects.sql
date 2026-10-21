-- Race traits can grant persistent buffs/debuffs in addition to stats and abilities.
ALTER TABLE public.races
  ADD COLUMN IF NOT EXISTS starting_effects jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.races
  DROP CONSTRAINT IF EXISTS races_starting_effects_check;
ALTER TABLE public.races
  ADD CONSTRAINT races_starting_effects_check
  CHECK (jsonb_typeof(starting_effects) = 'array');

ALTER TABLE public.battle_effects
  ADD COLUMN IF NOT EXISTS source_race_id uuid REFERENCES public.races(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS source_race_effect_index integer;

ALTER TABLE public.battle_effects
  DROP CONSTRAINT IF EXISTS battle_effects_race_effect_source_check;
ALTER TABLE public.battle_effects
  ADD CONSTRAINT battle_effects_race_effect_source_check
  CHECK (
    (source_race_id IS NULL AND source_race_effect_index IS NULL)
    OR
    (source_race_id IS NOT NULL AND source_race_effect_index IS NOT NULL AND source_race_effect_index >= 0)
  );

ALTER TABLE public.battle_effects
  DROP CONSTRAINT IF EXISTS battle_effects_race_effect_key;
ALTER TABLE public.battle_effects
  ADD CONSTRAINT battle_effects_race_effect_key
  UNIQUE (character_id, source_race_id, source_race_effect_index);

-- Players can inspect their own racial effects even when they are not currently in a battle.
CREATE POLICY "players read own racial effects"
  ON public.battle_effects
  FOR SELECT
  TO authenticated
  USING (
    source_race_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.characters c
      WHERE c.id = public.battle_effects.character_id
        AND c.owner_id = auth.uid()
    )
  );

-- Racial effects are permanent while the character has the race.
-- The existing combat turn code still visits these rows, so preserve their positive duration.
CREATE OR REPLACE FUNCTION public.preserve_racial_effect_duration()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  IF OLD.source_race_id IS NOT NULL AND NEW.source_race_id = OLD.source_race_id THEN
    NEW.duration := OLD.duration;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS battle_effects_preserve_racial_duration ON public.battle_effects;
CREATE TRIGGER battle_effects_preserve_racial_duration
BEFORE UPDATE OF duration ON public.battle_effects
FOR EACH ROW
EXECUTE FUNCTION public.preserve_racial_effect_duration();

REVOKE ALL ON FUNCTION public.preserve_racial_effect_duration() FROM PUBLIC, anon, authenticated;

-- Synchronize the race's permanent effects onto a character, keeping a stable row per effect index.
-- Using upsert avoids firing insert/delete hooks whenever the master edits an unchanged effect.
CREATE OR REPLACE FUNCTION public.sync_character_race_effects(_character_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _race_id uuid;
  _starting_effects jsonb := '[]'::jsonb;
  _effect jsonb;
  _effect_index integer;
  _effect_type text;
  _stored_type text;
  _attribute_key text;
  _polarity text;
  _value_mode text;
  _amount numeric;
  _damage_scope text;
  _reduction_scope text;
  _type_ids uuid[];
  _magic_levels text[];
  _effect_name text;
BEGIN
  SELECT c.race_id
  INTO _race_id
  FROM public.characters c
  WHERE c.id = _character_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Remove only effects supplied by a previous race. Ability and manual effects remain untouched.
  DELETE FROM public.battle_effects e
  WHERE e.character_id = _character_id
    AND e.source_race_id IS NOT NULL
    AND e.source_race_id IS DISTINCT FROM _race_id;

  IF _race_id IS NULL THEN
    RETURN;
  END IF;

  SELECT r.starting_effects
  INTO _starting_effects
  FROM public.races r
  WHERE r.id = _race_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF jsonb_typeof(COALESCE(_starting_effects, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Os efeitos iniciais da raça precisam ser uma lista.';
  END IF;

  FOR _effect, _effect_index IN
    SELECT item.value, (item.ordinality - 1)::integer
    FROM jsonb_array_elements(COALESCE(_starting_effects, '[]'::jsonb))
      WITH ORDINALITY AS item(value, ordinality)
  LOOP
    _effect_type := COALESCE(NULLIF(_effect ->> 'effect_type', ''), 'status');
    IF _effect_type NOT IN (
      'status', 'regeneration', 'mana_regeneration', 'mana_used',
      'no_regen_hp', 'no_regen_mana', 'magic_prohibition', 'stun',
      'damage_dealt', 'no_mana', 'damage_reduction', 'invincible', 'healing_blocked'
    ) THEN
      RAISE EXCEPTION 'Tipo de efeito racial inválido: %', _effect_type;
    END IF;

    -- Mana regeneration uses the existing battle-effect regeneration implementation.
    _stored_type := CASE WHEN _effect_type = 'mana_regeneration' THEN 'regeneration' ELSE _effect_type END;
    _attribute_key := CASE
      WHEN _stored_type = 'status' THEN NULLIF(_effect ->> 'attribute_key', '')
      WHEN _stored_type = 'regeneration' THEN
        CASE WHEN _effect_type = 'mana_regeneration' THEN 'mana' ELSE NULLIF(_effect ->> 'attribute_key', '') END
      ELSE NULL
    END;
    IF _stored_type = 'status' AND _attribute_key IS NULL THEN
      RAISE EXCEPTION 'Efeito racial de status precisa escolher um atributo.';
    END IF;
    IF _stored_type = 'regeneration' AND _attribute_key NOT IN ('hp', 'mana') THEN
      RAISE EXCEPTION 'Efeito racial de regeneração precisa usar HP ou Mana.';
    END IF;

    _polarity := CASE
      WHEN _stored_type IN ('magic_prohibition', 'no_mana', 'healing_blocked') THEN 'debuff'
      WHEN _stored_type IN ('damage_reduction', 'invincible') THEN 'buff'
      ELSE COALESCE(NULLIF(_effect ->> 'polarity', ''), 'buff')
    END;
    _value_mode := CASE WHEN _effect ->> 'value_mode' = 'percent' THEN 'percent' ELSE 'fixed' END;
    _amount := GREATEST(0, COALESCE(NULLIF(_effect ->> 'amount', '')::numeric, 0));
    _damage_scope := CASE WHEN _effect ->> 'damage_scope' IN ('physical', 'magical') THEN _effect ->> 'damage_scope' ELSE 'any' END;
    _reduction_scope := CASE WHEN _effect ->> 'damage_reduction_scope' = 'magical' THEN 'magical' ELSE 'physical' END;
    _effect_name := LEFT(COALESCE(NULLIF(BTRIM(_effect ->> 'name'), ''), 'Efeito racial'), 160);

    _type_ids := NULL;
    _magic_levels := NULL;
    IF _stored_type = 'damage_reduction' AND _reduction_scope = 'magical' THEN
      IF jsonb_typeof(_effect -> 'damage_reduction_type_ids') = 'array' THEN
        SELECT COALESCE(array_agg(value::uuid), ARRAY[]::uuid[])
        INTO _type_ids
        FROM jsonb_array_elements_text(_effect -> 'damage_reduction_type_ids') AS ids(value);
      ELSE
        _type_ids := ARRAY[]::uuid[];
      END IF;

      IF jsonb_typeof(_effect -> 'damage_reduction_magic_levels') = 'array' THEN
        SELECT COALESCE(array_agg(value), ARRAY[]::text[])
        INTO _magic_levels
        FROM jsonb_array_elements_text(_effect -> 'damage_reduction_magic_levels') AS levels(value);
      ELSE
        _magic_levels := ARRAY[]::text[];
      END IF;
    END IF;

    INSERT INTO public.battle_effects (
      battle_id, character_id, name, effect_type, attribute_key, polarity, value_mode, amount,
      duration, duration_scope, damage_scope, damage_reduction_scope,
      damage_reduction_type_id, damage_reduction_magic_level,
      damage_reduction_type_ids, damage_reduction_magic_levels,
      source_character_ability_id, target_character_id, effect_data, effect_group_id,
      is_end_effect, until_combat_end, source_race_id, source_race_effect_index
    ) VALUES (
      NULL, _character_id, _effect_name, _stored_type, _attribute_key, _polarity, _value_mode, _amount,
      1, 'individual', _damage_scope, _reduction_scope,
      NULL, NULL, _type_ids, _magic_levels,
      NULL, NULL, '{}'::jsonb, NULL,
      false, false, _race_id, _effect_index
    )
    ON CONFLICT ON CONSTRAINT battle_effects_race_effect_key
    DO UPDATE SET
      name = EXCLUDED.name,
      effect_type = EXCLUDED.effect_type,
      attribute_key = EXCLUDED.attribute_key,
      polarity = EXCLUDED.polarity,
      value_mode = EXCLUDED.value_mode,
      amount = EXCLUDED.amount,
      duration = 1,
      duration_scope = EXCLUDED.duration_scope,
      damage_scope = EXCLUDED.damage_scope,
      damage_reduction_scope = EXCLUDED.damage_reduction_scope,
      damage_reduction_type_id = EXCLUDED.damage_reduction_type_id,
      damage_reduction_magic_level = EXCLUDED.damage_reduction_magic_level,
      damage_reduction_type_ids = EXCLUDED.damage_reduction_type_ids,
      damage_reduction_magic_levels = EXCLUDED.damage_reduction_magic_levels,
      target_character_id = NULL,
      effect_data = '{}'::jsonb,
      effect_group_id = NULL,
      is_end_effect = false,
      until_combat_end = false;
  END LOOP;

  -- Delete removed trailing effects from the race template.
  DELETE FROM public.battle_effects e
  WHERE e.character_id = _character_id
    AND e.source_race_id = _race_id
    AND e.source_race_effect_index >= jsonb_array_length(COALESCE(_starting_effects, '[]'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_character_race_effects(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sync_character_race_effects_after_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  PERFORM public.sync_character_race_effects(NEW.id);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_race_effects_after_template_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _character_id uuid;
BEGIN
  FOR _character_id IN
    SELECT c.id
    FROM public.characters c
    WHERE c.race_id = NEW.id
  LOOP
    PERFORM public.sync_character_race_effects(_character_id);
  END LOOP;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS characters_sync_race_effects_insert ON public.characters;
CREATE TRIGGER characters_sync_race_effects_insert
AFTER INSERT ON public.characters
FOR EACH ROW
EXECUTE FUNCTION public.sync_character_race_effects_after_change();

DROP TRIGGER IF EXISTS characters_sync_race_effects_update ON public.characters;
CREATE TRIGGER characters_sync_race_effects_update
AFTER UPDATE OF race_id ON public.characters
FOR EACH ROW
WHEN (OLD.race_id IS DISTINCT FROM NEW.race_id)
EXECUTE FUNCTION public.sync_character_race_effects_after_change();

DROP TRIGGER IF EXISTS races_sync_starting_effects ON public.races;
CREATE TRIGGER races_sync_starting_effects
AFTER UPDATE OF starting_effects ON public.races
FOR EACH ROW
EXECUTE FUNCTION public.sync_race_effects_after_template_change();

REVOKE ALL ON FUNCTION public.sync_character_race_effects_after_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_race_effects_after_template_change() FROM PUBLIC, anon, authenticated;
