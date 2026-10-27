-- The master dashboard must show the same HP/Mana maximum as the
-- combat engine and the sheet. This includes custom class bonuses,
-- racial/virtue modifiers, persistent effects, temporary buffs and passives.
-- Expose only aggregate maxima, never additional character information.
CREATE OR REPLACE FUNCTION public.list_character_resource_maxima()
RETURNS TABLE(character_id uuid, hp_max numeric, mana_max numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='public'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode consultar os máximos de todas as fichas';
  END IF;
  RETURN QUERY
    SELECT c.id,
           public.calculate_character_resource_max(c.id, 'hp'),
           public.calculate_character_resource_max(c.id, 'mana')
    FROM public.characters c
    WHERE c.is_summon_snapshot = false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.list_character_resource_maxima() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.list_character_resource_maxima() TO authenticated;
