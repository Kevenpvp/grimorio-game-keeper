BEGIN;
ALTER TABLE public.abilities ADD COLUMN IF NOT EXISTS toggle_mode boolean NOT NULL DEFAULT false;
ALTER TABLE public.character_abilities ADD COLUMN IF NOT EXISTS toggle_mode boolean NOT NULL DEFAULT false;
ALTER TABLE public.character_abilities ADD COLUMN IF NOT EXISTS toggle_active boolean NOT NULL DEFAULT false;
ALTER TABLE public.character_abilities ADD COLUMN IF NOT EXISTS toggle_effect_group_id uuid;
ALTER TABLE public.character_abilities ADD COLUMN IF NOT EXISTS toggle_battle_id uuid REFERENCES public.battles(id) ON DELETE SET NULL;

-- Assignments keep their own toggle preference, including character-specific abilities.
UPDATE public.character_abilities ca
SET toggle_mode = true
FROM public.abilities a
WHERE ca.ability_id = a.id AND a.toggle_mode AND NOT ca.toggle_mode;

CREATE OR REPLACE FUNCTION public.sync_toggle_mode_from_catalog()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $fn$
BEGIN
  IF NEW.ability_id IS NOT NULL THEN
    SELECT a.toggle_mode INTO NEW.toggle_mode
    FROM public.abilities a WHERE a.id=NEW.ability_id;
    NEW.toggle_mode:=COALESCE(NEW.toggle_mode,false);
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS character_abilities_catalog_toggle_insert ON public.character_abilities;
CREATE TRIGGER character_abilities_catalog_toggle_insert
BEFORE INSERT ON public.character_abilities
FOR EACH ROW EXECUTE FUNCTION public.sync_toggle_mode_from_catalog();

-- Existing assigned copies follow changes to the shared catalog.
CREATE OR REPLACE FUNCTION public.sync_catalog_toggle_mode_to_characters()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $fn$
BEGIN
  IF NEW.toggle_mode IS DISTINCT FROM OLD.toggle_mode THEN
    IF EXISTS(SELECT 1 FROM public.character_abilities ca WHERE ca.ability_id=NEW.id AND ca.toggle_active) THEN
      RAISE EXCEPTION 'Desative as habilidades sustentadas em uso antes de mudar seu modo.';
    END IF;
    UPDATE public.character_abilities SET toggle_mode=NEW.toggle_mode WHERE ability_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS abilities_sync_toggle_mode ON public.abilities;
CREATE TRIGGER abilities_sync_toggle_mode AFTER UPDATE OF toggle_mode ON public.abilities
FOR EACH ROW EXECUTE FUNCTION public.sync_catalog_toggle_mode_to_characters();

-- Active toggles must not lose their mode until manually disabled.
CREATE OR REPLACE FUNCTION public.guard_active_ability_toggle_changes()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $fn$
BEGIN
  IF OLD.toggle_active AND (NEW.toggle_mode IS DISTINCT FROM OLD.toggle_mode OR NEW.can_activate IS DISTINCT FROM OLD.can_activate) THEN
    RAISE EXCEPTION 'Desative a habilidade sustentada antes de alterar sua configuração.';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS character_abilities_toggle_guard ON public.character_abilities;
CREATE TRIGGER character_abilities_toggle_guard BEFORE UPDATE OF toggle_mode,can_activate
ON public.character_abilities FOR EACH ROW EXECUTE FUNCTION public.guard_active_ability_toggle_changes();

