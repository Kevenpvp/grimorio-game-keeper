-- Permanent effects belong to sheet management outside combat only.
-- Reject attempts to create a sheet-permanent effect through a live battle panel.
DO $$
DECLARE
  _definition text;
  _old text;
  _new text;
BEGIN
  SELECT pg_get_functiondef(
    'public.apply_manual_character_effects(uuid,uuid,uuid,jsonb,jsonb,boolean)'::regprocedure
  ) INTO _definition;

  _old := $old$  IF _battle_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.battles b WHERE b.id = _battle_id AND b.active) THEN$old$;

  IF position(_old IN _definition) = 0 THEN
    RAISE EXCEPTION 'Não foi possível localizar a validação da batalha em apply_manual_character_effects.';
  END IF;

  _new := $new$  IF _battle_id IS NOT NULL AND _permanent THEN
    RAISE EXCEPTION 'Efeitos aplicados durante o combate não podem ser permanentes na ficha.';
  END IF;

  IF _battle_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.battles b WHERE b.id = _battle_id AND b.active) THEN$new$;

  _definition := replace(_definition, _old, _new);
  EXECUTE _definition;
END $$;
