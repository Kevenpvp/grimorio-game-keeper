
-- Persistent transformation catalog and race/virtue grants.
CREATE TABLE IF NOT EXISTS public.transformations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  cooldown_turns integer NOT NULL DEFAULT 3 CHECK (cooldown_turns BETWEEN 1 AND 1000),
  mana_cost integer NOT NULL DEFAULT 0 CHECK (mana_cost BETWEEN 0 AND 1000000),
  modifiers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(modifiers) = 'object'),
  effects jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(effects) = 'array'),
  end_effects jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(end_effects) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.race_transformations (
  race_id uuid NOT NULL REFERENCES public.races(id) ON DELETE CASCADE,
  transformation_id uuid NOT NULL REFERENCES public.transformations(id) ON DELETE CASCADE,
  PRIMARY KEY (race_id, transformation_id)
);
CREATE TABLE IF NOT EXISTS public.virtue_transformations (
  virtue_id uuid NOT NULL REFERENCES public.virtues(id) ON DELETE CASCADE,
  transformation_id uuid NOT NULL REFERENCES public.transformations(id) ON DELETE CASCADE,
  PRIMARY KEY (virtue_id, transformation_id)
);
CREATE TABLE IF NOT EXISTS public.character_transformations (
  character_id uuid NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  transformation_id uuid NOT NULL REFERENCES public.transformations(id) ON DELETE CASCADE,
  image_path text,
  cooldown_remaining integer NOT NULL DEFAULT 0 CHECK (cooldown_remaining BETWEEN 0 AND 1000),
  active boolean NOT NULL DEFAULT false,
  active_battle_id uuid REFERENCES public.battles(id) ON DELETE SET NULL,
  active_effect_group_id uuid,
  applied_attribute_modifiers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(applied_attribute_modifiers) = 'object'),
  applied_body_delta smallint NOT NULL DEFAULT 0,
  applied_sanity_delta smallint NOT NULL DEFAULT 0,
  activated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id, transformation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS character_transformations_one_active_per_character
  ON public.character_transformations(character_id) WHERE active;
CREATE INDEX IF NOT EXISTS character_transformations_active_battle_idx
  ON public.character_transformations(active_battle_id) WHERE active;
CREATE INDEX IF NOT EXISTS race_transformations_transformation_idx ON public.race_transformations(transformation_id);
CREATE INDEX IF NOT EXISTS virtue_transformations_transformation_idx ON public.virtue_transformations(transformation_id);

ALTER TABLE public.transformations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.race_transformations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.virtue_transformations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_transformations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS transformations_read_authenticated ON public.transformations;
CREATE POLICY transformations_read_authenticated ON public.transformations
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS transformations_master_manage ON public.transformations;
CREATE POLICY transformations_master_manage ON public.transformations
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'master')) WITH CHECK (public.has_role(auth.uid(), 'master'));

DROP POLICY IF EXISTS race_transformations_read_authenticated ON public.race_transformations;
CREATE POLICY race_transformations_read_authenticated ON public.race_transformations
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS race_transformations_master_manage ON public.race_transformations;
CREATE POLICY race_transformations_master_manage ON public.race_transformations
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'master')) WITH CHECK (public.has_role(auth.uid(), 'master'));

DROP POLICY IF EXISTS virtue_transformations_read_authenticated ON public.virtue_transformations;
CREATE POLICY virtue_transformations_read_authenticated ON public.virtue_transformations
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS virtue_transformations_master_manage ON public.virtue_transformations;
CREATE POLICY virtue_transformations_master_manage ON public.virtue_transformations
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'master')) WITH CHECK (public.has_role(auth.uid(), 'master'));

DROP POLICY IF EXISTS character_transformations_read_accessible ON public.character_transformations;
CREATE POLICY character_transformations_read_accessible ON public.character_transformations
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(), 'master')
    OR EXISTS (SELECT 1 FROM public.characters c WHERE c.id = character_transformations.character_id AND c.owner_id = auth.uid())
    OR public.shares_battle(character_id)
  );

GRANT SELECT ON public.transformations, public.race_transformations, public.virtue_transformations, public.character_transformations TO authenticated;
GRANT ALL ON public.transformations, public.race_transformations, public.virtue_transformations, public.character_transformations TO service_role;

-- Transformation artwork is stored under character-photos/<character>/transformations/<template>/...
DROP POLICY IF EXISTS players_upload_own_transformation_images ON storage.objects;
CREATE POLICY players_upload_own_transformation_images ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'character-photos'
    AND split_part(objects.name, '/', 2) = 'transformations'
    AND EXISTS (
      SELECT 1 FROM public.characters c
      WHERE c.id::text = split_part(objects.name, '/', 1)
        AND c.owner_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM public.transformations t
      WHERE t.id::text = split_part(objects.name, '/', 3)
    )
  );
