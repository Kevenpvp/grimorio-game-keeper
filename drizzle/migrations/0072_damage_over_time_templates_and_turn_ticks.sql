-- Saved DoT templates used by the master when applying a damage-over-time effect.
CREATE TABLE public.damage_over_time_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  damage_kind text NOT NULL CHECK (damage_kind IN ('physical','magical')),
  physical_damage_type_id uuid REFERENCES public.damage_types(id) ON DELETE CASCADE,
  damage_type_id uuid REFERENCES public.damage_types(id) ON DELETE CASCADE,
  magic_level text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT damage_over_time_templates_type_check CHECK (
    (damage_kind='physical' AND physical_damage_type_id IS NOT NULL AND damage_type_id IS NULL AND magic_level IS NULL)
    OR
    (damage_kind='magical' AND physical_damage_type_id IS NULL AND damage_type_id IS NOT NULL AND magic_level IN ('baixa','media','alta'))
  )
);
CREATE UNIQUE INDEX damage_over_time_templates_name_ci_idx ON public.damage_over_time_templates (lower(name));
CREATE INDEX damage_over_time_templates_kind_idx ON public.damage_over_time_templates (damage_kind,name);

ALTER TABLE public.damage_over_time_templates ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.damage_over_time_templates TO authenticated;
GRANT ALL ON public.damage_over_time_templates TO service_role;

CREATE POLICY "read damage over time templates"
  ON public.damage_over_time_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "master manages damage over time templates"
  ON public.damage_over_time_templates FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'master'))
  WITH CHECK (public.has_role(auth.uid(),'master'));

CREATE OR REPLACE FUNCTION public.validate_damage_over_time_template()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.damage_kind='physical' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.damage_types dt
      WHERE dt.id=NEW.physical_damage_type_id AND dt.category='physical'
    ) THEN
      RAISE EXCEPTION 'Selecione um tipo de dano físico válido para este DoT';
    END IF;
    NEW.damage_type_id := NULL;
    NEW.magic_level := NULL;
  ELSIF NEW.damage_kind='magical' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.damage_types dt
      WHERE dt.id=NEW.damage_type_id AND dt.category='magical'
    ) THEN
      RAISE EXCEPTION 'Selecione um tipo de dano mágico válido para este DoT';
    END IF;
    IF NEW.magic_level NOT IN ('baixa','media','alta') THEN
      RAISE EXCEPTION 'Selecione o grau da magia: baixa, média ou alta';
    END IF;
    NEW.physical_damage_type_id := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER damage_over_time_templates_validate
  BEFORE INSERT OR UPDATE ON public.damage_over_time_templates
  FOR EACH ROW EXECUTE FUNCTION public.validate_damage_over_time_template();

ALTER TABLE public.battle_effects
  DROP CONSTRAINT battle_effects_effect_type_check;
ALTER TABLE public.battle_effects
  ADD CONSTRAINT battle_effects_effect_type_check
  CHECK (effect_type = ANY (ARRAY['status'::text, 'regeneration'::text, 'no_regen_hp'::text, 'no_regen_mana'::text, 'stun'::text, 'mana_used'::text, 'magic_prohibition'::text, 'damage_dealt'::text, 'no_mana'::text, 'damage_reduction'::text, 'healing'::text, 'invincible'::text, 'healing_blocked'::text, 'damage_received'::text, 'damage_vulnerability'::text, 'damage_over_time'::text]));

ALTER TABLE public.battle_effects
  DROP CONSTRAINT battle_effects_check;
