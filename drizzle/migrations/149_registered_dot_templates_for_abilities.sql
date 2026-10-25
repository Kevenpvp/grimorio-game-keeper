BEGIN;
CREATE OR REPLACE FUNCTION public.resolve_registered_ability_dot(_dot jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public' AS $function$
DECLARE
  _record public.damage_over_time_templates%ROWTYPE;
  _reference text;
BEGIN
  IF jsonb_typeof(_dot) <> 'object' THEN
    RAISE EXCEPTION 'Configuração de DoT inválida';
  END IF;
  _reference := NULLIF(BTRIM(_dot->>'template_id'),'');
  -- Existing DoTs without a reference remain readable until they are edited.
  IF _reference IS NULL THEN RETURN _dot; END IF;
  IF _reference !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Referência do DoT registrado é inválida';
  END IF;
  SELECT * INTO _record FROM public.damage_over_time_templates
  WHERE id=_reference::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'O DoT cadastrado foi removido. Selecione outro modelo na habilidade.';
  END IF;
  RETURN _dot || jsonb_build_object(
    'name',_record.name,
    'damage_kind',_record.damage_kind,
    'physical_damage_type_id',_record.physical_damage_type_id,
    'damage_type_id',_record.damage_type_id,
    'magic_level',_record.magic_level
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.resolve_registered_ability_dot(jsonb) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.apply_ability_dot_effect_internal(_battle_id uuid, _caster_character_id uuid, _ability_name text, _target_character_id uuid, _dot jsonb, _attribute_values jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _dot_id text;
  _dot_name text;
  _damage_kind text;
  _configured_mode text;
  _stored_mode text;
  _damage_amount numeric;
  _attribute_key text;
  _attribute_percent numeric;
  _fixed_damage numeric;
  _attribute_value numeric;
  _duration integer;
  _physical_type_id uuid;
  _magic_type_id uuid;
  _magic_level text;
BEGIN
  IF jsonb_typeof(_dot) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Configuração de DoT inválida';
  END IF;

  _dot := public.resolve_registered_ability_dot(_dot);
  _dot_id := COALESCE(NULLIF(btrim(_dot->>'id'), ''), 'dot');
  _dot_name := NULLIF(btrim(_dot->>'name'), '');
  _damage_kind := _dot->>'damage_kind';
  _configured_mode := COALESCE(NULLIF(_dot->>'damage_mode', ''), 'fixed');
  _attribute_key := NULLIF(_dot->>'attribute_key', '');
  _magic_level := NULLIF(_dot->>'magic_level', '');

  IF _dot_name IS NULL OR length(_dot_name) > 120 THEN
    RAISE EXCEPTION 'O DoT precisa de um nome de até 120 caracteres';
  END IF;
  IF _damage_kind NOT IN ('physical', 'magical') THEN
    RAISE EXCEPTION 'Categoria de dano do DoT inválida';
  END IF;
  IF _configured_mode NOT IN ('fixed', 'percent', 'attribute') THEN
    RAISE EXCEPTION 'Modo de cálculo do DoT inválido';
  END IF;
  IF COALESCE(_dot->>'duration', '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'A duração do DoT precisa ser um número inteiro';
  END IF;
  _duration := (_dot->>'duration')::integer;
  IF _duration < 1 OR _duration > 1000 THEN
    RAISE EXCEPTION 'A duração do DoT precisa ficar entre 1 e 1000 turnos';
  END IF;

  IF _damage_kind = 'physical' THEN
    IF COALESCE(_dot->>'physical_damage_type_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Selecione um tipo de dano físico para o DoT';
    END IF;
    _physical_type_id := (_dot->>'physical_damage_type_id')::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM public.damage_types dt
      WHERE dt.id = _physical_type_id AND dt.category = 'physical'
    ) THEN
      RAISE EXCEPTION 'O tipo de dano físico do DoT é inválido';
    END IF;
    _magic_type_id := NULL;
    _magic_level := NULL;
  ELSE
    IF COALESCE(_dot->>'damage_type_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR _magic_level NOT IN ('baixa', 'media', 'alta') THEN
      RAISE EXCEPTION 'Selecione um tipo e um grau de dano mágico para o DoT';
    END IF;
    _magic_type_id := (_dot->>'damage_type_id')::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM public.damage_types dt
      WHERE dt.id = _magic_type_id AND dt.category = 'magical'
    ) THEN
      RAISE EXCEPTION 'O tipo de dano mágico do DoT é inválido';
    END IF;
    _physical_type_id := NULL;
  END IF;

  IF _configured_mode IN ('fixed', 'percent') THEN
    IF COALESCE(_dot->>'damage_amount', '') !~ '^[0-9]+([.][0-9]+)?$' THEN
      RAISE EXCEPTION 'O valor do dano por turno precisa ser numérico';
    END IF;
    _damage_amount := (_dot->>'damage_amount')::numeric;
    IF _configured_mode = 'fixed' THEN
      IF _damage_amount < 1 OR _damage_amount > 1000000 OR _damage_amount <> floor(_damage_amount) THEN
        RAISE EXCEPTION 'O dano fixo do DoT precisa ser um inteiro entre 1 e 1000000';
      END IF;
    ELSIF _damage_amount <= 0 OR _damage_amount > 1000 THEN
      RAISE EXCEPTION 'O percentual do DoT precisa ficar entre 0 e 1000';
    END IF;
    _stored_mode := _configured_mode;
  ELSE
    IF _attribute_key IS NULL
       OR _attribute_key IN ('hp', 'mana')
       OR NOT EXISTS (SELECT 1 FROM public.attribute_definitions ad WHERE ad.key = _attribute_key) THEN
      RAISE EXCEPTION 'Selecione um atributo válido do lançador para o DoT';
    END IF;
    IF COALESCE(_dot->>'attribute_percent', '') !~ '^[0-9]+([.][0-9]+)?$'
       OR COALESCE(_dot->>'fixed_damage', '') !~ '^[0-9]+([.][0-9]+)?$' THEN
      RAISE EXCEPTION 'Percentual do atributo e dano fixo adicional precisam ser numéricos';
    END IF;
    _attribute_percent := (_dot->>'attribute_percent')::numeric;
    _fixed_damage := (_dot->>'fixed_damage')::numeric;
    IF _attribute_percent < 0 OR _attribute_percent > 1000
       OR _fixed_damage < 0 OR _fixed_damage > 1000000 THEN
      RAISE EXCEPTION 'Percentual ou dano fixo adicional do DoT fora dos limites';
    END IF;
    IF jsonb_typeof(_attribute_values) IS DISTINCT FROM 'object'
       OR COALESCE(_attribute_values->>_dot_id, '') !~ '^[0-9]+([.][0-9]+)?$' THEN
      RAISE EXCEPTION 'Não foi possível ler o atributo escolhido para o DoT';
    END IF;
    _attribute_value := (_attribute_values->>_dot_id)::numeric;
    IF _attribute_value < 0 OR _attribute_value > 1000000 THEN
      RAISE EXCEPTION 'Valor do atributo para o DoT fora dos limites';
    END IF;
    -- Attribute-based DoTs snapshot the effective caster stat at cast time.
    -- The ordinary DoT turn processor then ticks this stored fixed value.
    _damage_amount := round((_attribute_value * _attribute_percent / 100) + _fixed_damage);
    IF _damage_amount < 1 OR _damage_amount > 1000000 THEN
      RAISE EXCEPTION 'O cálculo do DoT por atributo precisa resultar em pelo menos 1 e no máximo 1000000 de dano';
    END IF;
    _stored_mode := 'fixed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.battle_participants bp
    WHERE bp.battle_id = _battle_id AND bp.character_id = _target_character_id
  ) THEN
    RAISE EXCEPTION 'O alvo do DoT não participa desta batalha';
  END IF;

  INSERT INTO public.battle_effects (
    battle_id, character_id, target_character_id, name, effect_type, attribute_key,
    polarity, value_mode, amount, duration, duration_scope, until_combat_end,
    damage_scope, effect_data, source_character_ability_id, effect_group_id, is_end_effect
  ) VALUES (
    _battle_id,
    _target_character_id,
    _target_character_id,
    COALESCE(NULLIF(btrim(_ability_name), ''), 'Habilidade') || ': DoT — ' || _dot_name,
    'damage_over_time',
    NULL,
    'debuff',
    CASE WHEN _stored_mode = 'percent' THEN 'percent' ELSE 'fixed' END,
    _damage_amount,
    _duration,
    'individual',
    false,
    _damage_kind,
    jsonb_build_object(
      'is_damage_over_time', true,
      'dot_template_id', _dot_id,
      'dot_template_name', _dot_name,
      'damage_kind', _damage_kind,
      'physical_damage_type_id', _physical_type_id,
      'damage_type_id', _magic_type_id,
      'magic_level', _magic_level,
      'damage_mode', _stored_mode,
      'damage_amount', _damage_amount,
      'source_character_id', _caster_character_id::text,
      'source_ability_name', COALESCE(NULLIF(btrim(_ability_name), ''), 'Habilidade'),
      'configured_damage_mode', _configured_mode,
      'attribute_key', _attribute_key,
      'attribute_percent', _attribute_percent,
      'attribute_value_snapshot', _attribute_value,
      'fixed_damage', _fixed_damage
    ),
    NULL,
    gen_random_uuid(),
    false
  );
END;
$function$
;
NOTIFY pgrst,'reload schema';
COMMIT;