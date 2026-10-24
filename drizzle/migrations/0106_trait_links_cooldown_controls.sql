-- Trait-linked character abilities/transformations, zero cooldown support, and master cooldown controls.
ALTER TABLE public.character_abilities
  ADD COLUMN IF NOT EXISTS linked_by_race_id uuid REFERENCES public.races(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS linked_by_virtue_id uuid REFERENCES public.virtues(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS linked_by_class_id uuid REFERENCES public.classes(id) ON DELETE CASCADE;

ALTER TABLE public.transformations
  ADD COLUMN IF NOT EXISTS linked_by_race_id uuid REFERENCES public.races(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS linked_by_virtue_id uuid REFERENCES public.virtues(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS linked_by_class_id uuid REFERENCES public.classes(id) ON DELETE CASCADE;

-- Cooldown zero is valid: activation simply leaves the ability ready for its next use.
DO $migration$
DECLARE
  _constraint record;
  _definition text;
  _function record;
BEGIN
  FOR _constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.abilities'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%cooldown_turns%'
  LOOP
    EXECUTE format('ALTER TABLE public.abilities DROP CONSTRAINT %I', _constraint.conname);
  END LOOP;
  ALTER TABLE public.abilities
    ADD CONSTRAINT abilities_cooldown_turns_nonnegative_check CHECK (cooldown_turns >= 0);

  FOR _function IN
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('activate_character_ability', 'activate_character_ability_attack')
  LOOP
    _definition := pg_get_functiondef(_function.oid);
    _definition := replace(_definition, '_assignment.cooldown_turns <= 0', '_assignment.cooldown_turns < 0');
    _definition := replace(_definition, 'cooldown_turns <= 0', 'cooldown_turns < 0');
    EXECUTE _definition;
  END LOOP;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.master_adjust_ability_cooldown(
  _character_ability_id uuid,
  _turns integer,
  _mode text DEFAULT 'reduce'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _remaining integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode alterar cooldowns';
  END IF;
  IF _character_ability_id IS NULL THEN RAISE EXCEPTION 'Selecione uma habilidade'; END IF;
  IF _mode NOT IN ('reduce', 'clear') THEN RAISE EXCEPTION 'Modo de ajuste de cooldown inválido'; END IF;
  IF _turns IS NULL OR _turns < 0 OR _turns > 1000 THEN
    RAISE EXCEPTION 'A quantidade de turnos deve ficar entre 0 e 1000';
  END IF;

  UPDATE public.character_abilities
  SET cooldown_remaining = CASE WHEN _mode = 'clear' THEN 0 ELSE greatest(0, cooldown_remaining - _turns) END
  WHERE id = _character_ability_id
  RETURNING cooldown_remaining INTO _remaining;
  IF NOT FOUND THEN RAISE EXCEPTION 'Habilidade não encontrada nesta ficha'; END IF;
  RETURN _remaining;
END;
$function$;
REVOKE ALL ON FUNCTION public.master_adjust_ability_cooldown(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.master_adjust_ability_cooldown(uuid, integer, text) TO authenticated;
