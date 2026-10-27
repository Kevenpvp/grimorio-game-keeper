-- Fix transformation duration and cooldown tick behavior for every origin
-- (catalog, class, race, virtue, character-specific and accessory).
-- A participant's individual turn also advances when the master advances
-- the global combat turn, so this runs once per character for both modes.
CREATE OR REPLACE FUNCTION public.tick_character_transformation_cooldowns()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='public'
AS $fn$
DECLARE
  _state record;
  _steps integer;
BEGIN
  _steps := GREATEST(0,COALESCE(NEW.turn_count,0)-COALESCE(OLD.turn_count,0));
  IF _steps=0 THEN RETURN NEW; END IF;

  FOR _state IN
    UPDATE public.character_transformations AS ct
    SET
      cooldown_remaining=GREATEST(0,ct.cooldown_remaining-_steps),
      active_duration_remaining=CASE
        WHEN ct.active AND ct.active_battle_id=NEW.battle_id
          THEN GREATEST(0,ct.active_duration_remaining-_steps)
        ELSE ct.active_duration_remaining
      END,
      updated_at=now()
    WHERE ct.character_id=NEW.character_id
      AND (ct.cooldown_remaining>0
        OR (ct.active AND ct.active_battle_id=NEW.battle_id))
    RETURNING ct.character_id,ct.transformation_id,ct.active,ct.active_battle_id,
      ct.active_duration_remaining
  LOOP
    IF _state.active AND _state.active_battle_id=NEW.battle_id
      AND _state.active_duration_remaining=0 THEN
      -- This existing teardown removes all applied attribute bonuses, the
      -- active effect group, conditional abilities, and applies end effects.
      PERFORM public.end_character_transformation_internal(
        _state.character_id,_state.transformation_id,false
      );
    END IF;
  END LOOP;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.tick_character_transformation_cooldowns()
  FROM PUBLIC,anon,authenticated;

-- The owner of the sheet or the master may end the transformation on demand.
-- Do not change cooldown or remove other characters' effects.
CREATE OR REPLACE FUNCTION public.end_character_transformation(
  _character_id uuid,_transformation_id uuid,_battle_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='public'
AS $fn$
DECLARE
  _character public.characters%ROWTYPE;
  _state public.character_transformations%ROWTYPE;
  _remaining integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'É necessário entrar na sua conta';
  END IF;
  SELECT * INTO _character FROM public.characters WHERE id=_character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;
  IF NOT public.has_role(auth.uid(),'master') AND
      _character.owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Você não pode destransformar este personagem';
  END IF;
  IF _battle_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.battles b
    JOIN public.battle_participants p ON p.battle_id=b.id
    WHERE b.id=_battle_id AND b.active AND p.character_id=_character_id
  ) THEN
    RAISE EXCEPTION 'A ficha precisa estar em combate ativo para destransformar';
  END IF;
  SELECT * INTO _state FROM public.character_transformations
    WHERE character_id=_character_id AND transformation_id=_transformation_id FOR UPDATE;
  IF NOT FOUND OR NOT _state.active THEN
    RAISE EXCEPTION 'Esta transformação não está ativa';
  END IF;
  IF _state.active_battle_id IS DISTINCT FROM _battle_id THEN
    RAISE EXCEPTION 'A transformação ativa não pertence a este combate';
  END IF;

  _remaining := _state.cooldown_remaining;
  PERFORM public.end_character_transformation_internal(
    _character_id,_transformation_id,false
  );
  RETURN jsonb_build_object(
    'ok',true,
    'transformation_id',_transformation_id,
    'cooldown_remaining',_remaining
  );
END;
$fn$;
REVOKE ALL ON FUNCTION public.end_character_transformation(uuid,uuid,uuid)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.end_character_transformation(uuid,uuid,uuid)
  TO authenticated;
