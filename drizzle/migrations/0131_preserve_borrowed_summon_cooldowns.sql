DROP TRIGGER IF EXISTS summon_grants_sync_borrowed ON public.summon_grants;
-- Editing a summon name, transferred stat, or custom stat must not reset
-- the cooldown/custom state of already borrowed abilities.
CREATE TRIGGER summon_grants_sync_borrowed
AFTER INSERT OR UPDATE OF borrowed_assignment_ids,template_character_id,summoner_character_id
ON public.summon_grants
FOR EACH ROW EXECUTE FUNCTION public.sync_summon_borrowed_abilities();
