-- Make multi-target attack effects and expiration triggers independent per recipient,
-- and ensure the attack RPC can only be used for abilities explicitly configured to attack.
DO $migration$
DECLARE
  _definition text;
  _old_decl text := $old$  _apply_both boolean := false;$old$;
  _new_decl text := $new$  _apply_both boolean := false;
  _effect_target_character_id uuid;
  _group_target_ids uuid[] := ARRAY[]::uuid[];
  _group_ids uuid[] := ARRAY[]::uuid[];
  _group_index integer;$new$;
  _old_loop text := $old$    foreach _effect_character_id in array _effect_character_ids loop
      if _effect_type = 'healing' then$old$;
  _new_loop text := $new$    foreach _effect_character_id in array _effect_character_ids loop
      _effect_target_character_id := _target_character_id;
      IF _hit_target_ids IS NOT NULL THEN
        _group_index := array_position(_group_target_ids, _effect_character_id);
        IF _group_index IS NULL THEN
          _group_target_ids := array_append(_group_target_ids, _effect_character_id);
          _group_ids := array_append(_group_ids, gen_random_uuid());
          _group_index := cardinality(_group_target_ids);
        END IF;
        _effect_group_id := _group_ids[_group_index];
        IF _effect_character_id <> _assignment.character_id THEN
          _effect_target_character_id := _effect_character_id;
        END IF;
      END IF;
      if _effect_type = 'healing' then$new$;
BEGIN
  SELECT pg_get_functiondef('public.activate_character_ability_attack(uuid,uuid,uuid,integer,uuid[])'::regprocedure)
  INTO _definition;

  IF _definition IS NULL THEN
    RAISE EXCEPTION 'A função de ataque de habilidades não foi encontrada';
  END IF;

  IF position('_group_target_ids uuid[]' in _definition) = 0 THEN
    _definition := replace(_definition, _old_decl, _new_decl);
    _definition := replace(_definition, _old_loop, _new_loop);
    _definition := replace(
      _definition,
      $old$_effect_group_id, false, 'any', _target_character_id, _effect || jsonb_build_object('_runtime_healer_character_id', _assignment.character_id)$old$,
      $new$_effect_group_id, false, 'any', _effect_target_character_id, _effect || jsonb_build_object('_runtime_healer_character_id', _assignment.character_id)$new$
    );
    _definition := replace(
      _definition,
      $old$_target_character_id, _effect
      );$old$,
      $new$_effect_target_character_id, _effect
      );$new$
    );
  END IF;

  IF position('Esta habilidade não está configurada para atacar' in _definition) = 0 THEN
    _definition := replace(
      _definition,
      '  IF _hit_target_ids IS NOT NULL THEN' || E'\n' || '    IF _effective_battle_id IS NULL THEN',
      '  IF _hit_target_ids IS NOT NULL THEN' || E'\n'
        || '    IF NOT EXISTS (' || E'\n'
        || '      SELECT 1 FROM public.abilities a' || E'\n'
        || '      WHERE a.id = _assignment.ability_id AND a.attack_enabled IS TRUE' || E'\n'
        || '    ) THEN' || E'\n'
        || '      RAISE EXCEPTION ''Esta habilidade não está configurada para atacar'';' || E'\n'
        || '    END IF;' || E'\n'
        || '    IF _effective_battle_id IS NULL THEN'
    );
  END IF;

  IF position('_group_target_ids uuid[]' in _definition) = 0
     OR position('array_position(_group_target_ids, _effect_character_id)' in _definition) = 0
     OR position('_effect_group_id := _group_ids[_group_index]' in _definition) = 0
     OR position('Esta habilidade não está configurada para atacar' in _definition) = 0 THEN
    RAISE EXCEPTION 'A função de ataque não contém a proteção esperada para múltiplos alvos';
  END IF;

  EXECUTE _definition;
END
$migration$;