-- Decorate activation with existing effect-group ownership. All ordinary
-- activation effects receive the same group id; those effects persist until
-- the master turns the ability off or ends the battle.
DO $patch$
DECLARE _def text; _signature text; _old text; _new text;
BEGIN
  FOREACH _signature IN ARRAY ARRAY[
    'public.activate_character_ability(uuid,uuid,uuid,integer,jsonb,jsonb)',
    'public.activate_character_ability_attack(uuid,uuid,uuid,integer,uuid[],jsonb,jsonb,jsonb)'
  ]
  LOOP
    SELECT pg_get_functiondef(to_regprocedure(_signature)) INTO _def;
    IF _def IS NULL THEN RAISE EXCEPTION 'Ativação não encontrada: %',_signature; END IF;
    IF _signature LIKE '%_attack(%' THEN
      _old:='  if not _assignment.can_activate or _assignment.cooldown_turns < 0 then';
      _new:='  IF _assignment.toggle_mode THEN RAISE EXCEPTION ''Habilidades sustentadas não podem usar o botão Atacar''; END IF;' || E'\n' || _old;
    ELSE
      _old:='  if not _assignment.can_activate or _assignment.cooldown_turns < 0 then';
      _new:='  IF _assignment.toggle_mode THEN' || E'\n' ||
            '    IF _assignment.toggle_active THEN RAISE EXCEPTION ''Habilidade sustentada já está ligada''; END IF;' || E'\n' ||
            '    IF _battle_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.battles WHERE id=_battle_id AND active) THEN' || E'\n' ||
            '      RAISE EXCEPTION ''Habilidade sustentada só pode ser ligada em combate ativo'';' || E'\n' ||
            '    END IF;' || E'\n' ||
            '    IF EXISTS(SELECT 1 FROM public.abilities a WHERE a.id=_assignment.ability_id AND' || E'\n' ||
            '      (a.attack_enabled OR jsonb_array_length(COALESCE(a.dot_effects,''[]''::jsonb))>0)) THEN' || E'\n' ||
            '      RAISE EXCEPTION ''Habilidade sustentada não pode ter ataque ou DoTs de ativação'';' || E'\n' ||
            '    END IF;' || E'\n' ||
            '  END IF;' || E'\n' || _old;
    END IF;
    IF position(_old IN _def)=0 THEN RAISE EXCEPTION 'Anchor do modo não encontrado em %',_signature; END IF;
    _def:=replace(_def,_old,_new);
    IF _signature NOT LIKE '%_attack(%' THEN
      _old:='_until_combat_end := coalesce((_effect->>''until_combat_end'')::boolean, false);';
      _new:='_until_combat_end := _assignment.toggle_mode OR coalesce((_effect->>''until_combat_end'')::boolean, false);';
      IF position(_old IN _def)=0 THEN RAISE EXCEPTION 'Anchor de duração não encontrado'; END IF;
      _def:=replace(_def,_old,_new);
      _old:='  SET cooldown_remaining = _effective_cooldown' || E'\n' || '  WHERE id = _assignment.id;';
      _new:='  SET cooldown_remaining = CASE WHEN _assignment.toggle_mode THEN 0 ELSE _effective_cooldown END,' || E'\n' ||
            '      toggle_active = _assignment.toggle_mode,' || E'\n' ||
            '      toggle_effect_group_id = CASE WHEN _assignment.toggle_mode THEN _effect_group_id ELSE NULL END,' || E'\n' ||
            '      toggle_battle_id = CASE WHEN _assignment.toggle_mode THEN _effective_battle_id ELSE NULL END' || E'\n' ||
            '  WHERE id = _assignment.id;';
      IF position(_old IN _def)=0 THEN RAISE EXCEPTION 'Anchor de cooldown não encontrado'; END IF;
      _def:=replace(_def,_old,_new);
    END IF;
    EXECUTE _def;
  END LOOP;
END;
$patch$;

