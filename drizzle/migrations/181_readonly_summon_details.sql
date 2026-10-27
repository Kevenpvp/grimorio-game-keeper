-- Read-only details of a creature granted to an owned character.
-- Does not grant general visibility to other players' sheets or abilities.
CREATE OR REPLACE FUNCTION public.get_summon_details(
  _grant_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  _grant public.summon_grants%ROWTYPE;
  _creature public.characters%ROWTYPE;
  _active_id uuid;
  _battle_id uuid;
  _master boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Faça login para ver detalhes da invocação';
  END IF;

  SELECT * INTO _grant FROM public.summon_grants WHERE id = _grant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invocação não encontrada ou não autorizada';
  END IF;

  _master := public.has_role(auth.uid(),'master');
  IF NOT _master AND NOT (
    EXISTS (
      SELECT 1 FROM public.characters c
      WHERE c.id = _grant.summoner_character_id AND c.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.character_abilities ca
      JOIN public.characters c ON c.id = ca.character_id
      WHERE ca.ability_id = _grant.ability_id AND c.owner_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'Invocação não encontrada ou não autorizada';
  END IF;

  -- While summoned, show live HP, Mana, buffs and ability cooldowns.
  -- Otherwise show the registered template, without pretending it is live.
  SELECT s.summoned_character_id, s.battle_id
    INTO _active_id, _battle_id
  FROM public.active_summons s
  JOIN public.battles b ON b.id = s.battle_id AND b.active
  WHERE s.grant_id = _grant.id
  ORDER BY s.created_at DESC
  LIMIT 1;

  SELECT * INTO _creature FROM public.characters
  WHERE id = COALESCE(_active_id, _grant.template_character_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A ficha desta criatura não está disponível';
  END IF;

  RETURN jsonb_build_object(
    'name', _grant.display_name,
    'is_active', _active_id IS NOT NULL,
    'character', jsonb_build_object(
      'id',_creature.id,
      'name',_creature.name,
      'description',_creature.description,
      'body',_creature.body,
      'sanity',_creature.sanity,
      'race_id',_creature.race_id,
      'virtue_id',_creature.virtue_id,
      'class_id',_creature.class_id,
      'class_custom_modifiers',_creature.class_custom_modifiers,
      'race_physical_allocations',_creature.race_physical_allocations,
      'virtue_physical_allocations',_creature.virtue_physical_allocations,
      'class_physical_allocations',_creature.class_physical_allocations
    ),
    'configured_stats',COALESCE(_grant.custom_stats,'{}'::jsonb),
    'attributes',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'attribute_key',a.attribute_key,
        'points',a.points,'bonus',a.bonus,
        'current_value',a.current_value,'max_value',a.max_value
      ))
      FROM public.character_attributes a WHERE a.character_id=_creature.id
    ),'[]'::jsonb),
    'abilities',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',ca.id,
        'name',ca.name,
        'description',ca.description,
        'is_passive',ca.is_passive,
        'can_activate',ca.can_activate,
        'is_magical',ca.is_magical,
        'mana_cost',ca.mana_cost,
        'cooldown_turns',ca.cooldown_turns,
        'cooldown_remaining',ca.cooldown_remaining,
        'active_duration_remaining',ca.active_duration_remaining,
        'attack_enabled',ca.attack_enabled,
        'attack_damage',ca.attack_damage,
        'effects',ca.effects,
        'passive_effects',ca.passive_effects,
        'end_effects',ca.end_effects,
        'continuous_rules',ca.continuous_rules,
        'dot_effects',ca.dot_effects,
        'toggle_mode',ca.toggle_mode,
        'toggle_active',ca.toggle_active
      ) ORDER BY ca.name,ca.created_at)
      FROM public.character_abilities ca
      WHERE ca.character_id=_creature.id
    ),'[]'::jsonb),
    'effects',COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',e.id,
        'name',e.name,
        'effect_type',e.effect_type,
        'attribute_key',e.attribute_key,
        'polarity',e.polarity,
        'value_mode',e.value_mode,
        'amount',e.amount,
        'duration',e.duration,
        'duration_scope',e.duration_scope,
        'until_combat_end',e.until_combat_end,
        'is_sheet_permanent',e.is_sheet_permanent,
        'effect_data',e.effect_data
      ) ORDER BY e.created_at)
      FROM public.battle_effects e
      WHERE e.character_id=_creature.id
        AND (e.battle_id IS NULL OR (_battle_id IS NOT NULL AND e.battle_id=_battle_id))
    ),'[]'::jsonb)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_summon_details(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_summon_details(uuid) TO authenticated;