DO $fix$
DECLARE
  _definition text;
  _expression text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO _definition
  FROM pg_constraint WHERE conrelid='public.battle_effects'::regclass
    AND conname='battle_effects_check';
  IF _definition IS NULL OR left(_definition,7)<>'CHECK (' OR right(_definition,1)<>')' THEN
    RAISE EXCEPTION 'Formato inesperado da constraint battle_effects_check';
  END IF;
  _expression:=substring(_definition from 8 for length(_definition)-8);
  EXECUTE 'ALTER TABLE public.battle_effects DROP CONSTRAINT battle_effects_check';
  EXECUTE 'ALTER TABLE public.battle_effects ADD CONSTRAINT battle_effects_check CHECK (('||
    _expression ||
    ') OR (effect_type=''damage_reduction'' AND damage_reduction_scope=''both'' '||
    'AND attribute_key IS NULL AND polarity=''buff'' AND value_mode IN (''fixed'',''percent'') '||
    'AND damage_reduction_type_id IS NULL AND damage_reduction_magic_level IS NULL '||
    'AND (damage_reduction_type_ids IS NULL OR array_position(damage_reduction_type_ids,NULL::uuid) IS NULL) '||
    'AND (damage_reduction_magic_levels IS NULL OR '||
    '(array_position(damage_reduction_magic_levels,NULL::text) IS NULL AND '||
    '(cardinality(damage_reduction_magic_levels)=0 OR damage_reduction_magic_levels <@ ARRAY[''baixa'',''media'',''alta'']::text[])))))';
END $fix$;
