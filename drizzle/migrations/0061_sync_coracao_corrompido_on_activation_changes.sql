-- If the GM disables an ability while it is on cooldown, sync_ability_activation_fields()
-- can zero NEW.cooldown_remaining before the AFTER trigger runs. Listen to can_activate
-- too so the temporary Strength bonus is removed and the cooldown-exit callback is queued.
DROP TRIGGER IF EXISTS character_abilities_sync_coracao_strength_state ON public.character_abilities;
CREATE TRIGGER character_abilities_sync_coracao_strength_state
AFTER UPDATE OF custom_state, cooldown_remaining, can_activate ON public.character_abilities
FOR EACH ROW
EXECUTE FUNCTION public.handle_coracao_corrompido_strength_sync();

DROP TRIGGER IF EXISTS character_abilities_queue_coracao_cooldown_exit ON public.character_abilities;
CREATE TRIGGER character_abilities_queue_coracao_cooldown_exit
AFTER UPDATE OF cooldown_remaining, can_activate ON public.character_abilities
FOR EACH ROW
EXECUTE FUNCTION public.queue_coracao_corrompido_cooldown_exit();
