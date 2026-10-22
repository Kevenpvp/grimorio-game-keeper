-- Register the existing ability's trusted server-side script.
UPDATE public.abilities
SET custom_script_key = 'coracao_corrompido'
WHERE lower(btrim(name)) = lower('Coração Corrompido')
  AND (custom_script_key IS NULL OR custom_script_key = 'coracao_corrompido');

-- Allow the new explicit cooldown-exit callback in the event queue.
ALTER TABLE public.ability_script_events
  DROP CONSTRAINT IF EXISTS ability_script_events_event_type_check;
ALTER TABLE public.ability_script_events
  ADD CONSTRAINT ability_script_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'turno_avançou'::text,
    'habilidade_ativada'::text,
    'efeito_aplicado_no_caster'::text,
    'efeito_removido_no_caster'::text,
    'habilidade_saiu_do_cooldown'::text,
    'recebeu_dano'::text,
    'causou_dano'::text
  ]));

CREATE OR REPLACE FUNCTION public.sync_coracao_corrompido_strength_effect(_character_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _heat numeric := 0;
  _heart record;
  _current_effects jsonb;
  _next_effects jsonb;
  _should_apply boolean;
BEGIN
  IF _character_id IS NULL THEN
    RETURN;
  END IF;

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
    SELECT ca.id, ca.cooldown_remaining, ca.passive_effects
    FROM public.character_abilities ca
    JOIN public.abilities a ON a.id = ca.ability_id
    WHERE ca.character_id = _character_id
      AND (a.custom_script_key = 'coracao_corrompido' OR lower(btrim(a.name)) = lower('Coração Corrompido'))
  LOOP
    _current_effects := CASE
      WHEN jsonb_typeof(COALESCE(_heart.passive_effects, '[]'::jsonb)) = 'array'
        THEN COALESCE(_heart.passive_effects, '[]'::jsonb)
      ELSE '[]'::jsonb
    END;

    SELECT COALESCE(jsonb_agg(item.effect ORDER BY item.ordinality), '[]'::jsonb)
    INTO _next_effects
    FROM jsonb_array_elements(_current_effects) WITH ORDINALITY AS item(effect, ordinality)
    WHERE item.effect->>'special_modifier_key' IS DISTINCT FROM 'coracao_corrompido_demonio_strength';

    _should_apply := COALESCE(_heart.cooldown_remaining, 0) > 0 AND _heat > 0;

    IF _should_apply THEN
      _next_effects := _next_effects || jsonb_build_array(jsonb_build_object(
        'name', 'Coração Corrompido — Força do Demônio Interno',
        'effect_type', 'status',
        'attribute_key', 'strength',
        'polarity', 'buff',
        'value_mode', 'fixed',
        'amount', 20,
        'duration', 1,
        'damage_scope', 'any',
        'special_modifier_key', 'coracao_corrompido_demonio_strength'
      ));
    END IF;

    IF _current_effects IS DISTINCT FROM _next_effects THEN
      UPDATE public.character_abilities
      SET passive_effects = _next_effects
      WHERE id = _heart.id;
    END IF;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_coracao_corrompido_strength_effect(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_coracao_corrompido_strength_effect(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.handle_coracao_corrompido_strength_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _character_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    _character_id := OLD.character_id;
  ELSE
    _character_id := NEW.character_id;
  END IF;

  PERFORM public.sync_coracao_corrompido_strength_effect(_character_id);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS character_abilities_sync_coracao_strength_state ON public.character_abilities;
CREATE TRIGGER character_abilities_sync_coracao_strength_state
AFTER UPDATE OF custom_state, cooldown_remaining ON public.character_abilities
FOR EACH ROW
EXECUTE FUNCTION public.handle_coracao_corrompido_strength_sync();

DROP TRIGGER IF EXISTS character_abilities_sync_coracao_strength_insert_delete ON public.character_abilities;
CREATE TRIGGER character_abilities_sync_coracao_strength_insert_delete
AFTER INSERT OR DELETE ON public.character_abilities
FOR EACH ROW
EXECUTE FUNCTION public.handle_coracao_corrompido_strength_sync();

CREATE OR REPLACE FUNCTION public.queue_coracao_corrompido_cooldown_exit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _script_key text;
  _battle_id uuid;
BEGIN
  IF COALESCE(OLD.cooldown_remaining, 0) > 0
     AND COALESCE(NEW.cooldown_remaining, 0) = 0 THEN
    SELECT a.custom_script_key
    INTO _script_key
    FROM public.abilities a
    WHERE a.id = NEW.ability_id;

    IF _script_key = 'coracao_corrompido' THEN
      SELECT b.id
      INTO _battle_id
      FROM public.battle_participants bp
      JOIN public.battles b ON b.id = bp.battle_id AND b.active IS TRUE
      WHERE bp.character_id = NEW.character_id
      ORDER BY b.created_at DESC
      LIMIT 1;

      PERFORM public.queue_ability_script_event(
        'habilidade_saiu_do_cooldown',
        NEW.id,
        NEW.character_id,
        _battle_id,
        NEW.character_id,
        NULL,
        jsonb_build_object('cooldown_anterior', OLD.cooldown_remaining, 'cooldown_atual', NEW.cooldown_remaining)
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS character_abilities_queue_coracao_cooldown_exit ON public.character_abilities;
CREATE TRIGGER character_abilities_queue_coracao_cooldown_exit
AFTER UPDATE OF cooldown_remaining ON public.character_abilities
FOR EACH ROW
EXECUTE FUNCTION public.queue_coracao_corrompido_cooldown_exit();

DO $function$
DECLARE
  _row record;
BEGIN
  FOR _row IN
    SELECT DISTINCT ca.character_id
    FROM public.character_abilities ca
    JOIN public.abilities a ON a.id = ca.ability_id
    WHERE a.custom_script_key IN ('demonio_interno', 'coracao_corrompido')
       OR lower(btrim(a.name)) IN (lower('Demônio Interno'), lower('Coração Corrompido'))
  LOOP
    PERFORM public.sync_coracao_corrompido_strength_effect(_row.character_id);
  END LOOP;
END;
$function$;
