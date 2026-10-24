-- Restore legacy mind-control RPC and cleanup hooks, absent after migration.
-- Auth is checked by RPC; cleanup functions are restricted to trigger execution.
BEGIN;
CREATE OR REPLACE FUNCTION public.apply_mind_control_effects(_battle_id uuid, _controller_character_id uuid, _target_selections jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _controller_name text;
  _selection jsonb;
  _target_id uuid;
  _duration integer;
  _controlled boolean;
  _name text;
  _applied integer := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode confirmar Controle Mental';
  END IF;
  IF jsonb_typeof(_target_selections) IS DISTINCT FROM 'array'
     OR jsonb_array_length(_target_selections) < 1
     OR jsonb_array_length(_target_selections) > 100 THEN
    RAISE EXCEPTION 'Selecione de 1 a 100 alvos para Controle Mental';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.battles b WHERE b.id = _battle_id AND b.active) THEN
    RAISE EXCEPTION 'A batalha não está ativa';
  END IF;
  SELECT c.name INTO _controller_name FROM public.characters c WHERE c.id = _controller_character_id;
  IF _controller_name IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.battle_participants bp
    WHERE bp.battle_id = _battle_id AND bp.character_id = _controller_character_id
  ) THEN
    RAISE EXCEPTION 'O controlador precisa estar participando da batalha';
  END IF;
  _name := 'Controle Mental — controlado por ' || _controller_name;

  FOR _selection IN SELECT value FROM jsonb_array_elements(_target_selections)
  LOOP
    _target_id := NULLIF(_selection->>'target_id','')::uuid;
    _controlled := COALESCE((_selection->>'controlled')::boolean, false);
    IF NOT _controlled THEN CONTINUE; END IF;
    IF _target_id IS NULL OR _target_id = _controller_character_id OR NOT EXISTS (
      SELECT 1 FROM public.battle_participants bp
      WHERE bp.battle_id = _battle_id AND bp.character_id = _target_id
    ) THEN
      RAISE EXCEPTION 'Todos os alvos controlados precisam ser outros participantes da mesma batalha';
    END IF;
    IF COALESCE(_selection->>'duration','') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'A duração do Controle Mental precisa ser um número inteiro';
    END IF;
    _duration := (_selection->>'duration')::integer;
    IF _duration < 1 OR _duration > 1000 THEN
      RAISE EXCEPTION 'A duração do Controle Mental precisa ficar entre 1 e 1000 turnos';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.battle_effects e
      WHERE e.character_id = _target_id
        AND e.effect_type = 'mental_control_immunity'
        AND e.duration > 0
        AND (e.battle_id IS NULL OR e.battle_id = _battle_id)
    ) OR EXISTS (
      SELECT 1 FROM public.character_abilities ca
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(ca.passive_effects) = 'array' THEN ca.passive_effects ELSE '[]'::jsonb END
      ) AS configured(effect)
      WHERE ca.character_id = _target_id
        AND configured.effect->>'effect_type' = 'mental_control_immunity'
    ) THEN
      RAISE EXCEPTION 'Um dos alvos selecionados é imune a Controle Mental';
    END IF;
    DELETE FROM public.battle_effects e
    WHERE e.battle_id = _battle_id AND e.character_id = _target_id AND e.effect_type = 'mind_control';
    INSERT INTO public.battle_effects (
      battle_id, character_id, target_character_id, name, effect_type,
      attribute_key, polarity, value_mode, amount, duration, duration_scope,
      until_combat_end, damage_scope, effect_data, effect_group_id, is_end_effect
    ) VALUES (
      _battle_id, _target_id, _target_id, _name, 'mind_control',
      NULL, 'debuff', 'fixed', 0, _duration, 'individual',
      false, 'any',
      jsonb_build_object('controller_character_id', _controller_character_id::text, 'controller_name', _controller_name),
      gen_random_uuid(), false
    );
    _applied := _applied + 1;
  END LOOP;
  RETURN _applied;
END
$function$
;

CREATE OR REPLACE FUNCTION public.cleanup_mind_control_when_battle_ends()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.active IS TRUE AND NEW.active IS FALSE THEN
    DELETE FROM public.battle_effects WHERE battle_id = NEW.id AND effect_type = 'mind_control';
  END IF;
  RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.cleanup_mind_control_when_controller_leaves()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.battle_effects e
  WHERE e.battle_id = OLD.battle_id
    AND e.effect_type = 'mind_control'
    AND e.effect_data->>'controller_character_id' = OLD.character_id::text;
  RETURN OLD;
END
$function$
;
REVOKE ALL ON FUNCTION public.apply_mind_control_effects(uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.apply_mind_control_effects(uuid,uuid,jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.cleanup_mind_control_when_battle_ends() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cleanup_mind_control_when_controller_leaves() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER cleanup_mind_control_when_controller_leaves AFTER DELETE ON public.battle_participants FOR EACH ROW EXECUTE FUNCTION cleanup_mind_control_when_controller_leaves();
CREATE TRIGGER cleanup_mind_control_when_battle_ends AFTER UPDATE OF active ON public.battles FOR EACH ROW EXECUTE FUNCTION cleanup_mind_control_when_battle_ends();
NOTIFY pgrst, 'reload schema';
COMMIT;
