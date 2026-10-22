-- Scale current HP/Mana proportionally when a transformation's direct attribute modifiers change the maximum.

CREATE OR REPLACE FUNCTION public.activate_character_transformation(_character_id uuid, _transformation_id uuid, _battle_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _character public.characters;
  _transformation public.transformations;
  _state public.character_transformations;
  _master boolean := public.has_role(auth.uid(),'master');
  _available boolean := false;
  _mana_current integer;
  _mana_max integer;
  _group_id uuid := gen_random_uuid();
  _mod record;
  _delta integer;
  _before integer;
  _after integer;
  _applied_body integer := 0;
  _applied_sanity integer := 0;
  _applied_modifiers jsonb := '{}'::jsonb;
  _old_hp_max numeric;
  _old_mana_max numeric;
  _new_hp_max numeric;
  _new_mana_max numeric;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  SELECT * INTO _character FROM public.characters WHERE id=_character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;
  IF NOT _master AND _character.owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Só o dono da ficha pode ativar esta transformação';
  END IF;

  SELECT * INTO _transformation FROM public.transformations WHERE id=_transformation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transformação não encontrada'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.race_transformations rt WHERE rt.race_id=_character.race_id AND rt.transformation_id=_transformation_id
    UNION ALL
    SELECT 1 FROM public.virtue_transformations vt WHERE vt.virtue_id=_character.virtue_id AND vt.transformation_id=_transformation_id
  ) INTO _available;
  IF NOT _available AND NOT _master THEN
    RAISE EXCEPTION 'Esta transformação não foi concedida pela raça ou virtude do personagem';
  END IF;

  IF _battle_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.battles b JOIN public.battle_participants bp ON bp.battle_id=b.id
    WHERE b.id=_battle_id AND b.active IS TRUE AND bp.character_id=_character_id
  ) THEN
    RAISE EXCEPTION 'O personagem precisa estar em uma batalha ativa para se transformar';
  END IF;

  IF EXISTS (SELECT 1 FROM public.character_transformations ct WHERE ct.character_id=_character_id AND ct.active) THEN
    RAISE EXCEPTION 'O personagem já está transformado';
  END IF;

  SELECT * INTO _state FROM public.character_transformations
  WHERE character_id=_character_id AND transformation_id=_transformation_id FOR UPDATE;
  IF FOUND AND _state.cooldown_remaining>0 THEN
    RAISE EXCEPTION 'Transformação em cooldown: faltam % turno(s)',_state.cooldown_remaining;
  END IF;

  IF _transformation.mana_cost>0 THEN
    IF public.character_has_no_mana(_character_id) THEN RAISE EXCEPTION 'O personagem está sem acesso à Mana'; END IF;
    SELECT current_value INTO _mana_current FROM public.character_attributes
    WHERE character_id=_character_id AND attribute_key='mana' FOR UPDATE;
    _mana_max := public.calculate_character_resource_max(_character_id,'mana')::integer;
    IF COALESCE(_mana_current,0)<_transformation.mana_cost THEN
      RAISE EXCEPTION 'Mana insuficiente: necessário %, disponível %',_transformation.mana_cost,COALESCE(_mana_current,0);
    END IF;
    UPDATE public.character_attributes SET current_value=GREATEST(0,current_value-_transformation.mana_cost),updated_at=now()
    WHERE character_id=_character_id AND attribute_key='mana';
  END IF;

  -- Snapshot maxima before the transformation changes direct attribute bonuses.
  _old_hp_max := public.calculate_character_resource_max(_character_id, 'hp');
  _old_mana_max := public.calculate_character_resource_max(_character_id, 'mana');

  FOR _mod IN SELECT key,value FROM jsonb_each_text(COALESCE(_transformation.modifiers,'{}'::jsonb))
  LOOP
    IF COALESCE(_mod.value,'') !~ '^-?[0-9]+([.][0-9]+)?$' THEN RAISE EXCEPTION 'Modificador inválido: %',_mod.key; END IF;
    _delta := ROUND(_mod.value::numeric)::integer;
    IF _delta < -1000000 OR _delta > 1000000 THEN RAISE EXCEPTION 'Modificador fora do limite: %',_mod.key; END IF;

    IF _mod.key='body' THEN
      SELECT body INTO _before FROM public.characters WHERE id=_character_id;
      UPDATE public.characters SET body=GREATEST(0,LEAST(100,body+_delta)),updated_at=now()
      WHERE id=_character_id RETURNING body INTO _after;
      _applied_body := _after-_before;
    ELSIF _mod.key='sanity' THEN
      SELECT sanity INTO _before FROM public.characters WHERE id=_character_id;
      UPDATE public.characters SET sanity=GREATEST(0,LEAST(100,sanity+_delta)),updated_at=now()
      WHERE id=_character_id RETURNING sanity INTO _after;
      _applied_sanity := _after-_before;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM public.attribute_definitions WHERE key=_mod.key) THEN
        RAISE EXCEPTION 'Atributo desconhecido na transformação: %',_mod.key;
      END IF;
      UPDATE public.character_attributes
      SET bonus=bonus+_delta,updated_at=now()
      WHERE character_id=_character_id AND attribute_key=_mod.key;
      IF NOT FOUND THEN RAISE EXCEPTION 'Atributo % não existe na ficha',_mod.key; END IF;
      _applied_modifiers := _applied_modifiers || jsonb_build_object(_mod.key,_delta);
    END IF;
  END LOOP;

  -- Keep the same current/max ratio when direct transformation modifiers change HP/Mana max.
  _new_hp_max := public.calculate_character_resource_max(_character_id, 'hp');
  _new_mana_max := public.calculate_character_resource_max(_character_id, 'mana');
  PERFORM public.scale_character_resource_current(_character_id, 'hp', _old_hp_max, _new_hp_max);
  PERFORM public.scale_character_resource_current(_character_id, 'mana', _old_mana_max, _new_mana_max);

  INSERT INTO public.character_transformations(
    character_id,transformation_id,cooldown_remaining,active_duration_remaining,active,active_battle_id,
    active_effect_group_id,applied_attribute_modifiers,applied_body_delta,applied_sanity_delta,activated_at,updated_at
  ) VALUES (
    _character_id,_transformation_id,_transformation.cooldown_turns,_transformation.duration_turns,true,_battle_id,
    _group_id,_applied_modifiers,_applied_body,_applied_sanity,now(),now()
  )
  ON CONFLICT (character_id,transformation_id) DO UPDATE SET
    cooldown_remaining=EXCLUDED.cooldown_remaining,active_duration_remaining=EXCLUDED.active_duration_remaining,active=true,active_battle_id=EXCLUDED.active_battle_id,
    active_effect_group_id=EXCLUDED.active_effect_group_id,applied_attribute_modifiers=EXCLUDED.applied_attribute_modifiers,
    applied_body_delta=EXCLUDED.applied_body_delta,applied_sanity_delta=EXCLUDED.applied_sanity_delta,
    activated_at=now(),updated_at=now();

  PERFORM public.apply_character_transformation_effects(
    _character_id,_battle_id,_transformation_id,COALESCE(_transformation.effects,'[]'::jsonb),
    _group_id,false,_transformation.duration_turns
  );

  FOR _mod IN SELECT unnest(ARRAY['hp','mana']) AS key
  LOOP
    UPDATE public.character_attributes ca
    SET current_value=LEAST(ca.current_value,public.calculate_character_resource_max(_character_id,_mod.key)::integer),
        updated_at=now()
    WHERE ca.character_id=_character_id AND ca.attribute_key=_mod.key;
  END LOOP;

  RETURN jsonb_build_object('ok',true,'transformation_id',_transformation_id,'cooldown_remaining',_transformation.cooldown_turns,'duration_remaining',_transformation.duration_turns);
