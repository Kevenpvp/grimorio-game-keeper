-- Both accessories and weapons inherit the same inventory/equipment/grant system.
-- Only weapons have a configurable attack profile. They must be equipped by
-- the selected attacker, and all damage bonuses are calculated server-side.
ALTER TABLE public.item_templates DROP CONSTRAINT item_templates_item_type_check;
ALTER TABLE public.item_templates ADD CONSTRAINT item_templates_item_type_check
  CHECK (item_type IN ('accessory','weapon'));

ALTER TABLE public.item_templates
  ADD COLUMN IF NOT EXISTS weapon_damage jsonb NOT NULL DEFAULT
    '{"damage_kind":"physical","bonus_mode":"fixed","bonus_amount":0,"magic_level":"baixa"}'::jsonb;

ALTER TABLE public.item_templates
  ADD CONSTRAINT item_templates_weapon_damage_check
  CHECK (
    jsonb_typeof(weapon_damage)='object'
    AND COALESCE(weapon_damage->>'damage_kind','physical') IN ('physical','magical','hybrid','true')
    AND COALESCE(weapon_damage->>'bonus_mode','fixed') IN ('fixed','percent')
    AND jsonb_typeof(weapon_damage->'bonus_amount')='number'
    AND (weapon_damage->>'bonus_amount')::numeric BETWEEN 0 AND 1000000
    AND (
      COALESCE(weapon_damage->>'bonus_mode','fixed')<>'percent'
      OR (weapon_damage->>'bonus_amount')::numeric<=1000
    )
    AND (
      COALESCE(weapon_damage->>'bonus_mode','fixed')<>'fixed'
      OR (weapon_damage->>'bonus_amount')::numeric = trunc((weapon_damage->>'bonus_amount')::numeric)
    )
    AND COALESCE(weapon_damage->>'magic_level','baixa') IN ('baixa','media','alta')
  );

CREATE OR REPLACE FUNCTION public.prepare_equipped_weapon_damage(
  _inventory_item_id uuid,
  _source_character_id uuid,
  _battle_id uuid,
  _damage_values jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $weapon_definition$
DECLARE
  _weapon record;
  _config jsonb;
  _kind text;
  _mode text;
  _amount numeric;
  _value numeric;
  _adjusted numeric;
  _updated jsonb := '[]'::jsonb;
  _magic_type uuid;
  _physical_type uuid;
  _level text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode aplicar dano com armas';
  END IF;
  IF _source_character_id IS NULL OR _battle_id IS NULL OR _inventory_item_id IS NULL THEN
    RAISE EXCEPTION 'Selecione o atacante, uma arma equipada e uma batalha';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.battles b
    JOIN public.battle_participants bp ON bp.battle_id=b.id
    WHERE b.id=_battle_id AND b.active AND bp.character_id=_source_character_id
  ) THEN
    RAISE EXCEPTION 'O atacante deve participar da batalha ativa';
  END IF;
  SELECT i.id, t.name, t.weapon_damage
  INTO _weapon
  FROM public.character_inventory i
  JOIN public.item_templates t ON t.id=i.item_template_id
  WHERE i.id=_inventory_item_id
    AND i.character_id=_source_character_id
    AND i.equipped=true
    AND t.item_type='weapon';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A arma não está equipada pelo atacante selecionado';
  END IF;

  _config := _weapon.weapon_damage;
  _kind := COALESCE(_config->>'damage_kind','physical');
  _mode := COALESCE(_config->>'bonus_mode','fixed');
  _amount := COALESCE((_config->>'bonus_amount')::numeric,0);
  _level := COALESCE(_config->>'magic_level','baixa');
  IF _kind NOT IN ('physical','magical','hybrid','true')
    OR _mode NOT IN ('fixed','percent')
    OR _amount<0 OR _amount>(CASE WHEN _mode='percent' THEN 1000 ELSE 1000000 END)
    OR (_mode='fixed' AND _amount<>trunc(_amount)) THEN
      RAISE EXCEPTION 'Configuração de dano da arma inválida';
  END IF;
  IF _level NOT IN ('baixa','media','alta') THEN
    RAISE EXCEPTION 'Grau de magia da arma inválido';
  END IF;
  IF jsonb_typeof(_damage_values)<>'array'
    OR jsonb_array_length(_damage_values) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Informe de 1 a 200 golpes válidos';
  END IF;
  FOR _value IN
    SELECT (element.value #>> '{}')::numeric
    FROM jsonb_array_elements(_damage_values) AS element(value)
  LOOP
    IF _value<0 OR _value>1000000 THEN
      RAISE EXCEPTION 'Dano bruto fora de 0 a 1.000.000';
    END IF;
    _adjusted := floor(_value+CASE WHEN _mode='percent'
      THEN _value*_amount/100 ELSE _amount END);
    IF _adjusted>1000000 THEN
      RAISE EXCEPTION 'O bônus da arma ultrapassou 1.000.000 de dano por golpe';
    END IF;
    _updated := _updated || to_jsonb(_adjusted::integer);
  END LOOP;

  IF _kind IN ('magical','hybrid') THEN
    _magic_type := NULLIF(_config->>'damage_type_id','')::uuid;
    IF _magic_type IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.damage_types dt
      WHERE dt.id=_magic_type AND dt.category='magical'
    ) THEN RAISE EXCEPTION 'Selecione um tipo de dano mágico válido na configuração da arma'; END IF;
  END IF;
  IF _kind IN ('physical','hybrid') THEN
    _physical_type := NULLIF(_config->>'physical_damage_type_id','')::uuid;
    IF _physical_type IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.damage_types dt
      WHERE dt.id=_physical_type AND dt.category='physical'
    ) THEN RAISE EXCEPTION 'Tipo de dano físico inválido na arma'; END IF;
  END IF;
  RETURN jsonb_build_object(
    'weapon_name',_weapon.name,
    'damage_kind',_kind,
    'damage_type_id',_magic_type,
    'physical_damage_type_id',_physical_type,
    'magic_level',CASE WHEN _kind IN ('magical','hybrid') THEN _level ELSE NULL END,
    'damage_values',_updated,
    'bonus_mode',_mode,
    'bonus_amount',_amount
  );
END;
$weapon_definition$;

REVOKE ALL ON FUNCTION public.prepare_equipped_weapon_damage(uuid,uuid,uuid,jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prepare_equipped_weapon_damage(uuid,uuid,uuid,jsonb)
  TO authenticated;
