-- Permanent starting effects for virtues and master-applied sheet effects.
ALTER TABLE public.virtues
  ADD COLUMN IF NOT EXISTS starting_effects jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.virtues
  DROP CONSTRAINT IF EXISTS virtues_starting_effects_array_check;
ALTER TABLE public.virtues
  ADD CONSTRAINT virtues_starting_effects_array_check CHECK (jsonb_typeof(starting_effects) = 'array');

ALTER TABLE public.battle_effects
  ADD COLUMN IF NOT EXISTS is_sheet_permanent boolean NOT NULL DEFAULT false;
ALTER TABLE public.battle_effects
  ADD COLUMN IF NOT EXISTS source_virtue_id uuid REFERENCES public.virtues(id) ON DELETE CASCADE;
ALTER TABLE public.battle_effects
  ADD COLUMN IF NOT EXISTS source_virtue_effect_index integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'battle_effects_virtue_effect_key') THEN
    ALTER TABLE public.battle_effects
      ADD CONSTRAINT battle_effects_virtue_effect_key
      UNIQUE (character_id, source_virtue_id, source_virtue_effect_index);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.mark_trait_starting_effect_permanent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.source_race_id IS NOT NULL
     OR NEW.source_class_id IS NOT NULL
     OR NEW.source_virtue_id IS NOT NULL THEN
    NEW.is_sheet_permanent := true;
    NEW.until_combat_end := false;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS battle_effects_mark_trait_starting_permanent ON public.battle_effects;
CREATE TRIGGER battle_effects_mark_trait_starting_permanent
BEFORE INSERT OR UPDATE OF source_race_id, source_class_id, source_virtue_id, is_sheet_permanent
ON public.battle_effects
FOR EACH ROW EXECUTE FUNCTION public.mark_trait_starting_effect_permanent();

-- Existing race/class starting effects are also permanent while their trait remains selected.
UPDATE public.battle_effects
SET is_sheet_permanent = true, until_combat_end = false
WHERE source_race_id IS NOT NULL OR source_class_id IS NOT NULL OR source_virtue_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.protect_sheet_permanent_battle_effect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current_trait uuid;
  _template jsonb;
BEGIN
  IF OLD.is_sheet_permanent IS NOT TRUE THEN
    RETURN OLD;
  END IF;

  -- Cascading deletion of a character should still clean up its effects.
  IF NOT EXISTS (SELECT 1 FROM public.characters c WHERE c.id = OLD.character_id) THEN
    RETURN OLD;
  END IF;

  -- Trait-owned permanent effects can be removed when the character loses that trait,
  -- the trait is deleted, or the corresponding template entry is removed.
  IF OLD.source_race_id IS NOT NULL THEN
    SELECT c.race_id INTO _current_trait FROM public.characters c WHERE c.id = OLD.character_id;
    IF _current_trait IS DISTINCT FROM OLD.source_race_id
       OR NOT EXISTS (SELECT 1 FROM public.races r WHERE r.id = OLD.source_race_id) THEN
      RETURN OLD;
    END IF;
    SELECT r.starting_effects INTO _template FROM public.races r WHERE r.id = OLD.source_race_id;
    IF OLD.source_race_effect_index IS NOT NULL
       AND OLD.source_race_effect_index >= jsonb_array_length(COALESCE(_template, '[]'::jsonb)) THEN
      RETURN OLD;
    END IF;
  END IF;

  IF OLD.source_class_id IS NOT NULL THEN
    SELECT c.class_id INTO _current_trait FROM public.characters c WHERE c.id = OLD.character_id;
    IF _current_trait IS DISTINCT FROM OLD.source_class_id
       OR NOT EXISTS (SELECT 1 FROM public.classes cl WHERE cl.id = OLD.source_class_id) THEN
      RETURN OLD;
    END IF;
    SELECT cl.starting_effects INTO _template FROM public.classes cl WHERE cl.id = OLD.source_class_id;
    IF OLD.source_class_effect_index IS NOT NULL
       AND OLD.source_class_effect_index >= jsonb_array_length(COALESCE(_template, '[]'::jsonb)) THEN
      RETURN OLD;
    END IF;
  END IF;

  IF OLD.source_virtue_id IS NOT NULL THEN
    SELECT c.virtue_id INTO _current_trait FROM public.characters c WHERE c.id = OLD.character_id;
    IF _current_trait IS DISTINCT FROM OLD.source_virtue_id
       OR NOT EXISTS (SELECT 1 FROM public.virtues v WHERE v.id = OLD.source_virtue_id) THEN
      RETURN OLD;
    END IF;
    SELECT v.starting_effects INTO _template FROM public.virtues v WHERE v.id = OLD.source_virtue_id;
    IF OLD.source_virtue_effect_index IS NOT NULL
       AND OLD.source_virtue_effect_index >= jsonb_array_length(COALESCE(_template, '[]'::jsonb)) THEN
      RETURN OLD;
    END IF;
  END IF;

  -- Only the GM may manually remove permanent effects from a sheet.
  IF public.has_role(auth.uid(), 'master') THEN
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS battle_effects_protect_sheet_permanent_delete ON public.battle_effects;
CREATE TRIGGER battle_effects_protect_sheet_permanent_delete
BEFORE DELETE ON public.battle_effects
FOR EACH ROW EXECUTE FUNCTION public.protect_sheet_permanent_battle_effect();

