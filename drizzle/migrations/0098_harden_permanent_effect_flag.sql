-- Prevent direct writes from demoting or inventing permanent sheet effects.
CREATE OR REPLACE FUNCTION public.mark_trait_starting_effect_permanent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.is_sheet_permanent IS TRUE
     AND NEW.is_sheet_permanent IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  IF NEW.is_sheet_permanent IS TRUE
     AND NEW.source_race_id IS NULL
     AND NEW.source_class_id IS NULL
     AND NEW.source_virtue_id IS NULL
     AND NOT public.has_role(auth.uid(), 'master') THEN
    RETURN NULL;
  END IF;

  IF NEW.source_race_id IS NOT NULL
     OR NEW.source_class_id IS NOT NULL
     OR NEW.source_virtue_id IS NOT NULL THEN
    NEW.is_sheet_permanent := true;
    NEW.until_combat_end := false;
  END IF;
  RETURN NEW;
END;
$$;
