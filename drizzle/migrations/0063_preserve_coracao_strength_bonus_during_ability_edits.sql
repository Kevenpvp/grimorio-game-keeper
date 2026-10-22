-- Keep the managed +20 Strength modifier present even if a GM edits the ability's
-- passive effects while the synergy is active. The sync function preserves all
-- other effects and is idempotent, so its own nested update stops after one pass.
DROP TRIGGER IF EXISTS character_abilities_sync_coracao_strength_state ON public.character_abilities;
CREATE TRIGGER character_abilities_sync_coracao_strength_state
AFTER UPDATE OF custom_state, cooldown_remaining, can_activate, passive_effects ON public.character_abilities
FOR EACH ROW
EXECUTE FUNCTION public.handle_coracao_corrompido_strength_sync();
