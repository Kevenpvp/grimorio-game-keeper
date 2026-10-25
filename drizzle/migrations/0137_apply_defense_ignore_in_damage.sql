-- Read temporary, validated penetration from the nine-argument wrappers.
-- Ordinary eight-argument callers have no GUC and retain identical damage.
DO $patch$
DECLARE _definition text; _marker text;
BEGIN
  SELECT pg_get_functiondef('public.apply_battle_damage(uuid,uuid,text,uuid,jsonb,text,uuid,uuid)'::regprocedure)
  INTO _definition;
  IF POSITION('defense_after_ignore' IN _definition)=0 THEN
    _marker := '  INTO _physical_defense,_magical_defense;';
    IF POSITION(_marker IN _definition)=0 THEN
      RAISE EXCEPTION 'Cálculo atual de Defesa Física/Mágica mudou; patch interrompido';
    END IF;
    _definition := REPLACE(_definition,_marker,_marker||chr(10)||
    '  SELECT public.defense_after_ignore(_physical_defense,' ||
    ' COALESCE(NULLIF(current_setting(''grimorio.attack_defense_ignore'',true),'''')::jsonb,''{}''::jsonb),''physical''),' ||chr(10)||
    '         public.defense_after_ignore(_magical_defense,' ||
    ' COALESCE(NULLIF(current_setting(''grimorio.attack_defense_ignore'',true),'''')::jsonb,''{}''::jsonb),''magical'')'||chr(10)||
    '  INTO _physical_defense,_magical_defense;');
    EXECUTE _definition;
  END IF;
END;
$patch$;