BEGIN;
CREATE OR REPLACE FUNCTION public.guard_direct_toggle_state_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $fn$
BEGIN
  IF current_user NOT IN ('postgres','service_role') THEN
    IF TG_OP='INSERT' THEN
      IF NEW.toggle_active OR NEW.toggle_effect_group_id IS NOT NULL OR NEW.toggle_battle_id IS NOT NULL THEN
        RAISE EXCEPTION 'O estado de uma habilidade sustentada só pode ser alterado pelo mestre no combate.';
      END IF;
    ELSIF NEW.toggle_active IS DISTINCT FROM OLD.toggle_active
       OR NEW.toggle_effect_group_id IS DISTINCT FROM OLD.toggle_effect_group_id
       OR NEW.toggle_battle_id IS DISTINCT FROM OLD.toggle_battle_id THEN
      RAISE EXCEPTION 'Use o botão Ligar/Desligar no combate para mudar o estado da habilidade.';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS character_abilities_protect_toggle_state ON public.character_abilities;
CREATE TRIGGER character_abilities_protect_toggle_state
BEFORE INSERT OR UPDATE OF toggle_active,toggle_effect_group_id,toggle_battle_id
ON public.character_abilities FOR EACH ROW EXECUTE FUNCTION public.guard_direct_toggle_state_mutation();

-- Cleanup triggers may run during normal master DML with an authenticated JWT.
-- Definer privileges are necessary to remove effects on *other targets*.
ALTER FUNCTION public.clear_toggle_abilities_on_battle_end() SECURITY DEFINER;
ALTER FUNCTION public.clear_toggle_abilities_on_participant_removal() SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.clear_toggle_abilities_on_battle_end() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.clear_toggle_abilities_on_participant_removal() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.guard_direct_toggle_state_mutation() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.clear_toggle_abilities_on_battle_deletion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
BEGIN
  UPDATE public.character_abilities
  SET toggle_active=false,toggle_effect_group_id=NULL,toggle_battle_id=NULL
  WHERE toggle_battle_id=OLD.id;
  RETURN OLD;
END;
$fn$;
DROP TRIGGER IF EXISTS battles_reset_toggle_abilities_on_delete ON public.battles;
CREATE TRIGGER battles_reset_toggle_abilities_on_delete
BEFORE DELETE ON public.battles FOR EACH ROW
EXECUTE FUNCTION public.clear_toggle_abilities_on_battle_deletion();
REVOKE ALL ON FUNCTION public.clear_toggle_abilities_on_battle_deletion() FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;