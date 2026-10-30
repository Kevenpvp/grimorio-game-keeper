-- Lágrimas das pétalas: individual stacks and a one-shot, master-configured
-- Sangramento tied exclusively to an equipped Relíquia - Espada Florin.
-- State lives on the granted character ability, not the global item template.
ALTER TABLE public.character_abilities DROP CONSTRAINT IF EXISTS custom_sheet_script_allowed;
ALTER TABLE public.character_abilities ADD CONSTRAINT custom_sheet_script_allowed
  CHECK (custom_script_key IS NULL OR custom_script_key=ANY(ARRAY[
    'example','demonio_interno','coracao_corrompido','sedento_por_sangue',
    'barrincar','lagrimas_petalas'
  ]));

UPDATE public.abilities
SET custom_script_key='lagrimas_petalas'
WHERE id='4bc9cd81-b5ae-4b68-a3be-9d8a6f833e2c'::uuid
  AND lower(btrim(name))='lágrimas das pétalas.';
UPDATE public.character_abilities
SET custom_script_key='lagrimas_petalas'
WHERE id='4e37fe60-fe50-4467-9e2f-15872937face'::uuid
  AND ability_id='4bc9cd81-b5ae-4b68-a3be-9d8a6f833e2c'::uuid
  AND source_inventory_item_id='a3d01c00-b493-4f7a-a647-b5eb37d540ec'::uuid;

CREATE OR REPLACE FUNCTION public.florin_petals_max_stacks(_attrs jsonb)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT LEAST(10000,GREATEST(0,COALESCE((
    SELECT floor((x->>'value')::numeric)::integer FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(_attrs)='array' THEN _attrs ELSE '[]'::jsonb END
    ) x WHERE x->>'name'='StacksMaximos' AND x->>'type'='number'
      AND COALESCE(x->>'value','') ~ '^[0-9]+([.][0-9]+)?$'
    LIMIT 1
  ),0)));
$fn$;

