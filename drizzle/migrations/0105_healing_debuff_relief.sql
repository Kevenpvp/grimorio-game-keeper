-- Add Alívio de Debuff: a temporary percentage modifier that reduces the magnitude
-- of numeric debuffs while it is active without changing those debuffs' duration.
BEGIN;

DO $$
DECLARE
  _definition text;
BEGIN
  SELECT pg_get_constraintdef(oid)
  INTO _definition
  FROM pg_constraint
  WHERE conrelid = 'public.battle_effects'::regclass
    AND conname = 'battle_effects_check';

  IF _definition IS NULL THEN RAISE EXCEPTION 'Constraint battle_effects_check não encontrada'; END IF;
  IF position('debuff_relief' IN _definition) = 0 THEN
    _definition := replace(
      _definition,
      'OR (effect_type = ANY (ARRAY[''mind_control''::text',
      'OR ((effect_type = ''debuff_relief''::text) AND (attribute_key IS NULL) AND (polarity = ''buff''::text) AND (value_mode = ''percent''::text) AND (amount <= 100)) OR (effect_type = ANY (ARRAY[''mind_control''::text'
    );
    IF position('debuff_relief' IN _definition) = 0 THEN
      RAISE EXCEPTION 'Não foi possível ampliar battle_effects_check para Alívio de Debuff';
    END IF;
    ALTER TABLE public.battle_effects DROP CONSTRAINT battle_effects_check;
    EXECUTE format('ALTER TABLE public.battle_effects ADD CONSTRAINT battle_effects_check %s', _definition);
  END IF;

  SELECT pg_get_constraintdef(oid)
  INTO _definition
  FROM pg_constraint
  WHERE conrelid = 'public.battle_effects'::regclass
    AND conname = 'battle_effects_effect_type_check';

  IF _definition IS NULL THEN RAISE EXCEPTION 'Constraint battle_effects_effect_type_check não encontrada'; END IF;
  IF position('debuff_relief' IN _definition) = 0 THEN
    _definition := replace(
      _definition,
      '''invisibility''::text])))',
      '''invisibility''::text, ''debuff_relief''::text])))'
    );
    IF position('debuff_relief' IN _definition) = 0 THEN
      RAISE EXCEPTION 'Não foi possível ampliar battle_effects_effect_type_check para Alívio de Debuff';
    END IF;
    ALTER TABLE public.battle_effects DROP CONSTRAINT battle_effects_effect_type_check;
    EXECUTE format('ALTER TABLE public.battle_effects ADD CONSTRAINT battle_effects_effect_type_check %s', _definition);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.capture_debuff_relief_base_amount()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  IF COALESCE(current_setting('app.recalculating_debuff_relief', true), 'false') = 'true' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.effect_data ? '_debuff_relief_base_amount' THEN
    NEW.effect_data := COALESCE(NEW.effect_data, '{}'::jsonb)
      || jsonb_build_object(
        '_debuff_relief_base_amount',
        CASE
          WHEN NEW.amount IS DISTINCT FROM OLD.amount THEN NEW.amount
          ELSE COALESCE(NULLIF(OLD.effect_data->>'_debuff_relief_base_amount', '')::numeric, OLD.amount)
        END
      );

    IF OLD.effect_data ? '_debuff_relief_base_damage_amount' THEN
      NEW.effect_data := NEW.effect_data || jsonb_build_object(
        '_debuff_relief_base_damage_amount',
        CASE
          WHEN NEW.effect_data->>'damage_amount' IS DISTINCT FROM OLD.effect_data->>'damage_amount'
            AND COALESCE(NEW.effect_data->>'damage_amount', '') ~ '^[0-9]+([.][0-9]+)?$'
            THEN (NEW.effect_data->>'damage_amount')::numeric
          ELSE COALESCE(
            NULLIF(OLD.effect_data->>'_debuff_relief_base_damage_amount', '')::numeric,
            CASE WHEN COALESCE(OLD.effect_data->>'damage_amount', '') ~ '^[0-9]+([.][0-9]+)?$'
              THEN (OLD.effect_data->>'damage_amount')::numeric ELSE NULL END
          )
        END
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS battle_effects_capture_debuff_relief_base ON public.battle_effects;
CREATE TRIGGER battle_effects_capture_debuff_relief_base
BEFORE UPDATE OF amount, effect_data ON public.battle_effects
FOR EACH ROW EXECUTE FUNCTION public.capture_debuff_relief_base_amount();

CREATE OR REPLACE FUNCTION public.recalculate_character_debuff_relief(_character_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _effect record;
  _relief record;
  _base_amount numeric;
  _base_dot_amount numeric;
  _effective_amount numeric;
  _factor numeric;
  _is_negative boolean;
  _new_data jsonb;
  _previous_setting text;
BEGIN
  IF _character_id IS NULL THEN RETURN; END IF;

  _previous_setting := current_setting('app.recalculating_debuff_relief', true);
  PERFORM set_config('app.recalculating_debuff_relief', 'true', true);

  FOR _effect IN
    SELECT e.id, e.battle_id, e.amount, e.effect_type, e.polarity, e.effect_data
    FROM public.battle_effects e
    WHERE e.character_id = _character_id
      AND e.effect_type <> 'debuff_relief'
      AND (
        e.effect_data ? '_debuff_relief_base_amount'
        OR (
          (e.polarity = 'debuff' OR e.effect_type IN ('no_regen_hp','no_regen_mana','magic_prohibition','no_mana','stun'))
          AND (
            e.amount > 0
            OR (e.effect_type = 'damage_over_time' AND COALESCE(e.effect_data->>'damage_amount','') ~ '^[0-9]+([.][0-9]+)?$'
              AND (e.effect_data->>'damage_amount')::numeric > 0)
          )
        )
      )
    ORDER BY e.created_at, e.id
    FOR UPDATE OF e
  LOOP
    _base_amount := COALESCE(
      NULLIF(_effect.effect_data->>'_debuff_relief_base_amount', '')::numeric,
      _effect.amount
    );
    _base_dot_amount := CASE
      WHEN COALESCE(_effect.effect_data->>'_debuff_relief_base_damage_amount','') ~ '^[0-9]+([.][0-9]+)?$'
        THEN (_effect.effect_data->>'_debuff_relief_base_damage_amount')::numeric
      WHEN _effect.effect_type = 'damage_over_time'
        AND COALESCE(_effect.effect_data->>'damage_amount','') ~ '^[0-9]+([.][0-9]+)?$'
        THEN (_effect.effect_data->>'damage_amount')::numeric
      ELSE NULL
    END;

    _is_negative := _effect.polarity = 'debuff'
      OR _effect.effect_type IN ('no_regen_hp','no_regen_mana','magic_prohibition','no_mana','stun');
    _factor := 1;

    IF _is_negative THEN
      FOR _relief IN
        SELECT r.amount
        FROM public.battle_effects r
        WHERE r.character_id = _character_id
          AND r.effect_type = 'debuff_relief'
          AND r.duration > 0
          AND (r.battle_id IS NULL OR _effect.battle_id IS NULL OR r.battle_id = _effect.battle_id)
        ORDER BY r.created_at, r.id
      LOOP
        _factor := _factor * (1 - LEAST(100, GREATEST(0, _relief.amount)) / 100);
      END LOOP;
    END IF;

    IF _is_negative AND _factor < 1 THEN
      _effective_amount := _base_amount * _factor;
      _new_data := COALESCE(_effect.effect_data, '{}'::jsonb)
        || jsonb_build_object('_debuff_relief_base_amount', _base_amount);

      IF _effect.effect_type = 'damage_over_time' AND _base_dot_amount IS NOT NULL THEN
        _new_data := _new_data || jsonb_build_object(
          '_debuff_relief_base_damage_amount', _base_dot_amount,
          'damage_amount', _base_dot_amount * _factor
        );
      END IF;

      IF _effect.amount IS DISTINCT FROM _effective_amount
         OR _effect.effect_data IS DISTINCT FROM _new_data THEN
        UPDATE public.battle_effects
        SET amount = _effective_amount,
            effect_data = _new_data
        WHERE id = _effect.id;
      END IF;
    ELSE
      _effective_amount := _base_amount;
      _new_data := COALESCE(_effect.effect_data, '{}'::jsonb) - '_debuff_relief_base_amount' - '_debuff_relief_base_damage_amount';
      IF _effect.effect_type = 'damage_over_time'
         AND _effect.effect_data ? '_debuff_relief_base_damage_amount'
         AND _base_dot_amount IS NOT NULL THEN
        _new_data := jsonb_set(_new_data, '{damage_amount}', to_jsonb(_base_dot_amount), true);
      END IF;

      IF _effect.amount IS DISTINCT FROM _effective_amount
         OR _effect.effect_data IS DISTINCT FROM _new_data THEN
        UPDATE public.battle_effects
        SET amount = _effective_amount,
            effect_data = _new_data
        WHERE id = _effect.id;
      END IF;
    END IF;
  END LOOP;

  PERFORM set_config('app.recalculating_debuff_relief', COALESCE(_previous_setting, 'false'), true);
END;
$function$;

REVOKE ALL ON FUNCTION public.recalculate_character_debuff_relief(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sync_debuff_relief_after_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF COALESCE(current_setting('app.recalculating_debuff_relief', true), 'false') = 'true' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    IF OLD.effect_type = 'debuff_relief'
       OR OLD.polarity = 'debuff'
       OR OLD.effect_data ? '_debuff_relief_base_amount' THEN
      PERFORM public.recalculate_character_debuff_relief(OLD.character_id);
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    IF NEW.effect_type = 'debuff_relief'
       OR NEW.polarity = 'debuff'
       OR NEW.effect_data ? '_debuff_relief_base_amount' THEN
      PERFORM public.recalculate_character_debuff_relief(NEW.character_id);
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_debuff_relief_after_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS battle_effects_recalculate_debuff_relief ON public.battle_effects;
CREATE TRIGGER battle_effects_recalculate_debuff_relief
AFTER INSERT OR DELETE OR UPDATE OF effect_type, polarity, amount, effect_data, character_id, battle_id
ON public.battle_effects
FOR EACH ROW EXECUTE FUNCTION public.sync_debuff_relief_after_change();

DO $$
DECLARE
  _definition text;
  _old text;
  _new text;
BEGIN
  -- Add relief creation to the existing healing routine. It occurs only during activation,
  -- because turn ticks call this function with _apply_debuff_changes = false.
  SELECT pg_get_functiondef('public.apply_ability_healing(uuid,uuid,jsonb,boolean,boolean)'::regprocedure)
  INTO _definition;

  IF right(_definition, length(E'END;\n$function$\n')) <> E'END;\n$function$\n' THEN
    RAISE EXCEPTION 'Final de apply_ability_healing não está no formato esperado';
  END IF;

  _new := $snippet$
  IF _apply_debuff_changes
     AND _battle_id IS NOT NULL
     AND COALESCE(NULLIF(_config->>'healing_relieve_debuff_percent','')::numeric, 0) > 0 THEN
    IF COALESCE(NULLIF(_config->>'healing_relieve_debuff_percent','')::numeric, 0) > 100 THEN
      RAISE EXCEPTION 'Alívio de Debuff deve ficar entre 0 e 100 por cento';
    END IF;

    INSERT INTO public.battle_effects (
      battle_id, character_id, name, effect_type, attribute_key, polarity,
      value_mode, amount, duration, until_combat_end, duration_scope,
      source_character_ability_id, effect_group_id, is_end_effect, damage_scope,
      target_character_id, effect_data
    ) VALUES (
      _battle_id, _character_id,
      'Alívio de Debuff — ' || COALESCE(NULLIF(BTRIM(_config->>'name'), ''), 'Cura'),
      'debuff_relief', NULL, 'buff', 'percent',
      COALESCE(NULLIF(_config->>'healing_relieve_debuff_percent','')::numeric, 0),
      CASE
        WHEN COALESCE(_config->>'healing_timing','instant') = 'per_turn'
          AND COALESCE((_config->>'until_combat_end')::boolean, false) THEN 1
        ELSE GREATEST(1, LEAST(1000, COALESCE(NULLIF(_config->>'duration','')::integer, 1)))
      END,
      COALESCE(_config->>'healing_timing','instant') = 'per_turn'
        AND COALESCE((_config->>'until_combat_end')::boolean, false),
      'global', NULL, gen_random_uuid(), false, 'any', _character_id,
      jsonb_build_object(
        'debuff_relief_percent', COALESCE(NULLIF(_config->>'healing_relieve_debuff_percent','')::numeric, 0),
        'source_effect_name', COALESCE(NULLIF(BTRIM(_config->>'name'), ''), 'Cura'),
        'source_character_id', _config->>'_runtime_healer_character_id',
        'remove_on_attack', COALESCE((_config->>'remove_on_attack')::boolean, false)
      )
    );
  END IF;
$snippet$;

  _definition := left(_definition, length(_definition) - length(E'END;\n$function$\n'))
    || _new || E'\nEND;\n$function$\n';
  EXECUTE _definition;

  -- Make a healing configuration with only Alívio de Debuff a valid activation action.
  FOREACH _old IN ARRAY ARRAY[
    'public.activate_character_ability(uuid,uuid,uuid,integer,jsonb,jsonb)',
    'public.activate_character_ability_attack(uuid,uuid,uuid,integer,uuid[],jsonb,jsonb,jsonb)'
  ]
  LOOP
    SELECT pg_get_functiondef(to_regprocedure(_old)) INTO _definition;
    IF _definition IS NULL THEN RAISE EXCEPTION 'Função de ativação não encontrada: %', _old; END IF;

    _new := $old$or coalesce(nullif(_effect->>'healing_reduce_debuff_turns_percent','')::numeric, 0) > 0 then$old$;
    IF position(_new IN _definition) = 0 THEN
      RAISE EXCEPTION 'Condição de cura não encontrada em %', _old;
    END IF;
    _definition := replace(
      _definition,
      _new,
      $replacement$or coalesce(nullif(_effect->>'healing_reduce_debuff_turns_percent','')::numeric, 0) > 0
            or coalesce(nullif(_effect->>'healing_relieve_debuff_percent','')::numeric, 0) > 0 then$replacement$
    );
    EXECUTE _definition;
  END LOOP;
END $$;

COMMENT ON FUNCTION public.recalculate_character_debuff_relief(uuid)
IS 'Recalculates numeric debuff magnitude while Alívio de Debuff effects are active, restoring original values when relief ends.';

NOTIFY pgrst, 'reload schema';
COMMIT;
