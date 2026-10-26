-- Adopt the expected physical-grapple defaults on the EXISTING Desgraça
-- skill only; preserve its attributes, percentages and residual duration.
-- No player stats, accumulated effects, or battle instances are changed.
UPDATE public.character_abilities
SET continuous_rules = jsonb_set(
  continuous_rules, '{0}',
  (continuous_rules->0) || jsonb_build_object(
    'max_targets',1,
    'on_limit','choose',
    'stop_on_caster_leave',true,
    'stop_on_caster_death',true,
    'stop_on_caster_stun',true
  ),false)
WHERE id='f726947e-7eb3-4bc0-916e-dab70e833b3b'::uuid
  AND name='Desgraça física'
  AND jsonb_typeof(continuous_rules)='array'
  AND jsonb_array_length(continuous_rules)>0;

UPDATE public.character_abilities c SET continuous_rules=p.continuous_rules
FROM public.character_abilities p
WHERE c.summon_template_ability_id=p.id
  AND p.id='f726947e-7eb3-4bc0-916e-dab70e833b3b'::uuid
  AND c.name='Desgraça física'
  AND jsonb_typeof(c.continuous_rules)='array'
  AND jsonb_array_length(c.continuous_rules)>0;