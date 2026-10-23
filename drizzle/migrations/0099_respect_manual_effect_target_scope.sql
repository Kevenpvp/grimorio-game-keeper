-- Respect the effect editor destination setting in manual combat/sheet effects.
CREATE OR REPLACE FUNCTION public.apply_manual_character_effects(_character_id uuid, _battle_id uuid DEFAULT NULL::uuid, _source_character_id uuid DEFAULT NULL::uuid, _effects jsonb DEFAULT '[]'::jsonb, _dots jsonb DEFAULT '[]'::jsonb, _permanent boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  _until_combat_end boolean;
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
  _effect_target_id uuid;
  _effect_target_ids uuid[];
  _effect_target_scope text;
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
    _until_combat_end := NOT _permanent AND _target_battle_id IS NOT NULL
      AND COALESCE((_effect->>'until_combat_end')::boolean, false);
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
      IF _stored_type='mental_control_chance' AND _value_mode='percent' AND _amount > 99 THEN RAISE EXCEPTION 'Potência de Controle Mental deve ser no máximo 99 por cento por efeito.'; END IF;
      IF _stored_type='mental_control_resistance' AND _value_mode='percent' AND _amount > 1000 THEN RAISE EXCEPTION 'Resistência Mental deve ser no máximo 1000 por cento por efeito.'; END IF;
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

    _effect_target_scope := COALESCE(NULLIF(_effect->>'target_scope',''),'target');
    IF _effect_target_scope NOT IN ('caster','target','both') THEN
      RAISE EXCEPTION 'Destino do efeito manual inválido.';
    END IF;
    IF _effect_target_scope IN ('caster','both') AND _source_character_id IS NULL THEN
      RAISE EXCEPTION 'Selecione quem está causando o efeito para usar o destino Caster ou Ambos.';
    END IF;
    IF _effect_target_scope = 'caster' THEN
      _effect_target_ids := ARRAY[_source_character_id];
    ELSIF _effect_target_scope = 'both' AND _source_character_id IS DISTINCT FROM _character_id THEN
      _effect_target_ids := ARRAY[_character_id,_source_character_id];
    ELSE
      _effect_target_ids := ARRAY[_character_id];
    END IF;

    FOREACH _effect_target_id IN ARRAY _effect_target_ids
    LOOP
      INSERT INTO public.battle_effects (
        battle_id,character_id,target_character_id,name,effect_type,attribute_key,polarity,value_mode,amount,
        duration,duration_scope,until_combat_end,damage_scope,damage_reduction_scope,
        damage_reduction_type_id,damage_reduction_magic_level,damage_reduction_type_ids,damage_reduction_magic_levels,
        effect_data,effect_group_id,is_end_effect,is_sheet_permanent
      ) VALUES (
        _target_battle_id,_effect_target_id,_effect_target_id,_name,_stored_type,_attribute_key,_polarity,_value_mode,_amount,
        _duration,'individual',_until_combat_end,_damage_scope,_reduction_scope,NULL,NULL,_type_ids,_magic_levels,
        COALESCE(_effect,'{}'::jsonb) || jsonb_build_object('source_character_id',_source_character_id,'source_character_name',_source_name),
        gen_random_uuid(),false,_permanent
      );
      _applied := _applied + 1;
    END LOOP;
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
$function$