CREATE OR REPLACE FUNCTION public.sync_character_virtue_effects(_character_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _virtue_id uuid;
  _starting_effects jsonb := '[]'::jsonb;
  _effect jsonb;
  _effect_index integer;
  _effect_type text;
  _stored_type text;
  _attribute_key text;
  _polarity text;
  _value_mode text;
  _amount numeric;
  _damage_scope text;
  _reduction_scope text;
  _type_ids uuid[];
  _magic_levels text[];
  _effect_name text;
BEGIN
  SELECT c.virtue_id INTO _virtue_id
  FROM public.characters c WHERE c.id = _character_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF _virtue_id IS NOT NULL THEN
    SELECT v.starting_effects INTO _starting_effects
    FROM public.virtues v WHERE v.id = _virtue_id;
    IF NOT FOUND THEN _starting_effects := '[]'::jsonb; END IF;
  ELSE
    _starting_effects := '[]'::jsonb;
  END IF;
  IF jsonb_typeof(COALESCE(_starting_effects, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Os efeitos iniciais da virtude precisam ser uma lista.';
  END IF;

  -- Keep matching entries, remove only the old/removed virtue-owned effects.
  DELETE FROM public.battle_effects e
  WHERE e.character_id = _character_id
    AND e.source_virtue_id IS NOT NULL
    AND (
      e.source_virtue_id IS DISTINCT FROM _virtue_id
      OR e.source_virtue_effect_index >= jsonb_array_length(COALESCE(_starting_effects, '[]'::jsonb))
    );

  IF _virtue_id IS NULL THEN RETURN; END IF;

  FOR _effect, _effect_index IN
    SELECT item.value, (item.ordinality - 1)::integer
    FROM jsonb_array_elements(COALESCE(_starting_effects, '[]'::jsonb))
      WITH ORDINALITY AS item(value, ordinality)
  LOOP
    _effect_type := COALESCE(NULLIF(_effect->>'effect_type', ''), 'status');
    IF _effect_type NOT IN (
      'status','regeneration','mana_regeneration','mana_used','no_regen_hp','no_regen_mana',
      'magic_prohibition','stun','damage_dealt','no_mana','damage_reduction','damage_received',
      'damage_vulnerability','invincible','healing_blocked','magic_healing_reversal',
      'mental_control_immunity','mental_control_chance','mental_control_resistance','dot_immunity','invisibility'
    ) THEN
      RAISE EXCEPTION 'Tipo de efeito inicial da virtude inválido: %', _effect_type;
    END IF;

    _stored_type := CASE
      WHEN _effect_type = 'mana_regeneration' THEN 'regeneration'
      WHEN _effect_type = 'magic_healing_reversal' THEN 'healing_blocked'
      ELSE _effect_type
    END;
    _attribute_key := CASE
      WHEN _stored_type IN ('status','damage_vulnerability') THEN NULLIF(_effect->>'attribute_key','')
      WHEN _stored_type = 'regeneration' THEN
        CASE WHEN _effect_type = 'mana_regeneration' THEN 'mana' ELSE NULLIF(_effect->>'attribute_key','') END
      ELSE NULL
    END;
    IF _stored_type IN ('status','damage_vulnerability') AND _attribute_key IS NULL THEN
      RAISE EXCEPTION 'Efeito inicial de status da virtude precisa escolher um atributo.';
    END IF;
    IF _stored_type = 'regeneration' AND _attribute_key NOT IN ('hp','mana') THEN
      RAISE EXCEPTION 'Regeneração inicial da virtude precisa usar HP ou Mana.';
    END IF;

    _polarity := CASE
      WHEN _stored_type IN ('magic_prohibition','no_mana','healing_blocked','damage_received') THEN 'debuff'
      WHEN _stored_type IN ('damage_reduction','invincible','mental_control_immunity','mental_control_chance',
        'mental_control_resistance','dot_immunity','invisibility') THEN 'buff'
      ELSE COALESCE(NULLIF(_effect->>'polarity',''),'buff')
    END;
    _value_mode := CASE WHEN _effect->>'value_mode'='percent' THEN 'percent' ELSE 'fixed' END;
    _amount := GREATEST(0, COALESCE(NULLIF(_effect->>'amount','')::numeric,0));
    _damage_scope := CASE WHEN _effect->>'damage_scope' IN ('physical','magical') THEN _effect->>'damage_scope' ELSE 'any' END;
    _reduction_scope := CASE WHEN _effect->>'damage_reduction_scope'='magical' THEN 'magical' ELSE 'physical' END;
    _effect_name := LEFT(COALESCE(NULLIF(BTRIM(_effect->>'name'),''),'Efeito inicial da virtude'),160);

    IF _stored_type IN ('no_mana','magic_prohibition') THEN
      _polarity := 'debuff'; _attribute_key := NULL; _amount := 0; _value_mode := 'fixed';
    ELSIF _stored_type IN ('invincible','healing_blocked','mental_control_immunity','dot_immunity','invisibility') THEN
      _attribute_key := NULL; _amount := 0; _value_mode := 'fixed';
    ELSIF _stored_type IN ('mental_control_chance','mental_control_resistance') THEN
      _attribute_key := NULL;
      IF _polarity <> 'buff' OR _amount < 0 THEN RAISE EXCEPTION 'Modificador de Controle Mental da virtude inválido'; END IF;
    ELSIF _stored_type IN ('damage_dealt','mana_used','damage_received') THEN
      _attribute_key := NULL;
      IF _stored_type = 'damage_received' THEN _polarity := 'debuff'; END IF;
    END IF;

    IF _stored_type = 'damage_reduction' THEN
      _polarity := 'buff'; _attribute_key := NULL;
      IF _reduction_scope = 'magical' THEN
        IF jsonb_typeof(_effect->'damage_reduction_type_ids')='array' THEN
          SELECT COALESCE(array_agg(value::uuid), ARRAY[]::uuid[]) INTO _type_ids
          FROM jsonb_array_elements_text(_effect->'damage_reduction_type_ids') ids(value);
        ELSE _type_ids := ARRAY[]::uuid[]; END IF;
        IF jsonb_typeof(_effect->'damage_reduction_magic_levels')='array' THEN
          SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO _magic_levels
          FROM jsonb_array_elements_text(_effect->'damage_reduction_magic_levels') levels(value);
        ELSE _magic_levels := ARRAY[]::text[]; END IF;
      ELSE
        _type_ids := NULL; _magic_levels := NULL;
      END IF;
    ELSE
      _type_ids := NULL; _magic_levels := NULL; _reduction_scope := 'physical';
    END IF;

    IF _stored_type = 'damage_received' AND _amount > 1000000 THEN
      RAISE EXCEPTION 'Dano Recebido da virtude deve ficar entre 0 e 1000000';
    END IF;
    IF _stored_type = 'damage_vulnerability' THEN
      IF _polarity NOT IN ('buff','debuff') THEN RAISE EXCEPTION 'Polaridade da Vulnerabilidade de Dano inválida'; END IF;
    END IF;
    IF _stored_type IN ('mental_control_chance','mental_control_resistance') AND _value_mode='percent' AND _amount > 1000 THEN
      RAISE EXCEPTION 'O modificador percentual de Controle Mental da virtude ultrapassou o limite';
    END IF;

    INSERT INTO public.battle_effects (
      battle_id, character_id, name, effect_type, attribute_key, polarity, value_mode, amount,
      duration, duration_scope, damage_scope, damage_reduction_scope,
      damage_reduction_type_id, damage_reduction_magic_level, damage_reduction_type_ids,
      damage_reduction_magic_levels, source_character_ability_id, target_character_id, effect_data,
      effect_group_id, is_end_effect, until_combat_end, source_virtue_id, source_virtue_effect_index,
      is_sheet_permanent
    ) VALUES (
      NULL, _character_id, _effect_name, _stored_type, _attribute_key, _polarity, _value_mode, _amount,
      1, 'individual', _damage_scope, _reduction_scope,
      NULL, NULL, _type_ids, _magic_levels, NULL, NULL, _effect,
      NULL, false, false, _virtue_id, _effect_index, true
    )
    ON CONFLICT ON CONSTRAINT battle_effects_virtue_effect_key
    DO UPDATE SET
      name = EXCLUDED.name, effect_type = EXCLUDED.effect_type, attribute_key = EXCLUDED.attribute_key,
      polarity = EXCLUDED.polarity, value_mode = EXCLUDED.value_mode, amount = EXCLUDED.amount,
      duration = 1, duration_scope = EXCLUDED.duration_scope, damage_scope = EXCLUDED.damage_scope,
      damage_reduction_scope = EXCLUDED.damage_reduction_scope,
      damage_reduction_type_id = EXCLUDED.damage_reduction_type_id,
      damage_reduction_magic_level = EXCLUDED.damage_reduction_magic_level,
      damage_reduction_type_ids = EXCLUDED.damage_reduction_type_ids,
      damage_reduction_magic_levels = EXCLUDED.damage_reduction_magic_levels,
      target_character_id = NULL, effect_data = EXCLUDED.effect_data, effect_group_id = NULL,
      is_end_effect = false, until_combat_end = false, is_sheet_permanent = true;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_character_virtue_effects_after_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.sync_character_virtue_effects(NEW.id);
  ELSIF OLD.virtue_id IS DISTINCT FROM NEW.virtue_id THEN
    PERFORM public.sync_character_virtue_effects(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS characters_sync_virtue_starting_effects ON public.characters;
CREATE TRIGGER characters_sync_virtue_starting_effects
AFTER INSERT OR UPDATE OF virtue_id ON public.characters
FOR EACH ROW EXECUTE FUNCTION public.sync_character_virtue_effects_after_change();

CREATE OR REPLACE FUNCTION public.sync_virtue_starting_effects_after_template_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _character_id uuid;
BEGIN
  FOR _character_id IN SELECT c.id FROM public.characters c WHERE c.virtue_id = NEW.id
  LOOP
    PERFORM public.sync_character_virtue_effects(_character_id);
  END LOOP;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS virtues_sync_starting_effects ON public.virtues;
CREATE TRIGGER virtues_sync_starting_effects
AFTER UPDATE OF starting_effects ON public.virtues
FOR EACH ROW EXECUTE FUNCTION public.sync_virtue_starting_effects_after_template_change();

-- Include the new effect types in the class/race starting-effect validators already in production.
DO $$
DECLARE _signature text; _definition text;
BEGIN
  FOREACH _signature IN ARRAY ARRAY[
    'public.sync_character_class_effects(uuid)',
    'public.sync_character_race_effects(uuid)'
  ]
  LOOP
    SELECT pg_get_functiondef(to_regprocedure(_signature)) INTO _definition;
    IF _definition IS NULL THEN RAISE EXCEPTION 'Função não encontrada: %', _signature; END IF;
    _definition := replace(_definition,
      '''damage_received'', ''invincible'', ''healing_blocked'', ''magic_healing_reversal''',
      '''damage_received'', ''invincible'', ''healing_blocked'', ''magic_healing_reversal'', ''mental_control_immunity'', ''mental_control_chance'', ''mental_control_resistance'', ''dot_immunity'', ''invisibility''');
    _definition := replace(_definition,
      'WHEN _stored_type IN (''damage_reduction'', ''invincible'') THEN ''buff''',
      'WHEN _stored_type IN (''damage_reduction'', ''invincible'', ''mental_control_immunity'', ''mental_control_chance'', ''mental_control_resistance'', ''dot_immunity'', ''invisibility'') THEN ''buff''');
    _definition := replace(_definition,
      'IN (''magic_healing_reversal'', ''damage_received'') THEN _effect',
      'IN (''magic_healing_reversal'', ''damage_received'', ''mental_control_chance'', ''mental_control_resistance'', ''dot_immunity'') THEN _effect');
    EXECUTE _definition;
  END LOOP;
END $$;

-- Permanent sheet effects are never reduced, cleansed, or cancelled by ordinary rules.
DO $$
DECLARE _definition text;
BEGIN
  SELECT pg_get_functiondef('public.remove_attack_cancellable_effects(uuid,uuid)'::regprocedure) INTO _definition;
  _definition := replace(_definition,
    'WHERE e.character_id = _character_id' || E'\n' || '    AND NOT e.is_end_effect',
    'WHERE e.character_id = _character_id' || E'\n' || '    AND NOT e.is_sheet_permanent' || E'\n' || '    AND NOT e.is_end_effect');
  EXECUTE _definition;

  SELECT pg_get_functiondef('public.apply_ability_healing(uuid,uuid,jsonb,boolean,boolean)'::regprocedure) INTO _definition;
  _definition := replace(_definition,
    'AND e.source_race_id IS NULL',
    'AND NOT e.is_sheet_permanent AND e.source_race_id IS NULL');
  EXECUTE _definition;

  SELECT pg_get_functiondef('public.advance_combat_turn(uuid,uuid,jsonb)'::regprocedure) INTO _definition;
  _definition := replace(_definition, 'where e.duration = 1', 'where e.duration = 1 AND NOT e.is_sheet_permanent');
  _definition := replace(_definition, 'where e.duration > 1', 'where e.duration > 1 AND NOT e.is_sheet_permanent');
  EXECUTE _definition;
END $$;

CREATE OR REPLACE FUNCTION public.apply_manual_character_effects(
  _character_id uuid,
  _battle_id uuid DEFAULT NULL,
  _source_character_id uuid DEFAULT NULL,
  _effects jsonb DEFAULT '[]'::jsonb,
  _dots jsonb DEFAULT '[]'::jsonb,
  _permanent boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _source_name text;
  _target_battle_id uuid := _battle_id;
  _effect jsonb;
  _dot jsonb;
  _effect_type text;
  _stored_type text;
  _attribute_key text;
  _polarity text;
  _value_mode text;
  _amount numeric;
  _duration integer;
  _damage_scope text;
  _reduction_scope text;
  _type_ids uuid[];
  _magic_levels text[];
  _name text;
  _dot_name text;
  _dot_kind text;
  _dot_mode text;
  _dot_amount numeric;
  _dot_duration integer;
  _dot_physical_id uuid;
  _dot_magic_id uuid;
  _dot_magic_level text;
  _applied integer := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode aplicar efeitos diretamente na ficha.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.characters c WHERE c.id = _character_id) THEN
    RAISE EXCEPTION 'Ficha do alvo não encontrada.';
  END IF;
  IF jsonb_typeof(COALESCE(_effects,'[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(_dots,'[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Efeitos e DoTs precisam ser listas.';
  END IF;
  IF jsonb_array_length(COALESCE(_effects,'[]'::jsonb)) > 50
     OR jsonb_array_length(COALESCE(_dots,'[]'::jsonb)) > 50 THEN
    RAISE EXCEPTION 'Aplique no máximo 50 efeitos e 50 DoTs por vez.';
  END IF;

  IF _battle_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.battles b WHERE b.id = _battle_id AND b.active) THEN
      RAISE EXCEPTION 'A batalha selecionada não está ativa.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.battle_participants bp WHERE bp.battle_id = _battle_id AND bp.character_id = _character_id) THEN
      RAISE EXCEPTION 'O alvo não participa desta batalha.';
    END IF;
    IF _source_character_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.battle_participants bp WHERE bp.battle_id = _battle_id AND bp.character_id = _source_character_id
    ) THEN RAISE EXCEPTION 'O atacante não participa desta batalha.'; END IF;
  END IF;
  IF _source_character_id IS NOT NULL THEN
    SELECT c.name INTO _source_name FROM public.characters c WHERE c.id = _source_character_id;
  END IF;

  IF _permanent THEN
    _target_battle_id := NULL;
  END IF;

  FOR _effect IN SELECT value FROM jsonb_array_elements(COALESCE(_effects,'[]'::jsonb))
  LOOP
    _effect_type := COALESCE(NULLIF(_effect->>'effect_type',''),'status');
    IF _effect_type = 'healing' THEN
      RAISE EXCEPTION 'A cura instantânea deve ser usada como habilidade; ela não pode ser salva como efeito permanente.';
    END IF;
    IF _effect_type NOT IN (
      'status','regeneration','mana_regeneration','mana_used','no_regen_hp','no_regen_mana',
      'magic_prohibition','stun','damage_dealt','no_mana','damage_reduction','damage_received',
      'damage_vulnerability','invincible','healing_blocked','magic_healing_reversal',
      'mental_control_immunity','mental_control_chance','mental_control_resistance','dot_immunity','invisibility'
    ) THEN RAISE EXCEPTION 'Tipo de efeito inválido: %', _effect_type; END IF;

    _stored_type := CASE WHEN _effect_type='mana_regeneration' THEN 'regeneration'
                         WHEN _effect_type='magic_healing_reversal' THEN 'healing_blocked'
                         ELSE _effect_type END;
    _attribute_key := CASE
      WHEN _stored_type IN ('status','damage_vulnerability') THEN NULLIF(_effect->>'attribute_key','')
      WHEN _stored_type='regeneration' THEN CASE WHEN _effect_type='mana_regeneration' THEN 'mana' ELSE NULLIF(_effect->>'attribute_key','') END
      ELSE NULL END;
    _polarity := CASE
      WHEN _stored_type IN ('no_mana','magic_prohibition','healing_blocked','damage_received') THEN 'debuff'
      WHEN _stored_type IN ('damage_reduction','invincible','mental_control_immunity','mental_control_chance','mental_control_resistance','dot_immunity','invisibility') THEN 'buff'
      ELSE CASE WHEN _effect->>'polarity'='debuff' THEN 'debuff' ELSE 'buff' END END;
    _value_mode := CASE WHEN _effect->>'value_mode'='percent' THEN 'percent' ELSE 'fixed' END;
    _amount := GREATEST(0,COALESCE(NULLIF(_effect->>'amount','')::numeric,0));
    _duration := CASE WHEN _permanent THEN 1 ELSE GREATEST(1,LEAST(1000,COALESCE(NULLIF(_effect->>'duration','')::integer,1))) END;
    _damage_scope := CASE WHEN _effect->>'damage_scope' IN ('physical','magical') THEN _effect->>'damage_scope' ELSE 'any' END;
    _reduction_scope := CASE WHEN _effect->>'damage_reduction_scope'='magical' THEN 'magical' ELSE 'physical' END;
    _name := LEFT(COALESCE(NULLIF(BTRIM(_effect->>'name'),''),'Efeito aplicado'),160);
    IF _source_name IS NOT NULL THEN _name := LEFT(_source_name || ': ' || _name, 160); END IF;

    IF _stored_type IN ('status','damage_vulnerability') AND _attribute_key IS NULL THEN
      RAISE EXCEPTION 'Selecione um atributo para o efeito %.', _name;
    END IF;
    IF _stored_type='regeneration' AND _attribute_key NOT IN ('hp','mana') THEN
      RAISE EXCEPTION 'Regeneração só pode afetar HP ou Mana.';
    END IF;
    IF _stored_type IN ('no_mana','magic_prohibition','invincible','healing_blocked','mental_control_immunity','dot_immunity','invisibility') THEN
      _attribute_key := NULL; _amount := 0; _value_mode := 'fixed';
    END IF;
    IF _stored_type IN ('damage_dealt','mana_used') THEN _attribute_key := NULL; END IF;
    IF _stored_type IN ('no_mana','magic_prohibition','healing_blocked','damage_received') THEN
      _polarity := 'debuff'; _attribute_key := NULL;
    END IF;
    IF _stored_type IN ('mental_control_chance','mental_control_resistance') THEN
      _attribute_key := NULL;
      IF _polarity <> 'buff' THEN RAISE EXCEPTION 'Modificadores de Controle Mental só podem ser buffs.'; END IF;
      IF _stored_type='mental_control_chance' AND _value_mode='percent' AND _amount > 99 THEN RAISE EXCEPTION 'Potência de Controle Mental deve ser no máximo 99% por efeito.'; END IF;
      IF _stored_type='mental_control_resistance' AND _value_mode='percent' AND _amount > 1000 THEN RAISE EXCEPTION 'Resistência Mental deve ser no máximo 1000% por efeito.'; END IF;
    END IF;
    IF _stored_type='damage_reduction' THEN
      _attribute_key := NULL; _polarity := 'buff';
      IF _reduction_scope='magical' THEN
        IF jsonb_typeof(_effect->'damage_reduction_type_ids')='array' THEN
          SELECT COALESCE(array_agg(value::uuid),ARRAY[]::uuid[]) INTO _type_ids FROM jsonb_array_elements_text(_effect->'damage_reduction_type_ids') ids(value);
        ELSE _type_ids := ARRAY[]::uuid[]; END IF;
        IF jsonb_typeof(_effect->'damage_reduction_magic_levels')='array' THEN
          SELECT COALESCE(array_agg(value),ARRAY[]::text[]) INTO _magic_levels FROM jsonb_array_elements_text(_effect->'damage_reduction_magic_levels') levels(value);
        ELSE _magic_levels := ARRAY[]::text[]; END IF;
      ELSE _type_ids := NULL; _magic_levels := NULL; END IF;
    ELSE _reduction_scope := 'physical'; _type_ids := NULL; _magic_levels := NULL; END IF;

    INSERT INTO public.battle_effects (
      battle_id,character_id,target_character_id,name,effect_type,attribute_key,polarity,value_mode,amount,
      duration,duration_scope,until_combat_end,damage_scope,damage_reduction_scope,
      damage_reduction_type_id,damage_reduction_magic_level,damage_reduction_type_ids,damage_reduction_magic_levels,
      effect_data,effect_group_id,is_end_effect,is_sheet_permanent
    ) VALUES (
      _target_battle_id,_character_id,_character_id,_name,_stored_type,_attribute_key,_polarity,_value_mode,_amount,
      _duration,'individual',false,_damage_scope,_reduction_scope,NULL,NULL,_type_ids,_magic_levels,
      COALESCE(_effect,'{}'::jsonb) || jsonb_build_object('source_character_id',_source_character_id,'source_character_name',_source_name),
      gen_random_uuid(),false,_permanent
    );
    _applied := _applied + 1;
  END LOOP;

  FOR _dot IN SELECT value FROM jsonb_array_elements(COALESCE(_dots,'[]'::jsonb))
  LOOP
    _dot_name := NULLIF(BTRIM(_dot->>'name'),'');
    _dot_kind := _dot->>'damage_kind';
    _dot_mode := COALESCE(NULLIF(_dot->>'damage_mode',''),'fixed');
    _dot_amount := COALESCE(NULLIF(_dot->>'damage_amount','')::numeric,0);
    _dot_duration := CASE WHEN _permanent THEN 1 ELSE GREATEST(1,LEAST(1000,COALESCE(NULLIF(_dot->>'duration','')::integer,1))) END;
    _dot_physical_id := NULLIF(_dot->>'physical_damage_type_id','')::uuid;
    _dot_magic_id := NULLIF(_dot->>'damage_type_id','')::uuid;
    _dot_magic_level := NULLIF(_dot->>'magic_level','');
    IF _dot_name IS NULL OR length(_dot_name)>120 OR _dot_kind NOT IN ('physical','magical')
       OR _dot_mode NOT IN ('fixed','percent') THEN RAISE EXCEPTION 'Configuração de DoT inválida.'; END IF;
    IF _dot_amount <= 0 OR (_dot_mode='fixed' AND (_dot_amount>1000000 OR _dot_amount<>floor(_dot_amount)))
       OR (_dot_mode='percent' AND _dot_amount>1000) THEN RAISE EXCEPTION 'Valor de DoT inválido.'; END IF;
    IF _dot_kind='physical' AND NOT EXISTS (
      SELECT 1 FROM public.damage_types dt WHERE dt.id=_dot_physical_id AND dt.category='physical'
    ) THEN RAISE EXCEPTION 'Selecione um tipo físico válido para o DoT.'; END IF;
    IF _dot_kind='magical' AND NOT EXISTS (
      SELECT 1 FROM public.damage_types dt WHERE dt.id=_dot_magic_id AND dt.category='magical'
    ) THEN RAISE EXCEPTION 'Selecione um tipo mágico válido para o DoT.'; END IF;
    IF _dot_kind='magical' AND _dot_magic_level NOT IN ('baixa','media','alta') THEN
      RAISE EXCEPTION 'Selecione um grau de magia válido para o DoT.';
    END IF;
    IF public.character_is_immune_to_dot(_character_id,_battle_id,_dot) THEN CONTINUE; END IF;

    _name := CASE WHEN _source_name IS NULL THEN 'DoT — ' || _dot_name ELSE _source_name || ': DoT — ' || _dot_name END;
    INSERT INTO public.battle_effects (
      battle_id,character_id,target_character_id,name,effect_type,attribute_key,polarity,value_mode,amount,
      duration,duration_scope,until_combat_end,damage_scope,effect_data,effect_group_id,is_end_effect,is_sheet_permanent
    ) VALUES (
      _target_battle_id,_character_id,_character_id,LEFT(_name,160),'damage_over_time',NULL,'debuff',
      _dot_mode,_dot_amount,_dot_duration,'individual',false,_dot_kind,
      jsonb_build_object(
        'is_damage_over_time',true,'dot_template_id',COALESCE(_dot->>'template_id',_dot->>'id'),'dot_template_name',_dot_name,
        'damage_kind',_dot_kind,'physical_damage_type_id',_dot_physical_id,'damage_type_id',_dot_magic_id,
        'magic_level',_dot_magic_level,'damage_mode',_dot_mode,'damage_amount',_dot_amount,
        'source_character_id',_source_character_id::text,'source_character_name',_source_name
      ),
      gen_random_uuid(),false,_permanent
    );
    _applied := _applied + 1;
  END LOOP;
  RETURN _applied;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_character_virtue_effects(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_manual_character_effects(uuid,uuid,uuid,jsonb,jsonb,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_manual_character_effects(uuid,uuid,uuid,jsonb,jsonb,boolean) TO authenticated;
