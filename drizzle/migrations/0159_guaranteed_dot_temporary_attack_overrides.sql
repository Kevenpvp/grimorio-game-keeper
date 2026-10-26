-- Let the GM temporarily edit guaranteed DoTs per attack target.
-- Overrides apply even if attack hit=false, without changing saved abilities.
CREATE OR REPLACE FUNCTION public.apply_character_ability_dots(_character_ability_id uuid, _battle_id uuid, _target_selections jsonb, _attribute_values jsonb DEFAULT '{}'::jsonb)
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
  _current_guaranteed_dots jsonb;
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

  SELECT ca.character_id, ca.ability_id, ca.name,
         CASE WHEN ca.ability_id IS NULL THEN COALESCE(ca.dot_effects,'[]'::jsonb)
              ELSE COALESCE(a.dot_effects,'[]'::jsonb) END,
         CASE WHEN ca.ability_id IS NULL THEN COALESCE(ca.attack_effect_groups,'[]'::jsonb)
              ELSE COALESCE(a.attack_effect_groups,'[]'::jsonb) END,
         CASE WHEN ca.ability_id IS NULL THEN COALESCE(ca.attack_enabled,false)
              ELSE COALESCE(a.attack_enabled,false) END
  INTO _caster_id, _ability_id, _ability_name, _guaranteed_dots, _attack_groups, _attack_enabled
  FROM public.character_abilities ca
  LEFT JOIN public.abilities a ON a.id = ca.ability_id
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

    -- Guaranteed DoTs hit every chosen target, even when the attack misses.
    -- The optional per-target override is consumed only by this RPC; the
    -- saved character/catalog ability remains unchanged.
    _current_guaranteed_dots := _guaranteed_dots;
    IF _selection ? 'guaranteed_dots_override' THEN
      IF jsonb_typeof(_selection->'guaranteed_dots_override') IS DISTINCT FROM 'array'
        OR jsonb_array_length(_selection->'guaranteed_dots_override') > 100 THEN
        RAISE EXCEPTION 'A lista de DoTs garantidos modificados é inválida';
      END IF;
      _current_guaranteed_dots := _selection->'guaranteed_dots_override';
    END IF;
    FOR _dot IN
      SELECT value FROM jsonb_array_elements(_current_guaranteed_dots) AS configured(value)
    LOOP
      PERFORM public.apply_ability_dot_effect_internal(
        _battle_id, _caster_id, _ability_name, _target_id, _dot, COALESCE(_attribute_values, '{}'::jsonb),
        _character_ability_id
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
        -- Per-target attack edits come only from this RPC call. The saved
        -- attack groups on the catalog/character are never updated.
        IF _selection->'group_overrides'->_group_id ? 'dots' THEN
          IF jsonb_typeof(_selection->'group_overrides'->_group_id->'dots') IS DISTINCT FROM 'array'
             OR jsonb_array_length(_selection->'group_overrides'->_group_id->'dots') > 100 THEN
            RAISE EXCEPTION 'Os DoTs modificados nesta utilização são inválidos';
          END IF;
          _group := jsonb_set(_group,'{dots}',_selection->'group_overrides'->_group_id->'dots',true);
        END IF;
        IF jsonb_typeof(COALESCE(_group->'dots', '[]'::jsonb)) IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'A lista de DoTs da categoria de ataque está inválida';
        END IF;
        FOR _dot IN
          SELECT value FROM jsonb_array_elements(COALESCE(_group->'dots', '[]'::jsonb)) AS configured(value)
        LOOP
          PERFORM public.apply_ability_dot_effect_internal(
            _battle_id, _caster_id, _ability_name, _target_id, _dot, COALESCE(_attribute_values, '{}'::jsonb),
            _character_ability_id
          );
          _dot_count := _dot_count + 1;
        END LOOP;
      END LOOP;
    END IF;
  END LOOP;

  RETURN _dot_count;
END;
$function$
;
NOTIFY pgrst, 'reload schema';