-- Multi-recipient activation without multiple casts.
-- Keep the existing RPC signature for compatibility with older clients.
-- The frontend passes an optional server-validated recipient UUID list in
-- _dot_attribute_values.__activation_target_ids. All cost/cooldown/scripts,
-- summons and once-per-battle usage continue to occur exactly once.
DO $migration$
DECLARE
  _fn text;
  _old text;
  _new text;
BEGIN
  SELECT pg_get_functiondef('public.activate_character_ability(uuid,uuid,uuid,integer,jsonb,jsonb)'::regprocedure)
  INTO _fn;
  IF _fn IS NULL THEN RAISE EXCEPTION 'RPC de ativação ausente'; END IF;

  _old := '  _effect_group_id uuid := gen_random_uuid();';
  _new := E'  _activation_target_ids uuid[];\n  _activation_target_id uuid;\n  _target_json jsonb;\n' || _old;
  IF strpos(_fn,_old)=0 THEN RAISE EXCEPTION 'Declarações de ativação mudaram'; END IF;
  _fn := replace(_fn,_old,_new);

  _old := $block$  if not exists (select 1 from public.characters where id = _target_character_id) then
    raise exception 'Alvo não encontrado'; 
  end if;$block$;
  _new := _old || $block$

  -- Validate all recipients before changing Mana, cooldown or any effects.
  _target_json := CASE WHEN jsonb_typeof(_dot_attribute_values) = 'object'
                       THEN _dot_attribute_values->'__activation_target_ids'
                       ELSE NULL END;
  IF _target_json IS NULL THEN
    _activation_target_ids := ARRAY[_target_character_id];
  ELSE
    IF jsonb_typeof(_target_json) <> 'array'
       OR jsonb_array_length(_target_json) NOT BETWEEN 1 AND 25 THEN
      RAISE EXCEPTION 'Selecione entre 1 e 25 destinatários';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(_target_json) as selected(value)
               WHERE jsonb_typeof(selected.value) <> 'string') THEN
      RAISE EXCEPTION 'Lista de destinatários inválida';
    END IF;
    SELECT array_agg(selected.value::text::uuid ORDER BY selected.ordinality)
    INTO _activation_target_ids
    FROM jsonb_array_elements(_target_json) WITH ORDINALITY AS selected(value, ordinality);
    IF cardinality(_activation_target_ids) <> (
      SELECT count(DISTINCT selected_id) FROM unnest(_activation_target_ids) AS selected(selected_id)
    ) THEN RAISE EXCEPTION 'Seleção contém destinatários repetidos'; END IF;
    IF _target_character_id IS DISTINCT FROM _activation_target_ids[1] THEN
      RAISE EXCEPTION 'O alvo principal deve ser o primeiro destinatário';
    END IF;
  END IF;
  IF _assignment.self_target_only
    AND (_activation_target_ids <> ARRAY[_assignment.character_id]) THEN
    RAISE EXCEPTION 'Esta habilidade só pode ser usada no próprio personagem';
  END IF;
  IF EXISTS(
    SELECT 1 FROM unnest(_activation_target_ids) AS selected(id)
    WHERE NOT EXISTS (SELECT 1 FROM public.characters c WHERE c.id = selected.id)
  ) THEN RAISE EXCEPTION 'Um dos destinatários não existe'; END IF;
  IF _battle_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM unnest(_activation_target_ids) AS selected(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.battle_participants bp
      WHERE bp.battle_id = _battle_id AND bp.character_id = selected.id
    )
  ) THEN RAISE EXCEPTION 'Todos os destinatários precisam participar do mesmo combate'; END IF;
$block$;
  IF strpos(_fn,_old)=0 THEN RAISE EXCEPTION 'Validação de alvo mudou'; END IF;
  _fn := replace(_fn,_old,_new);

  _old := $block$    if coalesce((_effect->>'apply_both_on_activation')::boolean, false) then
      if _assignment.character_id = _target_character_id then
        _effect_character_ids := array[_assignment.character_id];
      else
        _effect_character_ids := array[_assignment.character_id, _target_character_id];
      end if;
    elsif _assignment.character_id = _target_character_id then
      if _target_scope in ('caster', 'both') then _effect_character_ids := array[_assignment.character_id];
      else _effect_character_ids := array[]::uuid[]; end if;
    elsif _target_scope in ('target', 'both') then
      _effect_character_ids := array[_target_character_id];
    else
      _effect_character_ids := array[]::uuid[];
    end if;$block$;
  _new := $block$    _effect_character_ids := ARRAY[]::uuid[];
    IF coalesce((_effect->>'apply_both_on_activation')::boolean,false) THEN
      -- Explicit Both-on-activation applies to caster AND every chosen target.
      _effect_character_ids := ARRAY[_assignment.character_id];
    END IF;
    FOREACH _activation_target_id IN ARRAY _activation_target_ids LOOP
      IF _activation_target_id = _assignment.character_id THEN
        -- A self-selection enables Caster and Both, never Target-only.
        IF (_target_scope IN ('caster','both')
             OR coalesce((_effect->>'apply_both_on_activation')::boolean,false))
           AND NOT (_assignment.character_id = ANY(_effect_character_ids)) THEN
          _effect_character_ids := array_append(_effect_character_ids,_assignment.character_id);
        END IF;
      ELSIF (_target_scope IN ('target','both')
              OR coalesce((_effect->>'apply_both_on_activation')::boolean,false))
        AND NOT (_activation_target_id = ANY(_effect_character_ids)) THEN
        _effect_character_ids := array_append(_effect_character_ids,_activation_target_id);
      END IF;
    END LOOP;$block$;
  IF strpos(_fn,_old)=0 THEN RAISE EXCEPTION 'Lógica de destino dos efeitos mudou'; END IF;
  _fn := replace(_fn,_old,_new);

  -- Each active recipient should be recorded on their own applied effect.
  -- Preserve legacy single-target semantics unchanged.
  _old := '_target_character_id, _effect ||';
  _new := 'CASE WHEN cardinality(_activation_target_ids)>1 THEN _effect_character_id ELSE _target_character_id END, _effect ||';
  IF strpos(_fn,_old)=0 THEN RAISE EXCEPTION 'Registro da cura mudou'; END IF;
  _fn := replace(_fn,_old,_new);
  _old := '_target_character_id, _effect' || chr(10);
  _new := 'CASE WHEN cardinality(_activation_target_ids)>1 THEN _effect_character_id ELSE _target_character_id END, _effect' || chr(10);
  IF strpos(_fn,_old)=0 THEN RAISE EXCEPTION 'Registro de efeitos mudou'; END IF;
  _fn := replace(_fn,_old,_new);

  _old := $block$    PERFORM public.switch_exclusive_continuous_grip_internal(_effective_battle_id,_assignment.id,ARRAY[_target_character_id]::uuid[]);
    PERFORM public.begin_continuous_effects(_effective_battle_id,_assignment.id,_target_character_id);$block$;
  _new := $block$    PERFORM public.switch_exclusive_continuous_grip_internal(_effective_battle_id,_assignment.id,_activation_target_ids);
    FOREACH _activation_target_id IN ARRAY _activation_target_ids LOOP
      PERFORM public.begin_continuous_effects(_effective_battle_id,_assignment.id,_activation_target_id);
    END LOOP;$block$;
  IF strpos(_fn,_old)=0 THEN RAISE EXCEPTION 'Lógica contínua mudou'; END IF;
  _fn := replace(_fn,_old,_new);

  EXECUTE _fn;
END;
$migration$;