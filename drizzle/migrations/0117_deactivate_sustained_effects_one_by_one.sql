DO $patch$
DECLARE
 _definition text;
 _old text:=$old$ DELETE FROM public.battle_effects
 WHERE source_character_ability_id=_a.id
   AND effect_group_id=_a.toggle_effect_group_id
   AND battle_id=_battle_id
   AND NOT is_end_effect;$old$;
 _new text:=$new$ -- Delete one at a time: AFTER DELETE end-effect triggers must see the
 -- other members of the same group until the final row is removed.
 FOR _effect_row IN
   SELECT e.id
   FROM public.battle_effects e
   WHERE e.source_character_ability_id=_a.id
     AND e.effect_group_id=_a.toggle_effect_group_id
     AND e.battle_id=_battle_id AND NOT e.is_end_effect
   ORDER BY e.created_at,e.id
 LOOP
   DELETE FROM public.battle_effects WHERE id=_effect_row.id;
 END LOOP;$new$;
BEGIN
 SELECT pg_get_functiondef('public.turn_off_character_ability(uuid,uuid)'::regprocedure) INTO _definition;
 IF position(' _effect_row record;' IN _definition)=0 THEN
   _definition:=replace(_definition, ' _cooldown integer;', ' _cooldown integer;' || E'\n' || ' _effect_row record;');
 END IF;
 IF position(_old IN _definition)=0 THEN RAISE EXCEPTION 'Sustained ability effect cleanup not found'; END IF;
 _definition:=replace(_definition,_old,_new);
 EXECUTE _definition;
END;
$patch$;