-- Barrincar's combo expires on the first character-turn with NO physical hit.
-- Turn handling must be synchronous inside advance_combat_turn, not delayed
-- by asynchronous processing of ability_script_events.
CREATE OR REPLACE FUNCTION public.tick_barrincar_combo_on_turn_internal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  _ability record;
  _state jsonb;
  _physical_hit_this_turn boolean;
BEGIN
  IF NEW.turn_count IS NOT DISTINCT FROM OLD.turn_count
     OR NEW.turn_count <= OLD.turn_count THEN
    RETURN NEW;
  END IF;

  FOR _ability IN
    SELECT ca.id, ca.custom_state
    FROM public.character_abilities ca
    WHERE ca.character_id = NEW.character_id
      AND ca.custom_script_key = 'barrincar'
    FOR UPDATE
  LOOP
    _state := COALESCE(_ability.custom_state, '{}'::jsonb);

    -- Ignore data belonging to another battle. A future hit starts a new
    -- sequence and cleans its own state; never touch unrelated battle effects.
    IF _state->>'barrincar_battle_id' IS DISTINCT FROM NEW.battle_id::text THEN
      CONTINUE;
    END IF;

    _physical_hit_this_turn := COALESCE(
      (_state->>'barrincar_acertou_desde_ultimo_avanco')::boolean, false
    );

    IF _physical_hit_this_turn THEN
      -- Whether the player hit one or twenty targets, only ONE turn was active.
      -- Consume the boolean and require a fresh physical hit next turn.
      UPDATE public.character_abilities ca
      SET custom_state = jsonb_set(_state,
        '{barrincar_acertou_desde_ultimo_avanco}', 'false'::jsonb, true)
      WHERE ca.id = _ability.id;
    ELSE
      -- No physical hit since the preceding turn advancement: erase the
      -- effect immediately, before returning the new turn result to the UI.
      DELETE FROM public.battle_effects be
      WHERE be.character_id = NEW.character_id
        AND be.battle_id = NEW.battle_id
        AND be.source_character_ability_id = _ability.id
        AND (
          (be.effect_data->>'barrincar') = 'true'
          OR (be.id::text = _state->>'barrincar_efeito_id'
              AND be.effect_type = 'damage_dealt')
        );

      UPDATE public.character_abilities ca
      SET custom_state = _state || jsonb_build_object(
        'barrincar_acumulos', 0,
        'barrincar_ultimo_acerto_turno', NULL,
        'barrincar_efeito_id', NULL,
        'barrincar_acertou_desde_ultimo_avanco', false
      )
      WHERE ca.id = _ability.id;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.tick_barrincar_combo_on_turn_internal()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tick_barrincar_combo_on_turn ON public.battle_participants;
CREATE TRIGGER tick_barrincar_combo_on_turn
BEFORE UPDATE OF turn_count ON public.battle_participants
FOR EACH ROW
WHEN (NEW.turn_count > OLD.turn_count)
EXECUTE FUNCTION public.tick_barrincar_combo_on_turn_internal();

-- For preexisting Barrincar combos, conservatively record the current hit
-- window once: the very next advancement preserves it, the following
-- advancement with no new physical hit clears it. No actual stack changes.
UPDATE public.character_abilities ca
SET custom_state = jsonb_set(
  COALESCE(ca.custom_state, '{}'::jsonb),
  '{barrincar_acertou_desde_ultimo_avanco}', 'true'::jsonb, true
)
WHERE ca.custom_script_key = 'barrincar'
  AND COALESCE((ca.custom_state->>'barrincar_acumulos')::numeric, 0) > 0
  AND NOT ca.custom_state ? 'barrincar_acertou_desde_ultimo_avanco';