ALTER TABLE public.battle_effects
  ADD CONSTRAINT battle_effects_check (((((effect_type = 'status'::text) OR (effect_type = 'damage_vulnerability'::text)) AND (attribute_key IS NOT NULL)) OR ((effect_type = 'regeneration'::text) AND (attribute_key = ANY (ARRAY['hp'::text, 'mana'::text]))) OR (effect_type = ANY (ARRAY['no_regen_hp'::text, 'no_regen_mana'::text, 'stun'::text, 'mana_used'::text])) OR ((effect_type = 'magic_prohibition'::text) AND (attribute_key IS NULL) AND (polarity = 'debuff'::text)) OR ((effect_type = 'damage_dealt'::text) AND (attribute_key IS NULL)) OR ((effect_type = 'no_mana'::text) AND (attribute_key IS NULL) AND (polarity = 'debuff'::text)) OR (effect_type = ANY (ARRAY['invincible'::text, 'healing_blocked'::text])) OR ((effect_type = 'damage_reduction'::text) AND (attribute_key IS NULL) AND (polarity = 'buff'::text) AND (value_mode = ANY (ARRAY['fixed'::text, 'percent'::text])) AND (((damage_reduction_scope = 'physical'::text) AND (damage_reduction_type_id IS NULL) AND (damage_reduction_magic_level IS NULL) AND (damage_reduction_magic_levels IS NULL) AND ((damage_reduction_type_ids IS NULL) OR (array_position(damage_reduction_type_ids, NULL::uuid) IS NULL))) OR ((damage_reduction_scope = 'magical'::text) AND (((damage_reduction_type_ids IS NULL) AND (damage_reduction_magic_levels IS NULL) AND (damage_reduction_type_id IS NOT NULL) AND (damage_reduction_magic_level IS NOT NULL) AND (damage_reduction_magic_level = ANY (ARRAY['baixa'::text, 'media'::text, 'alta'::text]))) OR ((damage_reduction_type_ids IS NOT NULL) AND (damage_reduction_magic_levels IS NOT NULL) AND (damage_reduction_type_id IS NULL) AND (damage_reduction_magic_level IS NULL) AND (array_position(damage_reduction_type_ids, NULL::uuid) IS NULL) AND (array_position(damage_reduction_magic_levels, NULL::text) IS NULL) AND ((cardinality(damage_reduction_magic_levels) = 0) OR (damage_reduction_magic_levels <@ ARRAY['baixa'::text, 'media'::text, 'alta'::text]))))))) OR ((effect_type = 'healing'::text) AND (attribute_key IS NULL) AND (polarity = 'buff'::text) AND (value_mode = 'fixed'::text) AND (amount = (0)::numeric)) OR ((effect_type = 'damage_received'::text) AND (attribute_key IS NULL) AND (polarity = 'debuff'::text) AND (value_mode = ANY (ARRAY['fixed'::text, 'percent'::text]))) OR ((effect_type = 'damage_over_time'::text) AND (attribute_key IS NULL) AND (polarity = 'debuff'::text) AND (value_mode = ANY (ARRAY['fixed'::text, 'percent'::text])))));

