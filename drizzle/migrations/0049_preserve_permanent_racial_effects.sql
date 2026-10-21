-- Preserve effects that last until combat ends during individual and global turns.
-- Racial effects are permanent while the character keeps its race. Their sentinel duration
-- is 1, but that must not make them expire on the next turn.
create or replace function public.advance_combat_turn(
  _battle_id uuid,
  _character_id uuid default null,
  _mana_regeneration_settings jsonb default '{}'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
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

  return _result_turn;
end;
$$;

-- Cleansing and debuff-duration reduction must skip every effect granted by a race.
CREATE OR REPLACE FUNCTION public.apply_ability_healing(
  _character_id uuid,
  _battle_id uuid,
  _config jsonb,
  _apply_resources boolean DEFAULT true,
  _apply_debuff_changes boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _current numeric;
  _maximum numeric;
  _amount numeric;
  _body numeric;
  _sanity numeric;
  _body_restore numeric := 0;
  _sanity_restore numeric := 0;
  _blacklist jsonb := '[]'::jsonb;
  _name_blacklist text[] := ARRAY[]::text[];
  _fixed_turns integer := 0;
  _percent_turns numeric := 0;
  _debuff record;
  _new_duration integer;
  _reversal_effect jsonb;
  _reversal_mode text;
  _reversal_custom_damage numeric := 0;
  _reversal_base_damage numeric := 0;
  _reversal_damage numeric := 0;
  _runtime_healer_id uuid;
  _reversal_type_id uuid;
  _reversal_magic_level text;
  _reversed_healing boolean := false;
BEGIN
  IF _config IS NULL OR jsonb_typeof(_config) <> 'object' THEN
    RAISE EXCEPTION 'Configuração da cura inválida';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.characters WHERE id = _character_id) THEN
    RAISE EXCEPTION 'Personagem da cura não encontrado';
  END IF;

  IF jsonb_typeof(_config->'healing_debuff_blacklist') = 'array' THEN
    _blacklist := _config->'healing_debuff_blacklist';
  END IF;
  IF jsonb_typeof(_config->'healing_debuff_name_blacklist') = 'array' THEN
    SELECT coalesce(array_agg(lower(trim(value))), ARRAY[]::text[])
    INTO _name_blacklist
    FROM jsonb_array_elements_text(_config->'healing_debuff_name_blacklist') AS names(value)
    WHERE trim(value) <> '';
  END IF;

  -- Reversão de Cura: find the newest matching temporary/racial effect first.
  -- Empty type/grade arrays mean all magical types or all grades.
  IF _apply_resources THEN
    SELECT e.effect_data
    INTO _reversal_effect
    FROM public.battle_effects e
    WHERE e.character_id = _character_id
      AND e.effect_type = 'healing_blocked'
      AND e.effect_data->>'effect_type' = 'magic_healing_reversal'
      AND e.duration > 0
      AND (e.battle_id IS NULL OR e.battle_id = _battle_id)
      AND (
        CASE
          WHEN jsonb_typeof(e.effect_data->'magic_healing_type_ids') = 'array' THEN
            jsonb_array_length(e.effect_data->'magic_healing_type_ids') = 0
            OR (
              NULLIF(_config->>'healing_damage_type_id', '') IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(e.effect_data->'magic_healing_type_ids') selected(value)
                WHERE selected.value = _config->>'healing_damage_type_id'
              )
            )
          ELSE true
        END
      )
      AND (
        CASE
          WHEN jsonb_typeof(e.effect_data->'magic_healing_magic_levels') = 'array' THEN
            jsonb_array_length(e.effect_data->'magic_healing_magic_levels') = 0
            OR (
              NULLIF(_config->>'healing_magic_level', '') IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(e.effect_data->'magic_healing_magic_levels') selected(value)
                WHERE selected.value = _config->>'healing_magic_level'
              )
            )
          ELSE true
        END
      )
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT 1;

    IF _reversal_effect IS NULL THEN
      SELECT passive.effect
      INTO _reversal_effect
      FROM public.character_abilities ca
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(COALESCE(ca.passive_effects, '[]'::jsonb)) = 'array'
          THEN COALESCE(ca.passive_effects, '[]'::jsonb) ELSE '[]'::jsonb END
      ) AS passive(effect)
      WHERE ca.character_id = _character_id
        AND passive.effect->>'effect_type' = 'magic_healing_reversal'
        AND (
          CASE
            WHEN jsonb_typeof(passive.effect->'magic_healing_type_ids') = 'array' THEN
              jsonb_array_length(passive.effect->'magic_healing_type_ids') = 0
              OR (
                NULLIF(_config->>'healing_damage_type_id', '') IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(passive.effect->'magic_healing_type_ids') selected(value)
                  WHERE selected.value = _config->>'healing_damage_type_id'
                )
              )
            ELSE true
          END
        )
        AND (
          CASE
            WHEN jsonb_typeof(passive.effect->'magic_healing_magic_levels') = 'array' THEN
              jsonb_array_length(passive.effect->'magic_healing_magic_levels') = 0
              OR (
                NULLIF(_config->>'healing_magic_level', '') IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(passive.effect->'magic_healing_magic_levels') selected(value)
                  WHERE selected.value = _config->>'healing_magic_level'
                )
              )
            ELSE true
          END
        )
      ORDER BY ca.created_at DESC, ca.id
      LIMIT 1;
    END IF;

    IF _reversal_effect IS NOT NULL THEN
      SELECT c.body::numeric, c.sanity::numeric
      INTO _body, _sanity
      FROM public.characters c
      WHERE c.id = _character_id
      FOR UPDATE;

      -- Sum the configured recovery amount across enabled resources, using the same
      -- fixed/percentage calculations as normal healing, before resource caps.
      IF COALESCE((_config->>'healing_hp_enabled')::boolean, false) THEN
        _maximum := GREATEST(0, COALESCE(public.calculate_character_resource_max(_character_id, 'hp'), 0));
        _amount := GREATEST(0, COALESCE(NULLIF(_config->>'healing_hp_amount', '')::numeric, 0));
        IF COALESCE(_config->>'healing_hp_mode', 'fixed') = 'percent' THEN
          _amount := CEIL(_maximum * LEAST(100, _amount) / 100);
        ELSE
          _amount := FLOOR(_amount);
        END IF;
        _reversal_base_damage := _reversal_base_damage + _amount;
      END IF;
      IF COALESCE((_config->>'healing_mana_enabled')::boolean, false) THEN
        _maximum := GREATEST(0, COALESCE(public.calculate_character_resource_max(_character_id, 'mana'), 0));
        _amount := GREATEST(0, COALESCE(NULLIF(_config->>'healing_mana_amount', '')::numeric, 0));
        IF COALESCE(_config->>'healing_mana_mode', 'fixed') = 'percent' THEN
          _amount := CEIL(_maximum * LEAST(100, _amount) / 100);
        ELSE
          _amount := FLOOR(_amount);
        END IF;
        _reversal_base_damage := _reversal_base_damage + _amount;
      END IF;
      IF COALESCE((_config->>'healing_body_enabled')::boolean, false) THEN
        _amount := GREATEST(0, COALESCE(NULLIF(_config->>'healing_body_amount', '')::numeric, 0));
        IF COALESCE(_config->>'healing_body_mode', 'fixed') = 'percent' THEN
          _amount := CEIL(GREATEST(0, 100 - COALESCE(_body, 100)) * LEAST(100, _amount) / 100);
        ELSE
          _amount := FLOOR(_amount);
        END IF;
        _reversal_base_damage := _reversal_base_damage + _amount;
      END IF;
      IF COALESCE((_config->>'healing_sanity_enabled')::boolean, false) THEN
        _amount := GREATEST(0, COALESCE(NULLIF(_config->>'healing_sanity_amount', '')::numeric, 0));
        IF COALESCE(_config->>'healing_sanity_mode', 'fixed') = 'percent' THEN
          _amount := CEIL(GREATEST(0, 100 - COALESCE(_sanity, 100)) * LEAST(100, _amount) / 100);
        ELSE
          _amount := FLOOR(_amount);
        END IF;
        _reversal_base_damage := _reversal_base_damage + _amount;
      END IF;

      _reversal_mode := COALESCE(NULLIF(_reversal_effect->>'magic_healing_reversal_damage_mode', ''), 'healing_amount');
      _reversal_custom_damage := LEAST(1000000, GREATEST(0, COALESCE(NULLIF(_reversal_effect->>'magic_healing_reversal_custom_damage', '')::numeric, 0)));
      IF _reversal_mode = 'custom' THEN
        _reversal_damage := _reversal_custom_damage;
      ELSIF _reversal_mode = 'both' THEN
        _reversal_damage := _reversal_base_damage + _reversal_custom_damage;
      ELSE
        _reversal_damage := _reversal_base_damage;
      END IF;
      _reversal_damage := LEAST(1000000, GREATEST(0, ROUND(_reversal_damage)));
      _runtime_healer_id := NULLIF(_config->>'_runtime_healer_character_id', '')::uuid;
      IF _runtime_healer_id = _character_id OR (
        _runtime_healer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.characters c WHERE c.id = _runtime_healer_id)
      ) OR (
        _runtime_healer_id IS NOT NULL AND _battle_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.battle_participants bp
          WHERE bp.battle_id = _battle_id AND bp.character_id = _runtime_healer_id
        )
      ) THEN
        _runtime_healer_id := NULL;
      END IF;

      IF _reversal_damage > 0 THEN
        _reversal_type_id := NULLIF(_config->>'healing_damage_type_id', '')::uuid;
        _reversal_magic_level := NULLIF(_config->>'healing_magic_level', '');
        IF _reversal_type_id IS NOT NULL
           AND _reversal_magic_level IN ('baixa', 'media', 'alta')
           AND EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id = _reversal_type_id) THEN
          PERFORM public.apply_battle_damage(
            _battle_id, _character_id, 'magical', _reversal_type_id,
            jsonb_build_array(_reversal_damage), _reversal_magic_level, _runtime_healer_id
          );
        ELSE
          PERFORM public.apply_battle_damage(
            _battle_id, _character_id, 'true', NULL,
            jsonb_build_array(_reversal_damage), NULL, _runtime_healer_id
          );
        END IF;
      END IF;
      _reversed_healing := true;
    END IF;
  END IF;

  IF _apply_resources AND NOT _reversed_healing AND NOT (
    EXISTS (
      SELECT 1 FROM public.battle_effects e
      WHERE e.character_id = _character_id
        AND e.effect_type = 'healing_blocked'
        AND COALESCE(e.effect_data->>'effect_type', 'healing_blocked') <> 'magic_healing_reversal'
        AND e.duration > 0
        AND (e.battle_id IS NULL OR e.battle_id = _battle_id)
    )
    OR EXISTS (
      SELECT 1
      FROM public.character_abilities ca
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(COALESCE(ca.passive_effects, '[]'::jsonb)) = 'array'
          THEN COALESCE(ca.passive_effects, '[]'::jsonb) ELSE '[]'::jsonb END
      ) AS passive(effect)
      WHERE ca.character_id = _character_id
        AND passive.effect->>'effect_type' = 'healing_blocked'
    )
  ) THEN
    SELECT c.body::numeric, c.sanity::numeric
    INTO _body, _sanity
    FROM public.characters c
    WHERE c.id = _character_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Personagem da cura não encontrado'; END IF;

    IF coalesce((_config->>'healing_hp_enabled')::boolean, false) THEN
      SELECT ca.current_value INTO _current
      FROM public.character_attributes ca
      WHERE ca.character_id = _character_id AND ca.attribute_key = 'hp'
      FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Esta ficha não possui o atributo HP'; END IF;
      _maximum := greatest(0, coalesce(public.calculate_character_resource_max(_character_id, 'hp'), 0));
      _amount := greatest(0, coalesce(nullif(_config->>'healing_hp_amount', '')::numeric, 0));
      IF coalesce(_config->>'healing_hp_mode', 'fixed') = 'percent' THEN
        _amount := ceil(_maximum * least(100, _amount) / 100);
      ELSE
        _amount := floor(_amount);
      END IF;
      UPDATE public.character_attributes
      SET current_value = CASE WHEN _current >= _maximum THEN _current
        ELSE least(_maximum, greatest(0, _current + _amount))::integer END,
        updated_at = now()
      WHERE character_id = _character_id AND attribute_key = 'hp';
    END IF;

    IF coalesce((_config->>'healing_mana_enabled')::boolean, false) THEN
      SELECT ca.current_value INTO _current
      FROM public.character_attributes ca
      WHERE ca.character_id = _character_id AND ca.attribute_key = 'mana'
      FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Esta ficha não possui o atributo Mana'; END IF;
      _maximum := greatest(0, coalesce(public.calculate_character_resource_max(_character_id, 'mana'), 0));
      _amount := greatest(0, coalesce(nullif(_config->>'healing_mana_amount', '')::numeric, 0));
      IF coalesce(_config->>'healing_mana_mode', 'fixed') = 'percent' THEN
        _amount := ceil(_maximum * least(100, _amount) / 100);
      ELSE
        _amount := floor(_amount);
      END IF;
      UPDATE public.character_attributes
      SET current_value = CASE WHEN _current >= _maximum THEN _current
        ELSE least(_maximum, greatest(0, _current + _amount))::integer END,
        updated_at = now()
      WHERE character_id = _character_id AND attribute_key = 'mana';
    END IF;

    IF coalesce((_config->>'healing_body_enabled')::boolean, false) THEN
      _amount := greatest(0, coalesce(nullif(_config->>'healing_body_amount', '')::numeric, 0));
      IF coalesce(_config->>'healing_body_mode', 'fixed') = 'percent' THEN
        _body_restore := ceil(greatest(0, 100 - _body) * least(100, _amount) / 100);
      ELSE
        _body_restore := floor(_amount);
      END IF;
    END IF;
    IF coalesce((_config->>'healing_sanity_enabled')::boolean, false) THEN
      _amount := greatest(0, coalesce(nullif(_config->>'healing_sanity_amount', '')::numeric, 0));
      IF coalesce(_config->>'healing_sanity_mode', 'fixed') = 'percent' THEN
        _sanity_restore := ceil(greatest(0, 100 - _sanity) * least(100, _amount) / 100);
      ELSE
        _sanity_restore := floor(_amount);
      END IF;
    END IF;
    IF _body_restore > 0 OR _sanity_restore > 0 THEN
      UPDATE public.characters
      SET body = least(100, greatest(0, body + _body_restore::integer)),
          sanity = least(100, greatest(0, sanity + _sanity_restore::integer)),
          updated_at = now()
      WHERE id = _character_id;
    END IF;
  END IF;

  IF _apply_debuff_changes THEN
    IF coalesce((_config->>'healing_remove_debuffs')::boolean, false) THEN
      DELETE FROM public.battle_effects e
      WHERE e.character_id = _character_id
        AND e.duration > 0
        AND e.source_race_id IS NULL -- racial effects cannot be cleansed or shortened
        AND (e.battle_id IS NULL OR e.battle_id = _battle_id)
        AND (
          e.polarity = 'debuff'
          OR e.effect_type IN ('no_regen_hp','no_regen_mana','magic_prohibition','no_mana','stun')
        )
        AND NOT (_blacklist ? e.effect_type)
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(_name_blacklist) AS excluded(name)
          WHERE lower(e.name) = excluded.name
             OR right(lower(e.name), length(excluded.name) + 2) = ': ' || excluded.name
        );
    END IF;

    _fixed_turns := greatest(0, coalesce(nullif(_config->>'healing_reduce_debuff_turns_fixed', '')::integer, 0));
    _percent_turns := least(100, greatest(0, coalesce(nullif(_config->>'healing_reduce_debuff_turns_percent', '')::numeric, 0)));
    IF _fixed_turns > 0 OR _percent_turns > 0 THEN
      FOR _debuff IN
        SELECT e.id, e.duration
        FROM public.battle_effects e
        WHERE e.character_id = _character_id
          AND e.duration > 0
          AND e.source_race_id IS NULL -- racial effects cannot be cleansed or shortened
          AND (e.battle_id IS NULL OR e.battle_id = _battle_id)
          AND (
            e.polarity = 'debuff'
            OR e.effect_type IN ('no_regen_hp','no_regen_mana','magic_prohibition','no_mana','stun')
          )
        AND NOT (_blacklist ? e.effect_type)
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(_name_blacklist) AS excluded(name)
          WHERE lower(e.name) = excluded.name
             OR right(lower(e.name), length(excluded.name) + 2) = ': ' || excluded.name
        )
        ORDER BY e.created_at, e.id
        FOR UPDATE OF e
      LOOP
        _new_duration := floor(greatest(0, _debuff.duration - _fixed_turns) * (1 - _percent_turns / 100))::integer;
        IF _new_duration <= 0 THEN
          DELETE FROM public.battle_effects WHERE id = _debuff.id;
        ELSIF _new_duration < _debuff.duration THEN
          UPDATE public.battle_effects SET duration = _new_duration WHERE id = _debuff.id;
        END IF;
      END LOOP;
    END IF;
  END IF;
END;
$$;
