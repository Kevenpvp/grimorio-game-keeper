-- Custom summon stat overrides represent the creature's BASE attribute
-- value. Avoid double-counting original points and copied bonus amounts.
CREATE OR REPLACE FUNCTION public.create_summon_instance(_grant_id uuid, _summoner_id uuid, _battle_id uuid, _transfer_override jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _grant public.summon_grants;
  _template public.characters;
  _summoner public.characters;
  _summon_id uuid;
  _instance_id uuid;
  _transfer jsonb;
  _config record;
  _attribute record;
  _value numeric;
  _sort integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode invocar criaturas';
  END IF;
  SELECT * INTO _grant FROM public.summon_grants WHERE id=_grant_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invocação não configurada'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.battles WHERE id=_battle_id AND active) THEN
    RAISE EXCEPTION 'A batalha precisa estar ativa';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.battle_participants WHERE battle_id=_battle_id AND character_id=_summoner_id) THEN
    RAISE EXCEPTION 'O invocador precisa estar na batalha';
  END IF;
  IF NOT (
    _grant.summoner_character_id=_summoner_id
    OR (_grant.ability_id IS NOT NULL AND EXISTS(
      SELECT 1 FROM public.character_abilities ca
      WHERE ca.character_id=_summoner_id AND ca.ability_id=_grant.ability_id
    ))
  ) THEN
    RAISE EXCEPTION 'A invocação não pertence ao personagem';
  END IF;
  IF EXISTS (SELECT 1 FROM public.active_summons s
    WHERE s.grant_id=_grant_id AND s.battle_id=_battle_id AND s.summoner_character_id=_summoner_id)
  THEN RAISE EXCEPTION 'Essa invocação já está na batalha'; END IF;

  SELECT * INTO _template FROM public.characters WHERE id=_grant.template_character_id;
  SELECT * INTO _summoner FROM public.characters WHERE id=_summoner_id;
  IF NOT FOUND OR _template.id IS NULL THEN RAISE EXCEPTION 'Ficha de origem ou invocador não encontrado'; END IF;
  IF EXISTS(SELECT 1 FROM public.active_summons WHERE summoned_character_id=_template.id) THEN
    RAISE EXCEPTION 'Não é possível usar uma invocação temporária como modelo';
  END IF;

  _transfer := COALESCE(_transfer_override,_grant.transfer_stats);
  IF jsonb_typeof(_transfer)<>'object' THEN RAISE EXCEPTION 'Transferência inválida'; END IF;
  FOR _config IN SELECT key,value FROM jsonb_each(_transfer) LOOP
    IF NOT EXISTS(SELECT 1 FROM public.attribute_definitions WHERE key=_config.key)
       OR jsonb_typeof(_config.value)<>'number'
       OR (_config.value#>>'{}')::numeric<0
       OR (_config.value#>>'{}')::numeric>1000000
       OR trunc((_config.value#>>'{}')::numeric)<>(_config.value#>>'{}')::numeric THEN
      RAISE EXCEPTION 'Transferência inválida: %', _config.key;
    END IF;
    SELECT ca.current_value,ca.max_value,ca.points,ca.bonus,ad.base_value,ad.points_multiplier,ad.accepts_points
    INTO _attribute
    FROM public.character_attributes ca JOIN public.attribute_definitions ad ON ad.key=ca.attribute_key
    WHERE ca.character_id=_summoner_id AND ca.attribute_key=_config.key;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invocador não possui o atributo %',_config.key; END IF;
    _value := (_config.value#>>'{}')::numeric;
    IF _value>GREATEST(0,CASE WHEN _config.key IN ('hp','mana') THEN _attribute.current_value
       WHEN _attribute.accepts_points THEN _attribute.base_value + _attribute.points*_attribute.points_multiplier + _attribute.bonus
       ELSE _attribute.max_value END) THEN
      RAISE EXCEPTION 'Não há pontos suficientes para transferir %',_config.key;
    END IF;
  END LOOP;

  INSERT INTO public.characters (
    name,player_name,description,photo_path,owner_id,is_summon_snapshot,body,sanity,race_id,virtue_id,class_id,
    class_custom_modifiers,race_attribute_allocations,virtue_attribute_allocations,
    class_attribute_allocations,race_physical_allocations,virtue_physical_allocations,
    class_physical_allocations
  )
  SELECT
    COALESCE(NULLIF(_grant.display_name,''),_template.name)||' · Invocação',
    _summoner.name, _template.description,_template.photo_path,_summoner.owner_id,true,
    _template.body,_template.sanity,_template.race_id,_template.virtue_id,_template.class_id,
    _template.class_custom_modifiers,_template.race_attribute_allocations,_template.virtue_attribute_allocations,
    _template.class_attribute_allocations,_template.race_physical_allocations,_template.virtue_physical_allocations,
    _template.class_physical_allocations
  RETURNING id INTO _summon_id;

  -- Snapshot all resource/stat rows. The original creature is never modified.
  INSERT INTO public.character_attributes
    (character_id,attribute_key,current_value,max_value,points,bonus)
  SELECT _summon_id,attribute_key,current_value,max_value,points,bonus
  FROM public.character_attributes WHERE character_id=_template.id
  ON CONFLICT(character_id,attribute_key) DO UPDATE
  SET current_value=EXCLUDED.current_value,max_value=EXCLUDED.max_value,
      points=EXCLUDED.points,bonus=EXCLUDED.bonus;

  FOR _config IN SELECT key,value FROM jsonb_each(_grant.custom_stats) LOOP
    _value:=(_config.value#>>'{}')::numeric;
    -- The override sets the creature's own base attribute, not an extra
    -- additive bonus. Race/class/virtue and temporary status effects continue
    -- applying normally on top of that base value.
    UPDATE public.character_attributes a
    SET points=CASE WHEN d.accepts_points
      THEN FLOOR(_value/GREATEST(1,d.points_multiplier))::integer ELSE 0 END,
      max_value=_value::integer,
      current_value=_value::integer,
      bonus=CASE WHEN d.accepts_points THEN
        (_value-d.base_value
          -FLOOR(_value/GREATEST(1,d.points_multiplier))*d.points_multiplier)::integer
        ELSE 0 END
    FROM public.attribute_definitions d
    WHERE a.character_id=_summon_id AND a.attribute_key=_config.key AND d.key=a.attribute_key;
  END LOOP;

  INSERT INTO public.character_abilities (
    character_id,ability_id,name,description,is_passive,can_activate,
    self_target_only,is_magical,cooldown_turns,cooldown_remaining,mana_cost,
    effects,passive_effects,end_effects,once_per_battle,custom_attributes,toggle_mode
  )
  SELECT _summon_id,ca.ability_id,ca.name,ca.description,ca.is_passive,
    ca.can_activate,ca.self_target_only,ca.is_magical,ca.cooldown_turns,0,ca.mana_cost,
    ca.effects,ca.passive_effects,ca.end_effects,ca.once_per_battle,ca.custom_attributes,ca.toggle_mode
  FROM public.character_abilities ca WHERE ca.character_id=_template.id
  ON CONFLICT (character_id,ability_id) DO NOTHING;

  SELECT COALESCE(MAX(sort_order)+1,0) INTO _sort FROM public.battle_participants WHERE battle_id=_battle_id;
  INSERT INTO public.battle_participants(battle_id,character_id,sort_order)
  VALUES (_battle_id,_summon_id,_sort);

  INSERT INTO public.active_summons
    (battle_id,grant_id,summoned_character_id,summoner_character_id,template_character_id,transferred_stats)
  VALUES (_battle_id,_grant_id,_summon_id,_summoner_id,_template.id,_transfer)
  RETURNING id INTO _instance_id;

  FOR _config IN SELECT key,value FROM jsonb_each(_transfer) LOOP
    _value := (_config.value#>>'{}')::numeric;
    IF _value=0 THEN CONTINUE; END IF;
    INSERT INTO public.battle_effects(
      battle_id,character_id,name,effect_type,attribute_key,polarity,value_mode,
      amount,duration,until_combat_end,duration_scope,effect_data
    ) VALUES
      (_battle_id,_summoner_id,'Pontos emprestados à invocação','status',_config.key,
       'debuff','fixed',_value,1,true,'global',jsonb_build_object('summon_instance_id',_instance_id::text)),
      (_battle_id,_summon_id,'Pontos recebidos do invocador','status',_config.key,
       'buff','fixed',_value,1,true,'global',jsonb_build_object('summon_instance_id',_instance_id::text));
  END LOOP;
  RETURN _summon_id;
END;
$function$
;
