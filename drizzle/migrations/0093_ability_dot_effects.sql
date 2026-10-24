-- Add guaranteed and hit-gated damage-over-time (DoT) effects to abilities.
ALTER TABLE public.abilities
  ADD COLUMN IF NOT EXISTS dot_effects jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.abilities DROP CONSTRAINT IF EXISTS abilities_dot_effects_array_check;
ALTER TABLE public.abilities ADD CONSTRAINT abilities_dot_effects_array_check
  CHECK (jsonb_typeof(dot_effects) = 'array');


CREATE OR REPLACE FUNCTION public.apply_ability_dot_effect_internal(
  _battle_id uuid,
  _caster_character_id uuid,
  _ability_name text,
  _target_character_id uuid,
  _dot jsonb,
  _attribute_values jsonb
)
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
$function$;

CREATE OR REPLACE FUNCTION public.apply_character_ability_dots(
  _character_ability_id uuid,
  _battle_id uuid,
  _target_selections jsonb,
  _attribute_values jsonb DEFAULT '{}'::jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _caster_id uuid;
  _ability_id uuid;
  _ability_name text;
  _guaranteed_dots jsonb;
  _attack_groups jsonb;
  _attack_enabled boolean;
  _selection jsonb;
  _target_id uuid;
  _hit boolean;
  _group_id text;
  _group jsonb;
  _dot jsonb;
  _dot_count integer := 0;
  _seen_targets uuid[] := ARRAY[]::uuid[];
  _group_ids jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode aplicar DoTs por habilidades';
  END IF;

  IF _target_selections IS NULL THEN
    RETURN 0;
  END IF;
  IF jsonb_typeof(_target_selections) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'A lista de alvos dos DoTs é inválida';
  END IF;
  IF jsonb_array_length(_target_selections) = 0 THEN
    RETURN 0;
  END IF;
  IF jsonb_array_length(_target_selections) > 100 THEN
    RAISE EXCEPTION 'Uma habilidade pode aplicar DoT a no máximo 100 alvos';
  END IF;
  IF _battle_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.battles b WHERE b.id = _battle_id AND b.active IS TRUE
  ) THEN
    RAISE EXCEPTION 'DoTs de habilidades só podem ser aplicados em uma batalha ativa';
  END IF;
  IF jsonb_typeof(COALESCE(_attribute_values, '{}'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Os valores de atributos para os DoTs são inválidos';
  END IF;

  SELECT ca.character_id, ca.ability_id, a.name,
         COALESCE(a.dot_effects, '[]'::jsonb),
         COALESCE(a.attack_effect_groups, '[]'::jsonb),
         COALESCE(a.attack_enabled, false)
  INTO _caster_id, _ability_id, _ability_name, _guaranteed_dots, _attack_groups, _attack_enabled
  FROM public.character_abilities ca
  JOIN public.abilities a ON a.id = ca.ability_id
  WHERE ca.id = _character_ability_id
  FOR UPDATE OF ca;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'A habilidade não está atribuída a uma ficha';
  END IF;
  IF jsonb_typeof(_guaranteed_dots) IS DISTINCT FROM 'array'
     OR jsonb_typeof(_attack_groups) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'A configuração de DoTs da habilidade está inválida';
  END IF;

  FOR _selection IN
    SELECT value FROM jsonb_array_elements(_target_selections) AS selections(value)
  LOOP
    IF jsonb_typeof(_selection) IS DISTINCT FROM 'object'
       OR COALESCE(_selection->>'target_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Um alvo dos DoTs é inválido';
    END IF;

    _target_id := (_selection->>'target_id')::uuid;
    IF _target_id = ANY(_seen_targets) THEN
      RAISE EXCEPTION 'A lista de alvos dos DoTs não pode conter duplicatas';
    END IF;
    _seen_targets := array_append(_seen_targets, _target_id);
    IF NOT EXISTS (
      SELECT 1 FROM public.battle_participants bp
      WHERE bp.battle_id = _battle_id AND bp.character_id = _target_id
    ) THEN
      RAISE EXCEPTION 'Todos os alvos dos DoTs precisam participar da batalha ativa';
    END IF;

    IF COALESCE(_selection->>'hit', 'false') NOT IN ('true', 'false') THEN
      RAISE EXCEPTION 'Estado de acerto de DoT inválido';
    END IF;
    _hit := COALESCE((_selection->>'hit')::boolean, false);
    _group_ids := COALESCE(_selection->'group_ids', '[]'::jsonb);
    IF jsonb_typeof(_group_ids) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'As categorias selecionadas para os DoTs precisam ser uma lista';
    END IF;
    IF NOT _hit AND jsonb_array_length(_group_ids) > 0 THEN
      RAISE EXCEPTION 'Não é possível aplicar DoTs de uma categoria que não acertou';
    END IF;

    -- These DoTs are configured outside the attack categories and therefore hit
    -- every selected target, even when that target dodges the attack itself.
    FOR _dot IN
      SELECT value FROM jsonb_array_elements(_guaranteed_dots) AS configured(value)
    LOOP
      PERFORM public.apply_ability_dot_effect_internal(
        _battle_id, _caster_id, _ability_name, _target_id, _dot, COALESCE(_attribute_values, '{}'::jsonb)
      );
      _dot_count := _dot_count + 1;
    END LOOP;

    -- DoTs inside an attack chance group are applied only when that target is
    -- marked as hit and that category is explicitly checked by the master.
    IF _hit AND jsonb_array_length(_group_ids) > 0 THEN
      IF NOT _attack_enabled THEN
        RAISE EXCEPTION 'Esta habilidade não está configurada para Atacar';
      END IF;
      FOR _group_id IN
        SELECT DISTINCT value FROM jsonb_array_elements_text(_group_ids) AS selected(value)
      LOOP
        SELECT item.value INTO _group
        FROM jsonb_array_elements(_attack_groups) AS item(value)
        WHERE item.value->>'id' = _group_id
        LIMIT 1;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Uma categoria selecionada não pertence a esta habilidade';
        END IF;
        IF jsonb_typeof(COALESCE(_group->'dots', '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'A lista de DoTs da categoria de ataque está inválida';
        END IF;
        FOR _dot IN
          SELECT value FROM jsonb_array_elements(COALESCE(_group->'dots', '[]'::jsonb)) AS configured(value)
        LOOP
          PERFORM public.apply_ability_dot_effect_internal(
            _battle_id, _caster_id, _ability_name, _target_id, _dot, COALESCE(_attribute_values, '{}'::jsonb)
          );
          _dot_count := _dot_count + 1;
        END LOOP;
      END LOOP;
    END IF;
  END LOOP;

  RETURN _dot_count;
END;
$function$;



-- Final activation functions are installed after the schema migration from the source project's live definitions.