-- DoTs tick inside the same transaction as turn advancement. The configured
-- damage kind and type go through the regular damage calculation for each tick.
CREATE OR REPLACE FUNCTION public.advance_combat_turn(_battle_id uuid, _character_id uuid DEFAULT NULL::uuid, _mana_regeneration_settings jsonb DEFAULT '{}'::jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _active boolean;
  _global_turn integer;
  _result_turn integer;
  _fighter record;
  _fighter_id uuid;
  _base_regen numeric;
  _mana_current numeric;
  _mana_max numeric;
  _fixed_regen numeric;
  _percent_regen numeric;
  _adjusted_regen numeric;
  _regen_blocked boolean;
  _expired_ids uuid[] := ARRAY[]::uuid[];
  _expired record;
  _periodic record;
  _dot record;
  _dot_script record;
  _dot_result jsonb;
  _dot_hits jsonb := '[]'::jsonb;
  _dot_data jsonb;
  _dot_kind text;
  _dot_mode text;
  _dot_amount numeric;
  _dot_raw_damage numeric;
  _dot_hp_max numeric;
  _dot_physical_type_id uuid;
  _dot_magic_type_id uuid;
  _dot_magic_level text;
  _dot_source_id uuid;
  _dot_total integer;
  _dot_potential_total integer;
  _dot_final_values jsonb;
  _dot_potential_values jsonb;
  _dot_invincible boolean;
  _dot_hp_before integer;
  _dot_hp_after integer;
begin
  if auth.uid() is null or not public.has_role(auth.uid(), 'master') then
    raise exception 'Apenas o mestre pode avançar turnos';
  end if;
  if jsonb_typeof(coalesce(_mana_regeneration_settings, '{}'::jsonb)) <> 'object' then
    raise exception 'Configuração de regeneração de Mana inválida';
  end if;

  select b.active, b.turn_count
  into _active, _global_turn
  from public.battles b
  where b.id = _battle_id
  for update;
  if not found then raise exception 'Batalha não encontrada'; end if;
  if not _active then raise exception 'Esta batalha já está encerrada'; end if;

  if _character_id is not null then
    update public.battle_participants bp
    set turn_count = coalesce(bp.turn_count, 0) + 1
    where bp.battle_id = _battle_id and bp.character_id = _character_id
    returning bp.turn_count into _result_turn;
    if not found then raise exception 'Personagem não encontrado nesta batalha'; end if;
  else
    update public.battles
    set turn_count = coalesce(turn_count, 0) + 1
    where id = _battle_id
    returning turn_count into _result_turn;

    update public.battle_participants bp
    set turn_count = coalesce(bp.turn_count, 0) + 1
    where bp.battle_id = _battle_id;
  end if;

  -- Apply the configured base regeneration using current database modifiers before ticking durations.
  for _fighter in select key, value from jsonb_each(coalesce(_mana_regeneration_settings, '{}'::jsonb))
  loop
    _fighter_id := _fighter.key::uuid;
    if jsonb_typeof(_fighter.value) <> 'object'
       or coalesce(_fighter.value ->> 'mode', '') not in ('percent', 'fixed') then
      raise exception 'Configuração de regeneração inválida para %', _fighter_id;
    end if;
    _base_regen := nullif(_fighter.value ->> 'amount', '')::numeric;
    if _base_regen is null or _base_regen < 0 then
      raise exception 'Regeneração inválida para %', _fighter_id;
    end if;
    if (_character_id is not null and _fighter_id <> _character_id)
       or not exists (
         select 1 from public.battle_participants bp
         where bp.battle_id = _battle_id and bp.character_id = _fighter_id
       ) then
      raise exception 'Regeneração informada para um personagem que não pertence à ação de turno';
    end if;

    select ca.current_value
    into _mana_current
    from public.character_attributes ca
    where ca.character_id = _fighter_id and ca.attribute_key = 'mana'
    for update;
    if not found then raise exception 'Esta ficha não possui o atributo Mana'; end if;

    _mana_max := public.calculate_character_resource_max(_fighter_id, 'mana');
    if _fighter.value ->> 'mode' = 'percent' then
      _base_regen := ceil(_mana_max * _base_regen / 100);
    else
      _base_regen := floor(_base_regen);
    end if;

    select
      coalesce(sum(case when modifiers.polarity = 'buff' then modifiers.amount else -modifiers.amount end)
        filter (where modifiers.value_mode = 'fixed'), 0),
      coalesce(sum(case when modifiers.polarity = 'buff' then modifiers.amount else -modifiers.amount end)
        filter (where modifiers.value_mode = 'percent'), 0)
    into _fixed_regen, _percent_regen
    from (
      select e.polarity, e.value_mode, e.amount
      from public.battle_effects e
      where e.character_id = _fighter_id
        and e.effect_type = 'regeneration'
        and e.attribute_key = 'mana'
        and e.duration > 0
        and (e.battle_id is null or e.battle_id = _battle_id)

      union all

      select
        coalesce(passive.effect ->> 'polarity', 'buff'),
        coalesce(passive.effect ->> 'value_mode', 'fixed'),
        coalesce(nullif(passive.effect ->> 'amount', '')::numeric, 0)
      from public.character_abilities ca
      cross join lateral jsonb_array_elements(coalesce(ca.passive_effects, '[]'::jsonb)) as passive(effect)
      where ca.character_id = _fighter_id
        and (
          (passive.effect ->> 'effect_type' = 'regeneration' and passive.effect ->> 'attribute_key' = 'mana')
          or passive.effect ->> 'effect_type' = 'mana_regeneration'
        )
    ) as modifiers;

    select
      exists (
        select 1 from public.battle_effects e
        where e.character_id = _fighter_id
          and e.effect_type = 'no_regen_mana'
          and e.duration > 0
          and (e.battle_id is null or e.battle_id = _battle_id)
      )
      or exists (
        select 1
        from public.character_abilities ca
        cross join lateral jsonb_array_elements(coalesce(ca.passive_effects, '[]'::jsonb)) as passive(effect)
        where ca.character_id = _fighter_id and passive.effect ->> 'effect_type' = 'no_regen_mana'
      )
    into _regen_blocked;

    if not _regen_blocked then
      _adjusted_regen := greatest(0, floor(_base_regen * (1 + coalesce(_percent_regen, 0) / 100) + coalesce(_fixed_regen, 0)));
      update public.character_attributes
      set current_value = least(_mana_max, greatest(0, coalesce(current_value, 0) + _adjusted_regen))::integer,
          updated_at = now()
      where character_id = _fighter_id and attribute_key = 'mana';
    end if;
  end loop;

  -- Periodic healing ticks once for every turn advancement, before effects at duration 1 expire.
  for _periodic in
    select e.character_id, e.effect_data
    from public.battle_effects e
    where e.effect_type = 'healing'
      and e.effect_data->>'healing_timing' = 'per_turn'
      and e.duration > 0
      and (
      (_character_id is not null and e.character_id = _character_id
        and (e.battle_id = _battle_id or e.battle_id is null))
      or
      (_character_id is null and (
        e.battle_id = _battle_id
        or (e.battle_id is null and exists (
          select 1 from public.battle_participants bp
          where bp.battle_id = _battle_id and bp.character_id = e.character_id
        ))
      ))
    )
    order by e.created_at, e.id
    for update of e
  loop
    perform public.apply_ability_healing(_periodic.character_id, _battle_id, _periodic.effect_data, true, false);
  end loop;

  -- Tick DoTs before duration decrement. Individual turns tick the current target;
  -- a global turn ticks each participant's active DoTs.
  FOR _dot IN
    SELECT e.id, e.character_id, e.name, e.effect_data
    FROM public.battle_effects e
    WHERE e.effect_type = 'damage_over_time'
      AND e.duration > 0
      AND NOT e.until_combat_end
      AND e.source_race_id IS NULL
      AND (
        (_character_id IS NOT NULL AND e.character_id = _character_id
          AND (e.battle_id = _battle_id OR e.battle_id IS NULL))
        OR
        (_character_id IS NULL AND (
          e.battle_id = _battle_id
          OR (e.battle_id IS NULL AND EXISTS (
            SELECT 1 FROM public.battle_participants bp
            WHERE bp.battle_id = _battle_id AND bp.character_id = e.character_id
          ))
        ))
      )
    ORDER BY e.created_at, e.id
    FOR UPDATE OF e
  LOOP
    _dot_data := COALESCE(_dot.effect_data, '{}'::jsonb);
    _dot_kind := COALESCE(_dot_data->>'damage_kind', '');
    _dot_mode := COALESCE(_dot_data->>'damage_mode', '');
    _dot_amount := CASE
      WHEN COALESCE(_dot_data->>'damage_amount', '') ~ '^[0-9]+([.][0-9]+)?$'
        THEN (_dot_data->>'damage_amount')::numeric
      ELSE 0
    END;

    IF _dot_kind NOT IN ('physical','magical')
       OR _dot_mode NOT IN ('fixed','percent')
       OR _dot_amount <= 0 THEN
      CONTINUE;
    END IF;

    _dot_physical_type_id := NULL;
    _dot_magic_type_id := NULL;
    _dot_magic_level := NULL;
    _dot_source_id := NULL;

    IF _dot_kind = 'physical' THEN
      IF COALESCE(_dot_data->>'physical_damage_type_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        CONTINUE;
      END IF;
      _dot_physical_type_id := (_dot_data->>'physical_damage_type_id')::uuid;
      IF NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id = _dot_physical_type_id AND dt.category = 'physical') THEN
        CONTINUE;
      END IF;
    ELSE
      IF COALESCE(_dot_data->>'damage_type_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR COALESCE(_dot_data->>'magic_level','') NOT IN ('baixa','media','alta') THEN
        CONTINUE;
      END IF;
      _dot_magic_type_id := (_dot_data->>'damage_type_id')::uuid;
      _dot_magic_level := _dot_data->>'magic_level';
      IF NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id = _dot_magic_type_id AND dt.category = 'magical') THEN
        CONTINUE;
      END IF;
    END IF;

    IF COALESCE(_dot_data->>'source_character_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      _dot_source_id := (_dot_data->>'source_character_id')::uuid;
      IF _dot_source_id = _dot.character_id
         OR NOT EXISTS (SELECT 1 FROM public.battle_participants bp WHERE bp.battle_id = _battle_id AND bp.character_id = _dot_source_id) THEN
        _dot_source_id := NULL;
      END IF;
    END IF;

    IF _dot_mode = 'percent' THEN
      _dot_hp_max := public.calculate_character_resource_max(_dot.character_id, 'hp');
      _dot_raw_damage := CEIL(GREATEST(0, COALESCE(_dot_hp_max, 0)) * _dot_amount / 100);
    ELSE
      _dot_raw_damage := FLOOR(_dot_amount);
    END IF;
    _dot_raw_damage := LEAST(1000000, GREATEST(0, COALESCE(_dot_raw_damage, 0)));
    IF _dot_raw_damage <= 0 THEN CONTINUE; END IF;

    _dot_result := public.apply_battle_damage(
      _battle_id, _dot.character_id, _dot_kind, _dot_magic_type_id,
      jsonb_build_array(_dot_raw_damage), _dot_magic_level, _dot_source_id, _dot_physical_type_id
    );

    _dot_total := COALESCE(NULLIF(_dot_result->>'total_damage','')::integer, 0);
    _dot_hp_before := COALESCE(NULLIF(_dot_result->>'hp_before','')::integer, 0);
    _dot_hp_after := COALESCE(NULLIF(_dot_result->>'hp_after','')::integer, 0);
    _dot_invincible := COALESCE(NULLIF(_dot_result->>'is_invincible','')::boolean, false);
    _dot_final_values := COALESCE(_dot_result->'final_damage_by_hit', '[]'::jsonb);
    _dot_potential_values := COALESCE(_dot_result->'damage_without_invincible_by_hit', _dot_final_values);

    SELECT COALESCE(SUM((entry.value #>> '{}')::integer), 0)::integer
    INTO _dot_potential_total
    FROM jsonb_array_elements(_dot_potential_values) AS entry(value);

    _dot_hits := _dot_hits || jsonb_build_array(jsonb_build_object(
      'effect_id', _dot.id, 'character_id', _dot.character_id,
      'source_character_id', _dot_source_id, 'damage_kind', _dot_kind,
      'physical_damage_type_id', _dot_physical_type_id, 'damage_type_id', _dot_magic_type_id,
      'magic_level', _dot_magic_level, 'raw_damage', _dot_raw_damage, 'total_damage', _dot_total,
      'potential_total', _dot_potential_total, 'final_damage_by_hit', _dot_final_values,
      'potential_damage_by_hit', _dot_potential_values, 'is_invincible', _dot_invincible,
      'hp_before', _dot_hp_before, 'hp_after', _dot_hp_after
    ));

    -- Trigger vulnerability effects now; newly applied effects are excluded from this tick's duration decrement.
    IF _dot_total > 0 THEN
      PERFORM public.trigger_damage_vulnerability_effects(
        _battle_id, _dot.character_id, _dot_kind, _dot_physical_type_id,
        _dot_magic_type_id, _dot_magic_level, _dot_total
      );
    END IF;
  END LOOP;

  if _character_id is not null then
    update public.character_abilities ca
    set cooldown_remaining = greatest(0, ca.cooldown_remaining - 1)
    where ca.character_id = _character_id and ca.can_activate and ca.cooldown_remaining > 0;
  else
    update public.character_abilities ca
    set cooldown_remaining = greatest(0, ca.cooldown_remaining - 1)
    where ca.can_activate and ca.cooldown_remaining > 0
      and exists (
        select 1 from public.battle_participants bp
        where bp.battle_id = _battle_id and bp.character_id = ca.character_id
      );
  end if;

  -- Snapshot effects that were already at 1 BEFORE ticking. This preserves the
  -- database CHECK constraint (duration must stay >= 1) and prevents effects that
  -- change from 2 -> 1 in this same turn from being removed prematurely.
  select coalesce(array_agg(e.id order by e.created_at, e.id), ARRAY[]::uuid[])
  into _expired_ids
  from public.battle_effects e
  where e.duration = 1
    AND e.created_at < transaction_timestamp()
    AND NOT e.until_combat_end
    AND e.source_race_id IS NULL
    and (
      (_character_id is not null and e.character_id = _character_id
        and (e.battle_id = _battle_id or e.battle_id is null))
      or
      (_character_id is null and (
        e.battle_id = _battle_id
        or (e.battle_id is null and exists (
          select 1 from public.battle_participants bp
          where bp.battle_id = _battle_id and bp.character_id = e.character_id
        ))
      ))
    );

  -- Decrement only effects with more than one turn remaining. Effects changed 2 -> 1
  -- remain active; only IDs captured above are expired after the decrement.
  update public.battle_effects e
  set duration = duration - 1
  where e.duration > 1
    AND e.created_at < transaction_timestamp()
    AND NOT e.until_combat_end
    AND e.source_race_id IS NULL
    and (
      (_character_id is not null and e.character_id = _character_id
        and (e.battle_id = _battle_id or e.battle_id is null))
      or
      (_character_id is null and (
        e.battle_id = _battle_id
        or (e.battle_id is null and exists (
          select 1 from public.battle_participants bp
          where bp.battle_id = _battle_id and bp.character_id = e.character_id
        ))
      ))
    );

  -- Delete the pre-tick duration-1 effects after the countdown, so end effects created
  -- by delete triggers are not decremented during the turn that causes their creation.
  for _expired in
    select e.id
    from unnest(coalesce(_expired_ids, ARRAY[]::uuid[])) as expired(id)
    join public.battle_effects e on e.id = expired.id
    order by e.created_at, e.id
    for update of e
  loop
    delete from public.battle_effects e where e.id = _expired.id;
  end loop;

  -- Queue received-damage scripts after the turn's atomic HP updates.
  FOR _dot IN
    SELECT item.value AS event_data
    FROM jsonb_array_elements(_dot_hits) AS item(value)
  LOOP
    IF COALESCE(NULLIF(_dot.event_data->>'total_damage','')::integer, 0) > 0
       OR (COALESCE(NULLIF(_dot.event_data->>'is_invincible','')::boolean, false)
          AND COALESCE(NULLIF(_dot.event_data->>'potential_total','')::integer, 0) > 0) THEN
      FOR _dot_script IN
        SELECT ca.id
        FROM public.character_abilities ca
        JOIN public.abilities a ON a.id = ca.ability_id
        WHERE ca.character_id = (_dot.event_data->>'character_id')::uuid
          AND NULLIF(TRIM(a.custom_script_key), '') IS NOT NULL
      LOOP
        PERFORM public.queue_ability_script_event(
          'recebeu_dano', _dot_script.id,
          (_dot.event_data->>'character_id')::uuid, _battle_id,
          (_dot.event_data->>'character_id')::uuid, NULL,
          jsonb_build_object('dano', jsonb_build_object(
            'origemId', NULLIF(_dot.event_data->>'source_character_id',''),
            'personagemAtingidoId', _dot.event_data->>'character_id',
            'categoria', _dot.event_data->>'damage_kind',
            'tipoDanoId', NULLIF(_dot.event_data->>'damage_type_id',''),
            'tipoDanoFisicoId', NULLIF(_dot.event_data->>'physical_damage_type_id',''),
            'grauMagia', NULLIF(_dot.event_data->>'magic_level',''),
            'critico', false, 'dot', true,
            'danoBrutoPorGolpe', jsonb_build_array((_dot.event_data->>'raw_damage')::numeric),
            'danoFinalPorGolpe', _dot.event_data->'final_damage_by_hit',
            'danoFinalTotal', COALESCE(NULLIF(_dot.event_data->>'total_damage','')::integer,0),
            'danoPotencialSemInvencivelPorGolpe', _dot.event_data->'potential_damage_by_hit',
            'danoPotencialSemInvencivelTotal', COALESCE(NULLIF(_dot.event_data->>'potential_total','')::integer,0),
            'bloqueadoPorInvencivel', COALESCE(NULLIF(_dot.event_data->>'is_invincible','')::boolean,false),
            'hpAntes', COALESCE(NULLIF(_dot.event_data->>'hp_before','')::integer,0),
            'hpDepois', COALESCE(NULLIF(_dot.event_data->>'hp_after','')::integer,0)
          ))
        );
      END LOOP;
    END IF;
  END LOOP;

  return _result_turn;
end;
$function$
;
REVOKE ALL ON FUNCTION public.advance_combat_turn(uuid,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.advance_combat_turn(uuid,uuid,jsonb) TO authenticated;