CREATE OR REPLACE FUNCTION public.list_florin_petals_battle(_battle_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE _output jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode consultar Lágrimas das pétalas';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'ability_id',ca.id,'character_id',ca.character_id,
    'weapon_name',t.name,
    'stacks',CASE WHEN ca.custom_state->>'florin_battle_id'=_battle_id::text
       THEN LEAST(public.florin_petals_max_stacks(ca.custom_attributes),
         GREATEST(0,COALESCE((ca.custom_state->>'florin_stacks')::integer,0)))
       ELSE 0 END,
    'max_stacks',public.florin_petals_max_stacks(ca.custom_attributes),
    'threshold',LEAST(GREATEST(1,COALESCE((ca.custom_state->>'florin_threshold')::integer,
      public.florin_petals_max_stacks(ca.custom_attributes))),GREATEST(1,public.florin_petals_max_stacks(ca.custom_attributes))),
    'pending',CASE WHEN ca.custom_state->>'florin_battle_id'=_battle_id::text
      THEN ca.custom_state->'florin_pending_bleed' ELSE NULL END
  ) ORDER BY t.name,ca.id),'[]'::jsonb) INTO _output
  FROM public.character_abilities ca
  JOIN public.character_inventory i ON i.id=ca.source_inventory_item_id
    AND i.character_id=ca.character_id AND i.equipped
  JOIN public.item_templates t ON t.id=i.item_template_id
    AND t.item_type='weapon'
  JOIN public.battle_participants bp ON bp.character_id=ca.character_id
    AND bp.battle_id=_battle_id
  WHERE ca.custom_script_key='lagrimas_petalas'
    AND ca.ability_id=ANY(t.ability_ids)
    AND public.florin_petals_max_stacks(ca.custom_attributes)>0;
  RETURN _output;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.control_florin_petals(
  _battle_id uuid,
  _ability_id uuid,
  _action text,
  _value integer DEFAULT NULL,
  _mode text DEFAULT NULL,
  _damage numeric DEFAULT NULL,
  _duration integer DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE _ability record;_state jsonb;_max int;_stacks int;_threshold int;_pending jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode modificar stacks';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.battles WHERE id=_battle_id AND active) THEN
    RAISE EXCEPTION 'A batalha precisa estar ativa';
  END IF;
  SELECT ca.id,ca.custom_state,ca.custom_attributes INTO _ability
  FROM public.character_abilities ca
  JOIN public.character_inventory i ON i.id=ca.source_inventory_item_id
    AND i.equipped AND i.character_id=ca.character_id
  JOIN public.item_templates t ON t.id=i.item_template_id
    AND t.item_type='weapon' AND ca.ability_id=ANY(t.ability_ids)
  JOIN public.battle_participants bp ON bp.battle_id=_battle_id
    AND bp.character_id=ca.character_id
  WHERE ca.id=_ability_id AND ca.custom_script_key='lagrimas_petalas'
  FOR UPDATE OF ca;
  IF NOT FOUND THEN RAISE EXCEPTION 'Habilidade da arma equipada não disponível neste combate'; END IF;
  _max:=public.florin_petals_max_stacks(_ability.custom_attributes);
  IF _max<1 THEN RAISE EXCEPTION 'Configure StacksMaximos acima de zero na habilidade'; END IF;
  _state:=COALESCE(_ability.custom_state,'{}'::jsonb);
  IF _state->>'florin_battle_id' IS DISTINCT FROM _battle_id::text THEN
    _state:=_state || jsonb_build_object('florin_battle_id',_battle_id,
      'florin_stacks',0,'florin_threshold',_max,'florin_pending_bleed',NULL);
  END IF;
  _stacks:=LEAST(_max,GREATEST(0,COALESCE((_state->>'florin_stacks')::integer,0)));
  _threshold:=LEAST(_max,GREATEST(1,COALESCE((_state->>'florin_threshold')::integer,_max)));
  _pending:=_state->'florin_pending_bleed';
  IF _action='adjust' THEN
    IF _value NOT IN (-1,1) OR _value IS NULL THEN RAISE EXCEPTION 'Use +1 ou -1 stack'; END IF;
    _stacks:=LEAST(_max,GREATEST(0,_stacks+_value));
    IF _stacks<_threshold THEN _pending:=NULL; END IF;
  ELSIF _action='threshold' THEN
    IF _value IS NULL OR _value<1 OR _value>_max THEN
      RAISE EXCEPTION 'O limite para o DoT precisa ficar entre 1 e StacksMaximos';
    END IF;
    _threshold:=_value;
    _pending:=NULL;
  ELSIF _action='arm' THEN
    IF _stacks<_threshold THEN RAISE EXCEPTION 'Acumule os stacks necessários para preparar o Sangramento'; END IF;
    IF _mode NOT IN ('fixed','percent') OR _mode IS NULL
       OR _damage IS NULL OR _damage<=0
       OR _damage>(CASE WHEN _mode='fixed' THEN 1000000 ELSE 1000 END)
       OR (_mode='fixed' AND _damage<>floor(_damage))
       OR _duration IS NULL OR _duration<1 OR _duration>1000 THEN
      RAISE EXCEPTION 'Dano ou duração do Sangramento inválidos';
    END IF;
    _pending:=jsonb_build_object('damage_mode',_mode,
      'damage_amount',_damage,'duration',_duration);
  ELSIF _action='clear' THEN
    _pending:=NULL;
  ELSE RAISE EXCEPTION 'Ação de Lágrimas das pétalas inválida';
  END IF;
  _state:=_state||jsonb_build_object(
    'florin_stacks',_stacks,'florin_threshold',_threshold,'florin_pending_bleed',_pending);
  UPDATE public.character_abilities SET custom_state=_state WHERE id=_ability.id;
  RETURN jsonb_build_object('stacks',_stacks,'max_stacks',_max,'threshold',_threshold,'pending',_pending);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.consume_florin_weapon_bleed(
  _battle_id uuid,_source_character_id uuid,_target_character_id uuid,
  _inventory_item_id uuid,_final_damage numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE _ability record;_pending jsonb;_template record;_state jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode aplicar Sangramento da Florin';
  END IF;
  -- The calling damage runtime reports the post-defense damage.
  IF _final_damage IS NULL OR _final_damage<=0 THEN RETURN jsonb_build_object('applied',false); END IF;
  IF NOT EXISTS(SELECT 1 FROM public.battles WHERE id=_battle_id AND active)
     OR NOT EXISTS(SELECT 1 FROM public.battle_participants WHERE battle_id=_battle_id AND character_id=_source_character_id)
     OR NOT EXISTS(SELECT 1 FROM public.battle_participants WHERE battle_id=_battle_id AND character_id=_target_character_id)
     OR _source_character_id=_target_character_id THEN
    RAISE EXCEPTION 'O golpe deve atingir um adversário da batalha ativa';
  END IF;
  SELECT ca.id,ca.custom_state INTO _ability
  FROM public.character_inventory i
  JOIN public.item_templates t ON t.id=i.item_template_id
  JOIN public.character_abilities ca ON ca.source_inventory_item_id=i.id
    AND ca.character_id=i.character_id
    AND ca.ability_id=ANY(t.ability_ids)
  WHERE i.id=_inventory_item_id AND i.character_id=_source_character_id
    AND i.equipped AND t.item_type='weapon'
    AND ca.custom_script_key='lagrimas_petalas'
  ORDER BY ca.id LIMIT 1 FOR UPDATE OF ca;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied',false); END IF;
  _state:=COALESCE(_ability.custom_state,'{}'::jsonb);
  IF _state->>'florin_battle_id' IS DISTINCT FROM _battle_id::text THEN
    RETURN jsonb_build_object('applied',false);
  END IF;
  _pending:=_state->'florin_pending_bleed';
  IF jsonb_typeof(_pending) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('applied',false);
  END IF;
  IF COALESCE((_state->>'florin_stacks')::integer,0)
     <COALESCE((_state->>'florin_threshold')::integer,1) THEN
    RETURN jsonb_build_object('applied',false);
  END IF;
  SELECT id,name,damage_kind,physical_damage_type_id,damage_type_id,magic_level
  INTO _template FROM public.damage_over_time_templates
  WHERE id='d00bb7ef-65aa-4360-ac0c-e318d0a47080'::uuid
    AND name='Sangramento' AND damage_kind='physical';
  IF NOT FOUND THEN RAISE EXCEPTION 'O Sangramento registrado não foi encontrado'; END IF;
  PERFORM public.apply_ability_dot_effect_internal(_battle_id,_source_character_id,
    'Lágrimas das pétalas',_target_character_id,
    jsonb_build_object('id',_template.id,'template_id',_template.id,
      'name',_template.name,'damage_kind',_template.damage_kind,
      'physical_damage_type_id',_template.physical_damage_type_id,
      'damage_type_id',_template.damage_type_id,'magic_level',_template.magic_level,
      'damage_mode',_pending->>'damage_mode',
      'damage_amount',_pending->'damage_amount',
      'duration',_pending->'duration'),
    '{}'::jsonb,_ability.id);
  -- Consume only the stored DoT payload. Stacks remain under GM control.
  UPDATE public.character_abilities
  SET custom_state=jsonb_set(_state,'{florin_pending_bleed}','null'::jsonb,true)
  WHERE id=_ability.id;
  RETURN jsonb_build_object('applied',true,'damage',_pending->'damage_amount',
    'mode',_pending->>'damage_mode','duration',_pending->'duration');
END;
$fn$;

REVOKE ALL ON FUNCTION public.list_florin_petals_battle(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.control_florin_petals(uuid,uuid,text,integer,text,numeric,integer) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.consume_florin_weapon_bleed(uuid,uuid,uuid,uuid,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.list_florin_petals_battle(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.control_florin_petals(uuid,uuid,text,integer,text,numeric,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consume_florin_weapon_bleed(uuid,uuid,uuid,uuid,numeric) TO authenticated;
