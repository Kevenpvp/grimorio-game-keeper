-- Adds configurable attack mode to catalog abilities and secure multi-target activation.
ALTER TABLE public.abilities
  ADD COLUMN IF NOT EXISTS attack_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS attack_damage jsonb NOT NULL DEFAULT '{"damage_kind":"physical","attribute_key":"strength","attribute_percent":100,"fixed_damage":0,"physical_damage_type_id":null,"damage_type_id":null,"magic_level":"baixa"}'::jsonb;

ALTER TABLE public.abilities DROP CONSTRAINT IF EXISTS abilities_attack_damage_object_check;
ALTER TABLE public.abilities ADD CONSTRAINT abilities_attack_damage_object_check
  CHECK (jsonb_typeof(attack_damage) = 'object');

-- Preserve normal activation validation, mana/cooldown handling, healing, caster effects,
-- ending-effect metadata and queued script hooks, but deliver target-scoped effects only
-- to the hit list chosen by the master.
DO $migration$
DECLARE
  _definition text;
BEGIN
  SELECT pg_get_functiondef('public.activate_character_ability(uuid,uuid,uuid,integer)'::regprocedure)
  INTO _definition;

  IF _definition IS NULL THEN
    RAISE EXCEPTION 'A função activate_character_ability não foi encontrada';
  END IF;

  _definition := replace(_definition, 'public.activate_character_ability(', 'public.activate_character_ability_attack(');
  _definition := replace(
    _definition,
    '_extra_mana_cost integer DEFAULT 0)',
    '_extra_mana_cost integer DEFAULT 0, _hit_target_ids uuid[] DEFAULT NULL::uuid[])'
  );
  _definition := replace(
    _definition,
    '  _effect_character_ids uuid[];',
    '  _effect_character_ids uuid[];' || E'\n' || '  _hit_target_id uuid;' || E'\n' || '  _apply_both boolean := false;'
  );
  _definition := replace(
    _definition,
    $old$  if coalesce(_extra_mana_cost, 0) < 0 or coalesce(_extra_mana_cost, 0) > 1000000 then$old$,
    $new$  IF _hit_target_ids IS NOT NULL THEN
    IF _effective_battle_id IS NULL THEN
      RAISE EXCEPTION 'Ataques de habilidade só podem ser resolvidos dentro de uma batalha ativa';
    END IF;
    IF cardinality(_hit_target_ids) > 100 THEN
      RAISE EXCEPTION 'Um ataque pode selecionar no máximo 100 alvos';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM unnest(_hit_target_ids) AS selected(target_id)
      WHERE selected.target_id IS NULL
         OR selected.target_id = _assignment.character_id
         OR NOT EXISTS (
           SELECT 1 FROM public.battle_participants bp
           WHERE bp.battle_id = _effective_battle_id
             AND bp.character_id = selected.target_id
         )
    ) THEN
      RAISE EXCEPTION 'Todos os alvos atingidos precisam ser outros participantes da mesma batalha';
    END IF;
  END IF;

  if coalesce(_extra_mana_cost, 0) < 0 or coalesce(_extra_mana_cost, 0) > 1000000 then$new$
  );
  _definition := replace(
    _definition,
    $old$    if coalesce((_effect->>'apply_both_on_activation')::boolean, false) then
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
    end if;$old$,
    $new$    IF _hit_target_ids IS NOT NULL THEN
      _effect_character_ids := ARRAY[]::uuid[];
      _apply_both := COALESCE((_effect->>'apply_both_on_activation')::boolean, false);
      IF _apply_both OR _target_scope IN ('caster', 'both') THEN
        _effect_character_ids := array_append(_effect_character_ids, _assignment.character_id);
      END IF;
      IF _apply_both OR _target_scope IN ('target', 'both') THEN
        FOREACH _hit_target_id IN ARRAY COALESCE(_hit_target_ids, ARRAY[]::uuid[]) LOOP
          IF _hit_target_id IS NOT NULL
             AND _hit_target_id <> _assignment.character_id
             AND NOT (_hit_target_id = ANY(_effect_character_ids)) THEN
            _effect_character_ids := array_append(_effect_character_ids, _hit_target_id);
          END IF;
        END LOOP;
      END IF;
    ELSIF coalesce((_effect->>'apply_both_on_activation')::boolean, false) then
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
    end if;$new$
  );

  IF position('_hit_target_ids uuid[] DEFAULT NULL::uuid[]' in _definition) = 0
     OR position('Todos os alvos atingidos precisam ser outros participantes' in _definition) = 0
     OR position('IF _hit_target_ids IS NOT NULL THEN' in _definition) = 0
     OR position('_hit_target_id uuid' in _definition) = 0 THEN
    RAISE EXCEPTION 'Não foi possível transformar a função de ativação para suportar ataques multi-alvo';
  END IF;

  EXECUTE _definition;
END
$migration$;

REVOKE ALL ON FUNCTION public.activate_character_ability_attack(uuid,uuid,uuid,integer,uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activate_character_ability_attack(uuid,uuid,uuid,integer,uuid[]) TO authenticated;
