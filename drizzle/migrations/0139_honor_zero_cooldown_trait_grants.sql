-- Honor zero cooldown when abilities are granted by class, race or virtue.
-- Previously GREATEST(a.cooldown_turns,1) silently turned configured zero into one.
CREATE OR REPLACE FUNCTION public.sync_character_trait_abilities(_character_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _race_id uuid; _virtue_id uuid; _class_id uuid;
BEGIN
 SELECT c.race_id,c.virtue_id,c.class_id INTO _race_id,_virtue_id,_class_id FROM public.characters c WHERE c.id=_character_id;
 IF NOT FOUND THEN RETURN; END IF;
 UPDATE public.character_abilities ca SET granted_by_class_id=_class_id,granted_by_race_id=NULL,granted_by_virtue_id=NULL
 WHERE ca.character_id=_character_id AND (ca.granted_by_class_id IS NOT NULL OR ca.granted_by_race_id IS NOT NULL OR ca.granted_by_virtue_id IS NOT NULL)
 AND _class_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.class_abilities xa WHERE xa.class_id=_class_id AND xa.ability_id=ca.ability_id);
 UPDATE public.character_abilities ca SET granted_by_class_id=NULL,granted_by_race_id=_race_id,granted_by_virtue_id=NULL
 WHERE ca.character_id=_character_id AND (ca.granted_by_class_id IS NOT NULL OR ca.granted_by_race_id IS NOT NULL OR ca.granted_by_virtue_id IS NOT NULL)
 AND _race_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.race_abilities ra WHERE ra.race_id=_race_id AND ra.ability_id=ca.ability_id)
 AND NOT EXISTS(SELECT 1 FROM public.class_abilities xa WHERE xa.class_id=_class_id AND xa.ability_id=ca.ability_id);
 UPDATE public.character_abilities ca SET granted_by_class_id=NULL,granted_by_race_id=NULL,granted_by_virtue_id=_virtue_id
 WHERE ca.character_id=_character_id AND (ca.granted_by_class_id IS NOT NULL OR ca.granted_by_race_id IS NOT NULL OR ca.granted_by_virtue_id IS NOT NULL)
 AND _virtue_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.virtue_abilities va WHERE va.virtue_id=_virtue_id AND va.ability_id=ca.ability_id)
 AND NOT EXISTS(SELECT 1 FROM public.class_abilities xa WHERE xa.class_id=_class_id AND xa.ability_id=ca.ability_id)
 AND NOT EXISTS(SELECT 1 FROM public.race_abilities ra WHERE ra.race_id=_race_id AND ra.ability_id=ca.ability_id);
 DELETE FROM public.character_abilities ca WHERE ca.character_id=_character_id
 AND (ca.granted_by_class_id IS NOT NULL OR ca.granted_by_race_id IS NOT NULL OR ca.granted_by_virtue_id IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM public.class_abilities xa WHERE xa.class_id=_class_id AND xa.ability_id=ca.ability_id)
 AND NOT EXISTS(SELECT 1 FROM public.race_abilities ra WHERE ra.race_id=_race_id AND ra.ability_id=ca.ability_id)
 AND NOT EXISTS(SELECT 1 FROM public.virtue_abilities va WHERE va.virtue_id=_virtue_id AND va.ability_id=ca.ability_id);
 INSERT INTO public.character_abilities(character_id,ability_id,name,description,can_activate,is_passive,cooldown_turns,cooldown_remaining,mana_cost,effects,passive_effects,end_effects,is_magical,self_target_only,granted_by_class_id,granted_by_race_id,granted_by_virtue_id)
 SELECT _character_id,a.id,a.name,a.description,a.can_activate,NOT a.can_activate,CASE WHEN a.can_activate THEN GREATEST(a.cooldown_turns,0) ELSE 0 END,0,CASE WHEN a.can_activate THEN a.mana_cost ELSE 0 END,a.effects,a.passive_effects,a.end_effects,a.is_magical,a.self_target_only,_class_id,NULL,NULL
 FROM public.class_abilities xa JOIN public.abilities a ON a.id=xa.ability_id WHERE xa.class_id=_class_id ON CONFLICT(character_id,ability_id) DO NOTHING;
 INSERT INTO public.character_abilities(character_id,ability_id,name,description,can_activate,is_passive,cooldown_turns,cooldown_remaining,mana_cost,effects,passive_effects,end_effects,is_magical,self_target_only,granted_by_class_id,granted_by_race_id,granted_by_virtue_id)
 SELECT _character_id,a.id,a.name,a.description,a.can_activate,NOT a.can_activate,CASE WHEN a.can_activate THEN GREATEST(a.cooldown_turns,0) ELSE 0 END,0,CASE WHEN a.can_activate THEN a.mana_cost ELSE 0 END,a.effects,a.passive_effects,a.end_effects,a.is_magical,a.self_target_only,NULL,_race_id,NULL
 FROM public.race_abilities ra JOIN public.abilities a ON a.id=ra.ability_id WHERE ra.race_id=_race_id
 AND NOT EXISTS(SELECT 1 FROM public.class_abilities xa WHERE xa.class_id=_class_id AND xa.ability_id=ra.ability_id) ON CONFLICT(character_id,ability_id) DO NOTHING;
 INSERT INTO public.character_abilities(character_id,ability_id,name,description,can_activate,is_passive,cooldown_turns,cooldown_remaining,mana_cost,effects,passive_effects,end_effects,is_magical,self_target_only,granted_by_class_id,granted_by_race_id,granted_by_virtue_id)
 SELECT _character_id,a.id,a.name,a.description,a.can_activate,NOT a.can_activate,CASE WHEN a.can_activate THEN GREATEST(a.cooldown_turns,0) ELSE 0 END,0,CASE WHEN a.can_activate THEN a.mana_cost ELSE 0 END,a.effects,a.passive_effects,a.end_effects,a.is_magical,a.self_target_only,NULL,NULL,_virtue_id
 FROM public.virtue_abilities va JOIN public.abilities a ON a.id=va.ability_id WHERE va.virtue_id=_virtue_id
 AND NOT EXISTS(SELECT 1 FROM public.class_abilities xa WHERE xa.class_id=_class_id AND xa.ability_id=va.ability_id)
 AND NOT EXISTS(SELECT 1 FROM public.race_abilities ra WHERE ra.race_id=_race_id AND ra.ability_id=va.ability_id) ON CONFLICT(character_id,ability_id) DO NOTHING;
END $function$
;

-- Reconcile known stale inherited copies; do not change personally configured cooldowns.
UPDATE public.character_abilities ca
SET cooldown_turns=0, cooldown_remaining=0
FROM public.abilities a
WHERE a.id=ca.ability_id AND a.cooldown_turns=0 AND ca.cooldown_turns=1
  AND (ca.granted_by_class_id IS NOT NULL OR ca.granted_by_race_id IS NOT NULL OR ca.granted_by_virtue_id IS NOT NULL)
  AND NOT COALESCE(ca.toggle_active,false);
NOTIFY pgrst, 'reload schema';