END;
$function$;

CREATE OR REPLACE FUNCTION public.end_character_transformation_internal(_character_id uuid, _transformation_id uuid, _force_standalone boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _state public.character_transformations;
  _name text;
  _end_effects jsonb;
  _effect_battle_id uuid;
  _end_group_id uuid := gen_random_uuid();
  _item record;
  _old_hp_max numeric;
  _old_mana_max numeric;
  _new_hp_max numeric;
  _new_mana_max numeric;
BEGIN
  SELECT * INTO _state
  FROM public.character_transformations
  WHERE character_id=_character_id AND transformation_id=_transformation_id
  FOR UPDATE;
  IF NOT FOUND OR NOT _state.active THEN RETURN; END IF;

  SELECT t.name,t.end_effects INTO _name,_end_effects
  FROM public.transformations t WHERE t.id=_transformation_id;

  IF _state.active_effect_group_id IS NOT NULL THEN
    DELETE FROM public.battle_effects WHERE effect_group_id=_state.active_effect_group_id;
  END IF;

  -- The transformation's temporary effects are gone; now snapshot maxima before
  -- removing the transformation's direct HP/Mana attribute bonuses.
  _old_hp_max := public.calculate_character_resource_max(_character_id, 'hp');
  _old_mana_max := public.calculate_character_resource_max(_character_id, 'mana');

  FOR _item IN SELECT key,value FROM jsonb_each_text(COALESCE(_state.applied_attribute_modifiers,'{}'::jsonb))
  LOOP
    UPDATE public.character_attributes
    SET bonus=bonus-ROUND(_item.value::numeric)::integer,
        updated_at=now()
    WHERE character_id=_character_id AND attribute_key=_item.key;
  END LOOP;

  -- Preserve the current/max ratio after the direct transformation bonuses are restored.
  _new_hp_max := public.calculate_character_resource_max(_character_id, 'hp');
  _new_mana_max := public.calculate_character_resource_max(_character_id, 'mana');
  PERFORM public.scale_character_resource_current(_character_id, 'hp', _old_hp_max, _new_hp_max);
  PERFORM public.scale_character_resource_current(_character_id, 'mana', _old_mana_max, _new_mana_max);

  UPDATE public.characters
  SET body=GREATEST(0,LEAST(100,body-COALESCE(_state.applied_body_delta,0))),
      sanity=GREATEST(0,LEAST(100,sanity-COALESCE(_state.applied_sanity_delta,0))),
      updated_at=now()
  WHERE id=_character_id;

  FOR _item IN SELECT unnest(ARRAY['hp','mana']) AS key
  LOOP
    UPDATE public.character_attributes ca
    SET current_value=LEAST(ca.current_value,public.calculate_character_resource_max(_character_id,_item.key)::integer),
        updated_at=now()
    WHERE ca.character_id=_character_id AND ca.attribute_key=_item.key;
  END LOOP;

  UPDATE public.character_transformations
  SET active=false,active_duration_remaining=0,active_battle_id=NULL,active_effect_group_id=NULL,
      applied_attribute_modifiers='{}'::jsonb,applied_body_delta=0,applied_sanity_delta=0,updated_at=now()
  WHERE character_id=_character_id AND transformation_id=_transformation_id;

  SELECT b.id INTO _effect_battle_id
  FROM public.battles b
  WHERE b.id=_state.active_battle_id AND b.active IS TRUE;
  IF _force_standalone OR _effect_battle_id IS NULL THEN
    _effect_battle_id := NULL;
  END IF;

  PERFORM public.apply_character_transformation_effects(
    _character_id,_effect_battle_id,_transformation_id,COALESCE(_end_effects,'[]'::jsonb),
    _end_group_id,true,0
  );
END;
$function$;