-- Deactivation starts the same virtue-adjusted cooldown as activation would.
CREATE OR REPLACE FUNCTION public.turn_off_character_ability(_character_ability_id uuid,_battle_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE
 _a public.character_abilities;
 _race jsonb:='{}'::jsonb;
 _class jsonb:='{}'::jsonb;
 _virtue_id uuid;
 _factor numeric:=1;
 _cooldown integer;
BEGIN
 IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
   RAISE EXCEPTION 'Apenas o mestre pode desativar habilidades';
 END IF;
 SELECT * INTO _a FROM public.character_abilities WHERE id=_character_ability_id FOR UPDATE;
 IF NOT FOUND OR NOT _a.toggle_mode OR NOT _a.toggle_active THEN
   RAISE EXCEPTION 'Esta habilidade não está ligada';
 END IF;
 IF _a.toggle_battle_id IS DISTINCT FROM _battle_id
    OR NOT EXISTS (SELECT 1 FROM public.battles WHERE id=_battle_id AND active) THEN
   RAISE EXCEPTION 'A habilidade não pertence a este combate ativo';
 END IF;
 SELECT COALESCE(r.special_mechanics,'{}'::jsonb),COALESCE(cl.special_mechanics,'{}'::jsonb)
 INTO _race,_class FROM public.characters c
 LEFT JOIN public.races r ON c.race_id=r.id
 LEFT JOIN public.classes cl ON c.class_id=cl.id WHERE c.id=_a.character_id;
 _virtue_id:=COALESCE(_a.granted_by_virtue_id,_a.linked_by_virtue_id);
 IF _virtue_id IS NOT NULL THEN
   IF NOT COALESCE(_race->'virtue_effect_blacklist' @> jsonb_build_array(_virtue_id::text),false) THEN
     _factor:=_factor*(1-LEAST(100,GREATEST(0,COALESCE(NULLIF(_race->>'virtue_cooldown_reduction_percent','')::numeric,0)))/100);
   END IF;
   IF NOT COALESCE(_class->'virtue_effect_blacklist' @> jsonb_build_array(_virtue_id::text),false) THEN
     _factor:=_factor*(1-LEAST(100,GREATEST(0,COALESCE(NULLIF(_class->>'virtue_cooldown_reduction_percent','')::numeric,0)))/100);
   END IF;
 END IF;
 _cooldown:=GREATEST(0,FLOOR(_a.cooldown_turns*_factor)::integer);

 -- Remove only effects created by this activation. Let the existing
 -- end-effect lifecycle fire when the last effect leaves its group.
 DELETE FROM public.battle_effects
 WHERE source_character_ability_id=_a.id
   AND effect_group_id=_a.toggle_effect_group_id
   AND battle_id=_battle_id
   AND NOT is_end_effect;

 UPDATE public.character_abilities
 SET toggle_active=false,toggle_effect_group_id=NULL,toggle_battle_id=NULL,
     cooldown_remaining=_cooldown
 WHERE id=_a.id;
 RETURN _cooldown;
END;
$fn$;
REVOKE ALL ON FUNCTION public.turn_off_character_ability(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.turn_off_character_ability(uuid,uuid) TO authenticated;

-- Active state never leaks into the next encounter.
CREATE OR REPLACE FUNCTION public.clear_toggle_abilities_on_battle_end()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $fn$
BEGIN
 IF OLD.active AND NOT NEW.active THEN
   UPDATE public.character_abilities
   SET toggle_active=false,toggle_effect_group_id=NULL,toggle_battle_id=NULL
   WHERE toggle_battle_id=NEW.id AND toggle_active;
 END IF;
 RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS battles_reset_toggle_abilities ON public.battles;
CREATE TRIGGER battles_reset_toggle_abilities AFTER UPDATE OF active ON public.battles
FOR EACH ROW EXECUTE FUNCTION public.clear_toggle_abilities_on_battle_end();

CREATE OR REPLACE FUNCTION public.clear_toggle_abilities_on_participant_removal()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $fn$
BEGIN
  -- Prevent leaving active buffs/debuffs on other targets if their caster
  -- leaves the fight. The battle remains active for everyone else.
  UPDATE public.battle_effects e SET is_end_effect=true
  FROM public.character_abilities ca
  WHERE ca.character_id=OLD.character_id AND ca.toggle_active
    AND ca.toggle_battle_id=OLD.battle_id
    AND e.source_character_ability_id=ca.id
    AND e.effect_group_id=ca.toggle_effect_group_id
    AND e.battle_id=OLD.battle_id AND NOT e.is_end_effect;
  DELETE FROM public.battle_effects e
  USING public.character_abilities ca
  WHERE ca.character_id=OLD.character_id AND ca.toggle_active
    AND ca.toggle_battle_id=OLD.battle_id
    AND e.source_character_ability_id=ca.id
    AND e.effect_group_id=ca.toggle_effect_group_id
    AND e.battle_id=OLD.battle_id;
  UPDATE public.character_abilities SET toggle_active=false,
    toggle_effect_group_id=NULL,toggle_battle_id=NULL
  WHERE character_id=OLD.character_id AND toggle_battle_id=OLD.battle_id;
  RETURN OLD;
END;
$fn$;
DROP TRIGGER IF EXISTS participants_reset_toggle_abilities ON public.battle_participants;
CREATE TRIGGER participants_reset_toggle_abilities AFTER DELETE ON public.battle_participants
FOR EACH ROW EXECUTE FUNCTION public.clear_toggle_abilities_on_participant_removal();

NOTIFY pgrst,'reload schema';
COMMIT;