DROP POLICY IF EXISTS players_update_own_transformation_images ON storage.objects;
CREATE POLICY players_update_own_transformation_images ON storage.objects
  FOR UPDATE TO authenticated USING (
    bucket_id = 'character-photos'
    AND split_part(objects.name, '/', 2) = 'transformations'
    AND EXISTS (
      SELECT 1 FROM public.characters c
      WHERE c.id::text = split_part(objects.name, '/', 1) AND c.owner_id = auth.uid()
    )
  ) WITH CHECK (
    bucket_id = 'character-photos'
    AND split_part(objects.name, '/', 2) = 'transformations'
    AND EXISTS (
      SELECT 1 FROM public.characters c
      WHERE c.id::text = split_part(objects.name, '/', 1) AND c.owner_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS players_delete_own_transformation_images ON storage.objects;
CREATE POLICY players_delete_own_transformation_images ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'character-photos'
    AND split_part(objects.name, '/', 2) = 'transformations'
    AND EXISTS (
      SELECT 1 FROM public.characters c
      WHERE c.id::text = split_part(objects.name, '/', 1) AND c.owner_id = auth.uid()
    )
  );

CREATE OR REPLACE FUNCTION public.apply_character_transformation_effects(_character_id uuid, _battle_id uuid, _transformation_id uuid, _effects jsonb, _effect_group_id uuid, _is_end_effect boolean, _active_duration integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _effect jsonb;
  _effect_type text;
  _insert_type text;
  _attribute_key text;
  _polarity text;
  _value_mode text;
  _amount numeric;
  _duration integer;
  _damage_scope text;
  _damage_reduction_scope text;
  _damage_reduction_type_id uuid;
  _damage_reduction_magic_level text;
  _damage_reduction_type_ids uuid[];
  _damage_reduction_magic_levels text[];
  _healing_timing text;
  _name text;
  _effect_data jsonb;
  _group_count integer := 0;
BEGIN
  IF jsonb_typeof(COALESCE(_effects, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Lista de efeitos da transformação inválida';
  END IF;

  FOR _effect IN SELECT value FROM jsonb_array_elements(COALESCE(_effects, '[]'::jsonb))
  LOOP
    _effect_type := NULLIF(_effect->>'effect_type','');
    IF _effect_type IS NULL OR _effect_type NOT IN (
      'status','regeneration','mana_regeneration','mana_used','no_regen_hp','no_regen_mana',
      'stun','magic_prohibition','damage_dealt','damage_reduction','damage_received',
      'damage_vulnerability','no_mana','healing','invincible','healing_blocked','magic_healing_reversal'
    ) THEN
      RAISE EXCEPTION 'Tipo de efeito inválido na transformação';
    END IF;

    _insert_type := _effect_type;
    _attribute_key := NULLIF(_effect->>'attribute_key','');
    _polarity := COALESCE(NULLIF(_effect->>'polarity',''), 'buff');
    _value_mode := COALESCE(NULLIF(_effect->>'value_mode',''), 'fixed');
    _amount := COALESCE(NULLIF(_effect->>'amount','')::numeric, 0);
    _duration := CASE
      WHEN COALESCE(_effect->>'duration','') ~ '^[0-9]+$' THEN LEAST(1000,GREATEST(1,(_effect->>'duration')::integer))
      ELSE 1
    END;
    _damage_scope := COALESCE(NULLIF(_effect->>'damage_scope',''), 'any');
    _damage_reduction_scope := COALESCE(NULLIF(_effect->>'damage_reduction_scope',''), 'physical');
    _damage_reduction_type_id := NULL;
    _damage_reduction_magic_level := NULL;
    _damage_reduction_type_ids := ARRAY[]::uuid[];
    _damage_reduction_magic_levels := ARRAY[]::text[];
    _healing_timing := COALESCE(NULLIF(_effect->>'healing_timing',''), 'instant');
    _name := COALESCE(NULLIF(_effect->>'name',''), _effect_type);

    IF _polarity NOT IN ('buff','debuff') OR _value_mode NOT IN ('fixed','percent') OR _amount < 0 OR _amount > 1000000 THEN
      RAISE EXCEPTION 'Valor ou polaridade inválida no efeito de transformação';
    END IF;

    IF _effect_type = 'status' THEN
      IF _attribute_key IS NULL OR NOT EXISTS (SELECT 1 FROM public.attribute_definitions d WHERE d.key = _attribute_key) THEN
        RAISE EXCEPTION 'Buff/debuff de transformação precisa de um atributo válido';
      END IF;
    ELSIF _effect_type = 'regeneration' THEN
      IF _attribute_key NOT IN ('hp','mana') THEN RAISE EXCEPTION 'Regeneração só pode afetar HP ou Mana'; END IF;
    ELSIF _effect_type = 'mana_regeneration' THEN
      _insert_type := 'regeneration';
      _attribute_key := 'mana';
    ELSIF _effect_type = 'mana_used' THEN
      _attribute_key := NULL;
    ELSIF _effect_type = 'damage_dealt' THEN
      _attribute_key := NULL;
      IF jsonb_typeof(_effect->'damage_dealt_physical_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_dealt_physical_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value AND dt.category = 'physical')
      ) THEN RAISE EXCEPTION 'Dano Causado contém um tipo físico inválido'; END IF;
    ELSIF _effect_type = 'damage_reduction' THEN
      IF _polarity <> 'buff' THEN RAISE EXCEPTION 'Mitigação de dano só pode ser um buff'; END IF;
      _attribute_key := NULL;
      IF _damage_reduction_scope NOT IN ('physical','magical') THEN RAISE EXCEPTION 'Categoria de mitigação inválida'; END IF;

      IF jsonb_typeof(_effect->'damage_reduction_type_ids') = 'array' THEN
        SELECT COALESCE(array_agg(value::uuid),ARRAY[]::uuid[]) INTO _damage_reduction_type_ids
        FROM jsonb_array_elements_text(_effect->'damage_reduction_type_ids') selected(value);
      ELSIF NULLIF(_effect->>'damage_reduction_type_id','') IS NOT NULL THEN
        _damage_reduction_type_ids := ARRAY[(_effect->>'damage_reduction_type_id')::uuid];
      END IF;

      IF cardinality(_damage_reduction_type_ids) > 0 AND EXISTS (
        SELECT 1 FROM unnest(_damage_reduction_type_ids) selected(id)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id = selected.id AND dt.category = _damage_reduction_scope)
      ) THEN RAISE EXCEPTION 'Tipo de dano inválido na mitigação'; END IF;

      IF jsonb_typeof(_effect->'damage_reduction_magic_levels') = 'array' THEN
        SELECT COALESCE(array_agg(value),ARRAY[]::text[]) INTO _damage_reduction_magic_levels
        FROM jsonb_array_elements_text(_effect->'damage_reduction_magic_levels') selected(value);
      ELSIF NULLIF(_effect->>'damage_reduction_magic_level','') IN ('baixa','media','alta') THEN
        _damage_reduction_magic_levels := ARRAY[_effect->>'damage_reduction_magic_level'];
      END IF;
      IF EXISTS (SELECT 1 FROM unnest(_damage_reduction_magic_levels) lv WHERE lv NOT IN ('baixa','media','alta')) THEN
        RAISE EXCEPTION 'Grau mágico inválido na mitigação';
      END IF;
    ELSIF _effect_type = 'damage_received' THEN
      _attribute_key := NULL;
      _polarity := 'debuff';
      IF COALESCE(NULLIF(_effect->>'damage_received_scope',''),'any') NOT IN ('any','physical','magical','race') THEN
        RAISE EXCEPTION 'Escopo de Dano Recebido inválido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'damage_received_scope',''),'any') = 'race'
        AND NOT EXISTS (SELECT 1 FROM public.races r WHERE r.id::text = _effect->>'damage_received_race_id') THEN
        RAISE EXCEPTION 'Selecione uma raça válida para Dano Recebido';
      END IF;
    ELSIF _effect_type = 'damage_vulnerability' THEN
      IF _attribute_key IS NULL OR NOT EXISTS (SELECT 1 FROM public.attribute_definitions d WHERE d.key=_attribute_key) THEN
        RAISE EXCEPTION 'Vulnerabilidade de Dano precisa de um atributo válido';
      END IF;
    ELSIF _effect_type IN ('healing_blocked','magic_healing_reversal') THEN
      _attribute_key := NULL;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'debuff';
      IF _effect_type = 'magic_healing_reversal' THEN _insert_type := 'healing_blocked'; END IF;
    ELSIF _effect_type = 'healing' THEN
      _attribute_key := NULL;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
      IF _healing_timing NOT IN ('instant','per_turn') THEN RAISE EXCEPTION 'Modo de cura inválido'; END IF;
      _effect_data := _effect || jsonb_build_object(
        '_runtime_healer_character_id', _character_id,
        'source_transformation_id', _transformation_id,
        'transformation_end_effect', _is_end_effect
      );
      IF _healing_timing = 'instant' THEN
        PERFORM public.apply_ability_healing(_character_id, _battle_id, _effect_data, true, true);
        _group_count := _group_count + 1;
        CONTINUE;
      END IF;
    ELSIF _effect_type = 'invincible' THEN
      _attribute_key := NULL;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
    ELSIF _effect_type IN ('no_mana','magic_prohibition') THEN
      _attribute_key := NULL;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'debuff';
      _damage_scope := 'any';
    ELSE
      _attribute_key := NULL;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
    END IF;

    IF _effect_type = 'healing' AND _healing_timing = 'per_turn' THEN
      _insert_type := 'healing';
    END IF;

    _effect_data := COALESCE(_effect_data, _effect) || jsonb_build_object(
      'source_transformation_id', _transformation_id,
      'transformation_end_effect', _is_end_effect
    );
    INSERT INTO public.battle_effects (
      battle_id,character_id,name,effect_type,attribute_key,polarity,value_mode,amount,
      duration,until_combat_end,duration_scope,source_character_ability_id,effect_group_id,
      is_end_effect,damage_scope,damage_reduction_scope,damage_reduction_type_id,
      damage_reduction_magic_level,damage_reduction_type_ids,damage_reduction_magic_levels,
      target_character_id,effect_data
    ) VALUES (
      CASE WHEN _is_end_effect THEN _battle_id ELSE _battle_id END,
      _character_id,
      'Transformação: ' || _name,
      _insert_type,
      _attribute_key,
      _polarity,
      _value_mode,
      _amount,
      CASE WHEN _is_end_effect THEN _duration ELSE GREATEST(1,COALESCE(_active_duration,1)) END,
      CASE WHEN _is_end_effect THEN COALESCE(NULLIF(_effect->>'until_combat_end','')::boolean,false) ELSE true END,
      'global',
      NULL,
      _effect_group_id,
      _is_end_effect,
      _damage_scope,
      CASE WHEN _insert_type='damage_reduction' THEN _damage_reduction_scope ELSE NULL END,
      _damage_reduction_type_id,
      _damage_reduction_magic_level,
      CASE WHEN _insert_type='damage_reduction' THEN _damage_reduction_type_ids ELSE NULL END,
      CASE WHEN _insert_type='damage_reduction' THEN _damage_reduction_magic_levels ELSE NULL END,
      _character_id,
      _effect_data
    );
    _group_count := _group_count + 1;
  END LOOP;
  RETURN _group_count;
END;
$function$


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

  FOR _item IN SELECT key,value FROM jsonb_each_text(COALESCE(_state.applied_attribute_modifiers,'{}'::jsonb))
  LOOP
    UPDATE public.character_attributes
    SET bonus=bonus-ROUND(_item.value::numeric)::integer,
        updated_at=now()
    WHERE character_id=_character_id AND attribute_key=_item.key;
  END LOOP;

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
  SET active=false,cooldown_remaining=0,active_battle_id=NULL,active_effect_group_id=NULL,
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
$function$


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

  INSERT INTO public.character_transformations(
    character_id,transformation_id,cooldown_remaining,active,active_battle_id,
    active_effect_group_id,applied_attribute_modifiers,applied_body_delta,applied_sanity_delta,activated_at,updated_at
  ) VALUES (
    _character_id,_transformation_id,_transformation.cooldown_turns,true,_battle_id,
    _group_id,_applied_modifiers,_applied_body,_applied_sanity,now(),now()
  )
  ON CONFLICT (character_id,transformation_id) DO UPDATE SET
    cooldown_remaining=EXCLUDED.cooldown_remaining,active=true,active_battle_id=EXCLUDED.active_battle_id,
    active_effect_group_id=EXCLUDED.active_effect_group_id,applied_attribute_modifiers=EXCLUDED.applied_attribute_modifiers,
    applied_body_delta=EXCLUDED.applied_body_delta,applied_sanity_delta=EXCLUDED.applied_sanity_delta,
    activated_at=now(),updated_at=now();

  PERFORM public.apply_character_transformation_effects(
    _character_id,_battle_id,_transformation_id,COALESCE(_transformation.effects,'[]'::jsonb),
    _group_id,false,_transformation.cooldown_turns
  );

  FOR _mod IN SELECT unnest(ARRAY['hp','mana']) AS key
  LOOP
    UPDATE public.character_attributes ca
    SET current_value=LEAST(ca.current_value,public.calculate_character_resource_max(_character_id,_mod.key)::integer),
        updated_at=now()
    WHERE ca.character_id=_character_id AND ca.attribute_key=_mod.key;
  END LOOP;

  RETURN jsonb_build_object('ok',true,'transformation_id',_transformation_id,'cooldown_remaining',_transformation.cooldown_turns);
END;
$function$


CREATE OR REPLACE FUNCTION public.tick_character_transformation_cooldowns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _state record;
BEGIN
  IF NEW.turn_count <= OLD.turn_count THEN RETURN NEW; END IF;
  FOR _state IN
    UPDATE public.character_transformations
    SET cooldown_remaining=GREATEST(0,cooldown_remaining-1),updated_at=now()
    WHERE character_id=NEW.character_id
      AND active IS TRUE
      AND active_battle_id=NEW.battle_id
    RETURNING character_id,transformation_id,cooldown_remaining
  LOOP
    IF _state.cooldown_remaining=0 THEN
      PERFORM public.end_character_transformation_internal(_state.character_id,_state.transformation_id,false);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$


CREATE OR REPLACE FUNCTION public.end_transformations_with_battle()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _state record;
BEGIN
  FOR _state IN
    SELECT character_id,transformation_id
    FROM public.character_transformations
    WHERE active IS TRUE AND active_battle_id=OLD.id
  LOOP
    PERFORM public.end_character_transformation_internal(_state.character_id,_state.transformation_id,true);
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$


CREATE OR REPLACE FUNCTION public.set_character_transformation_image(_character_id uuid, _transformation_id uuid, _image_path text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _character public.characters;
  _prefix text;
  _master boolean := public.has_role(auth.uid(),'master');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  SELECT * INTO _character FROM public.characters WHERE id=_character_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;
  IF NOT _master AND _character.owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Só o dono da ficha pode escolher a imagem da transformação';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.race_transformations rt JOIN public.characters c ON c.race_id=rt.race_id
    WHERE c.id=_character_id AND rt.transformation_id=_transformation_id
    UNION ALL
    SELECT 1 FROM public.virtue_transformations vt JOIN public.characters c ON c.virtue_id=vt.virtue_id
    WHERE c.id=_character_id AND vt.transformation_id=_transformation_id
  ) THEN RAISE EXCEPTION 'Esta transformação não está disponível para o personagem'; END IF;

  _prefix := _character_id::text || '/transformations/' || _transformation_id::text || '/';
  IF _image_path IS NOT NULL AND left(_image_path,length(_prefix)) <> _prefix THEN
    RAISE EXCEPTION 'Caminho de imagem de transformação inválido';
  END IF;

  INSERT INTO public.character_transformations(character_id,transformation_id,image_path)
  VALUES (_character_id,_transformation_id,_image_path)
  ON CONFLICT (character_id,transformation_id)
  DO UPDATE SET image_path=EXCLUDED.image_path,updated_at=now();
END;
$function$



REVOKE ALL ON FUNCTION public.apply_character_transformation_effects(uuid,uuid,uuid,jsonb,uuid,boolean,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_character_transformation_effects(uuid,uuid,uuid,jsonb,uuid,boolean,integer) TO service_role;
REVOKE ALL ON FUNCTION public.end_character_transformation_internal(uuid,uuid,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_character_transformation_internal(uuid,uuid,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.activate_character_transformation(uuid,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activate_character_transformation(uuid,uuid,uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_character_transformation_image(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_character_transformation_image(uuid,uuid,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.tick_character_transformation_cooldowns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tick_character_transformation_cooldowns() TO service_role;
REVOKE ALL ON FUNCTION public.end_transformations_with_battle() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_transformations_with_battle() TO service_role;

DROP TRIGGER IF EXISTS battle_participants_tick_transformations ON public.battle_participants;
CREATE TRIGGER battle_participants_tick_transformations
AFTER UPDATE OF turn_count ON public.battle_participants
FOR EACH ROW EXECUTE FUNCTION public.tick_character_transformation_cooldowns();

DROP TRIGGER IF EXISTS battles_end_transformations ON public.battles;
CREATE TRIGGER battles_end_transformations
AFTER UPDATE OF active ON public.battles
FOR EACH ROW WHEN (OLD.active IS TRUE AND NEW.active IS FALSE)
EXECUTE FUNCTION public.end_transformations_with_battle();

DROP TRIGGER IF EXISTS battles_delete_transformations ON public.battles;
CREATE TRIGGER battles_delete_transformations
BEFORE DELETE ON public.battles
FOR EACH ROW EXECUTE FUNCTION public.end_transformations_with_battle();

DO $publication$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'character_transformations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.character_transformations;
  END IF;
END;
$publication$;
