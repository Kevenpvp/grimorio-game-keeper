-- Keep each character's physical-point pool synchronized with its selected race and virtue.
-- Backfill existing characters in case the trait's physical bonus changed after selection.
UPDATE public.characters c
SET race_physical_points_granted = COALESCE(
  (SELECT r.physical_bonus_points FROM public.races r WHERE r.id = c.race_id),
  0
)
WHERE c.race_physical_points_granted IS DISTINCT FROM COALESCE(
  (SELECT r.physical_bonus_points FROM public.races r WHERE r.id = c.race_id),
  0
);

UPDATE public.characters c
SET virtue_physical_points_granted = COALESCE(
  (SELECT v.physical_bonus_points FROM public.virtues v WHERE v.id = c.virtue_id),
  0
)
WHERE c.virtue_physical_points_granted IS DISTINCT FROM COALESCE(
  (SELECT v.physical_bonus_points FROM public.virtues v WHERE v.id = c.virtue_id),
  0
);

CREATE OR REPLACE FUNCTION public.sync_character_race_physical_points()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.characters
  SET race_physical_points_granted = NEW.physical_bonus_points
  WHERE race_id = NEW.id
    AND race_physical_points_granted IS DISTINCT FROM NEW.physical_bonus_points;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_character_virtue_physical_points()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.characters
  SET virtue_physical_points_granted = NEW.physical_bonus_points
  WHERE virtue_id = NEW.id
    AND virtue_physical_points_granted IS DISTINCT FROM NEW.physical_bonus_points;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS races_sync_character_physical_points ON public.races;
CREATE TRIGGER races_sync_character_physical_points
AFTER UPDATE OF physical_bonus_points ON public.races
FOR EACH ROW
WHEN (OLD.physical_bonus_points IS DISTINCT FROM NEW.physical_bonus_points)
EXECUTE FUNCTION public.sync_character_race_physical_points();

DROP TRIGGER IF EXISTS virtues_sync_character_physical_points ON public.virtues;
CREATE TRIGGER virtues_sync_character_physical_points
AFTER UPDATE OF physical_bonus_points ON public.virtues
FOR EACH ROW
WHEN (OLD.physical_bonus_points IS DISTINCT FROM NEW.physical_bonus_points)
EXECUTE FUNCTION public.sync_character_virtue_physical_points();

REVOKE ALL ON FUNCTION public.sync_character_race_physical_points() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_character_virtue_physical_points() FROM PUBLIC, anon, authenticated;
