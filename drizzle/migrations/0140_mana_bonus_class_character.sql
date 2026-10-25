-- Mana is a valid per-character class bonus: +1 Mana point equals +50 Mana.
-- Keep HP excluded, preserve previous class authorization and all non-Mana rules.
CREATE OR REPLACE FUNCTION public.calculate_character_resource_max(_character_id uuid, _attribute_key text, _exclude_battle_effect_id uuid DEFAULT NULL::uuid, _exclude_character_ability_id uuid DEFAULT NULL::uuid, _extra_active_effects jsonb DEFAULT '[]'::jsonb, _extra_passive_effects jsonb DEFAULT '[]'::jsonb)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _accepts_points boolean;
  _base_value numeric;
  _points_multiplier numeric;
  _points numeric;
  _stored_max numeric;
  _bonus numeric;
  _trait_modifier numeric;
  _base_max numeric;
  _fixed_modifier numeric := 0;
  _percent_modifier numeric := 0;
begin
  if _attribute_key not in ('hp', 'mana') then
    raise exception 'Este cálculo só aceita HP ou Mana';
  end if;

  select
    d.accepts_points,
    d.base_value,
    d.points_multiplier,
    ca.points,
    ca.max_value,
    ca.bonus,
    coalesce(nullif(r.modifiers ->> _attribute_key, '')::numeric, 0)
      + coalesce(nullif(v.modifiers ->> _attribute_key, '')::numeric, 0)
      + coalesce(nullif(cl.modifiers ->> _attribute_key, '')::numeric, 0)
      + CASE WHEN _attribute_key = 'mana' AND c.class_id IS NOT NULL
        THEN coalesce(nullif(c.class_custom_modifiers ->> 'mana','')::numeric,0)
        ELSE 0 END
  into
    _accepts_points, _base_value, _points_multiplier, _points,
    _stored_max, _bonus, _trait_modifier
  from public.characters c
  join public.character_attributes ca
    on ca.character_id = c.id and ca.attribute_key = _attribute_key
  join public.attribute_definitions d on d.key = ca.attribute_key
  left join public.races r on r.id = c.race_id
  left join public.virtues v on v.id = c.virtue_id
  left join public.classes cl on cl.id = c.class_id
  where c.id = _character_id;

  if not found then return 0; end if;

  if _accepts_points then
    _base_max := round((_base_value + (coalesce(_points, 0) + _trait_modifier) * _points_multiplier) * 100) / 100
      + coalesce(_bonus, 0);
  else
    _base_max := coalesce(_stored_max, 0) + _trait_modifier + coalesce(_bonus, 0);
  end if;

  select
    coalesce(sum(case when modifiers.polarity = 'buff' then modifiers.amount else -modifiers.amount end)
      filter (where modifiers.value_mode = 'fixed'), 0),
    coalesce(sum(case when modifiers.polarity = 'buff' then modifiers.amount else -modifiers.amount end)
      filter (where modifiers.value_mode = 'percent'), 0)
  into _fixed_modifier, _percent_modifier
  from (
    select e.polarity, e.value_mode, e.amount
    from public.battle_effects e
    where e.character_id = _character_id
      and e.id is distinct from _exclude_battle_effect_id
      and e.effect_type = 'status'
      and e.attribute_key = _attribute_key
      and e.duration > 0
      and (
        e.battle_id is null
        or exists (select 1 from public.battles b where b.id = e.battle_id and b.active)
      )

    union all

    select
      coalesce(passive.effect ->> 'polarity', 'buff'),
      coalesce(passive.effect ->> 'value_mode', 'fixed'),
      coalesce(nullif(passive.effect ->> 'amount', '')::numeric, 0)
    from public.character_abilities ca
    cross join lateral jsonb_array_elements(coalesce(ca.passive_effects, '[]'::jsonb)) as passive(effect)
    where ca.character_id = _character_id
      and ca.id is distinct from _exclude_character_ability_id
      and passive.effect ->> 'effect_type' = 'status'
      and passive.effect ->> 'attribute_key' = _attribute_key

    union all

    select
      coalesce(extra.effect ->> 'polarity', 'buff'),
      coalesce(extra.effect ->> 'value_mode', 'fixed'),
      coalesce(nullif(extra.effect ->> 'amount', '')::numeric, 0)
    from jsonb_array_elements(coalesce(_extra_active_effects, '[]'::jsonb)) as extra(effect)
    where extra.effect ->> 'effect_type' = 'status'
      and extra.effect ->> 'attribute_key' = _attribute_key

    union all

    select
      coalesce(extra.effect ->> 'polarity', 'buff'),
      coalesce(extra.effect ->> 'value_mode', 'fixed'),
      coalesce(nullif(extra.effect ->> 'amount', '')::numeric, 0)
    from jsonb_array_elements(coalesce(_extra_passive_effects, '[]'::jsonb)) as extra(effect)
    where extra.effect ->> 'effect_type' = 'status'
      and extra.effect ->> 'attribute_key' = _attribute_key
  ) as modifiers;

  return greatest(
    case when _attribute_key = 'hp' then 1 else 0 end,
    floor((_base_max + _fixed_modifier) * (1 + _percent_modifier / 100))
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.choose_character_class(_character_id uuid, _class_id uuid, _custom_modifiers jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _is_master boolean := public.has_role(auth.uid(), 'master');
  _item record;
  _value numeric;
  _clean_modifiers jsonb := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;

  IF _custom_modifiers IS NULL OR jsonb_typeof(_custom_modifiers) <> 'object' THEN
    RAISE EXCEPTION 'Os bônus personalizados da classe devem ser um objeto JSON';
  END IF;

  -- The class picker sends {} when a regular player chooses their class.
  -- Only the master may assign character-specific stat bonuses.
  IF NOT _is_master AND _custom_modifiers <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Apenas o mestre pode definir bônus extras da classe';
  END IF;

  FOR _item IN SELECT key, value FROM jsonb_each(_custom_modifiers)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.attribute_definitions ad
      WHERE ad.key = _item.key AND ad.key <> 'hp'
    ) THEN
      RAISE EXCEPTION 'Atributo inválido para bônus extra da classe: %', _item.key;
    END IF;

    IF jsonb_typeof(_item.value) <> 'number' THEN
      RAISE EXCEPTION 'O bônus de % precisa ser um número inteiro', _item.key;
    END IF;
    _value := (_item.value #>> '{}')::numeric;
    IF _value < 0 OR _value > 1000000 OR trunc(_value) <> _value THEN
      RAISE EXCEPTION 'O bônus de % precisa ser um inteiro de 0 a 1.000.000', _item.key;
    END IF;

    IF _value > 0 THEN
      _clean_modifiers := _clean_modifiers || jsonb_build_object(_item.key, _value);
    END IF;
  END LOOP;

  -- Preserve existing class-change authorization, attribute point grants,
  -- class-related abilities/effects, and HP adjustments.
  PERFORM public.choose_character_class(_character_id, _class_id);

  -- Do not allow an ordinary player to overwrite custom bonuses.
  IF _is_master THEN
    UPDATE public.characters
    SET class_custom_modifiers =
      CASE WHEN _class_id IS NULL THEN '{}'::jsonb ELSE _clean_modifiers END
    WHERE id = _character_id
      AND class_custom_modifiers IS DISTINCT FROM
        CASE WHEN _class_id IS NULL THEN '{}'::jsonb ELSE _clean_modifiers END;
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.refresh_character_mana_for_no_mana(_character_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _base_max integer;
BEGIN
  IF public.character_has_no_mana(_character_id) THEN
    -- Preserve the original Sem Mana behavior, avoiding redundant updates.
    UPDATE public.character_attributes
    SET current_value = 0,
        max_value = 0,
        updated_at = now()
    WHERE character_id = _character_id AND attribute_key = 'mana'
      AND (current_value IS DISTINCT FROM 0 OR max_value IS DISTINCT FROM 0);
    RETURN;
  END IF;

  -- This is the stored *base* maximum, not the effective maximum with
  -- temporary status effects. Those effects are already accounted for by
  -- calculate_character_resource_max / scale_character_resource_current.
  SELECT GREATEST(0, ROUND(
    COALESCE(ad.base_value, 0)
      + (ca.points
         + COALESCE((r.modifiers->>'mana')::numeric, 0)
         + COALESCE((v.modifiers->>'mana')::numeric, 0)
         + COALESCE((cl.modifiers->>'mana')::numeric, 0)
         + CASE WHEN c.class_id IS NOT NULL
             THEN COALESCE((c.class_custom_modifiers->>'mana')::numeric,0)
             ELSE 0 END)
          * COALESCE(ad.points_multiplier, 1)
      + ca.bonus
  ))::integer
  INTO _base_max
  FROM public.character_attributes ca
  JOIN public.attribute_definitions ad ON ad.key = ca.attribute_key
  JOIN public.characters c ON c.id = ca.character_id
  LEFT JOIN public.races r ON r.id = c.race_id
  LEFT JOIN public.virtues v ON v.id = c.virtue_id
  LEFT JOIN public.classes cl ON cl.id = c.class_id
  WHERE ca.character_id = _character_id AND ca.attribute_key = 'mana';

  IF _base_max IS NOT NULL THEN
    -- Do not change current_value or cap it to _base_max. On INSERT/DELETE of
    -- status effects, the resource-scaling trigger runs later in the same
    -- statement and needs the pre-change current value to preserve the ratio.
    -- Skip unchanged base maxima so unrelated buffs never touch Mana.
    UPDATE public.character_attributes
    SET max_value = _base_max, updated_at = now()
    WHERE character_id = _character_id AND attribute_key = 'mana'
      AND max_value IS DISTINCT FROM _base_max;
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.scale_mana_on_class_modifier_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _old_class_points numeric := 0;
  _new_class_points numeric := 0;
  _point_multiplier numeric := 50;
  _delta numeric := 0;
  _previous_max numeric;
  _current_max numeric;
  _extra_effects jsonb;
BEGIN
  IF OLD.class_id IS NOT DISTINCT FROM NEW.class_id
     AND OLD.class_custom_modifiers IS NOT DISTINCT FROM NEW.class_custom_modifiers THEN
    RETURN NEW;
  END IF;
  IF OLD.class_id IS NOT NULL THEN
    SELECT COALESCE(NULLIF(cl.modifiers->>'mana','')::numeric,0)
    INTO _old_class_points FROM public.classes cl WHERE cl.id=OLD.class_id;
    _old_class_points := COALESCE(_old_class_points,0)
      + COALESCE(NULLIF(OLD.class_custom_modifiers->>'mana','')::numeric,0);
  END IF;
  IF NEW.class_id IS NOT NULL THEN
    SELECT COALESCE(NULLIF(cl.modifiers->>'mana','')::numeric,0)
    INTO _new_class_points FROM public.classes cl WHERE cl.id=NEW.class_id;
    _new_class_points := COALESCE(_new_class_points,0)
      + COALESCE(NULLIF(NEW.class_custom_modifiers->>'mana','')::numeric,0);
  END IF;
  SELECT COALESCE(ad.points_multiplier,50) INTO _point_multiplier
  FROM public.attribute_definitions ad WHERE ad.key='mana';

  _delta := (_new_class_points - _old_class_points) * COALESCE(_point_multiplier,50);
  IF public.character_has_no_mana(NEW.id) THEN
    PERFORM public.refresh_character_mana_for_no_mana(NEW.id);
    RETURN NEW;
  END IF;

  IF _delta <> 0 THEN
    _current_max := public.calculate_character_resource_max(NEW.id,'mana');
    _extra_effects := jsonb_build_array(jsonb_build_object(
      'effect_type','status','attribute_key','mana',
      'polarity', CASE WHEN _delta>0 THEN 'debuff' ELSE 'buff' END,
      'value_mode','fixed','amount',abs(_delta)
    ));
    _previous_max := public.calculate_character_resource_max(
      NEW.id,'mana',NULL::uuid,NULL::uuid,_extra_effects,'[]'::jsonb
    );
    PERFORM public.scale_character_resource_current(
      NEW.id,'mana',_previous_max,_current_max
    );
  END IF;

  -- max_value is the stored base maximum, without temporary buffs.
  -- Keeping it in sync also keeps regeneration and external consumers correct.
  PERFORM public.refresh_character_mana_for_no_mana(NEW.id);
  RETURN NEW;
END;
$function$
;
DROP TRIGGER IF EXISTS zz_scale_mana_on_class_modifier_change ON public.characters;
CREATE TRIGGER zz_scale_mana_on_class_modifier_change
AFTER UPDATE OF class_id, class_custom_modifiers ON public.characters
FOR EACH ROW EXECUTE FUNCTION public.scale_mana_on_class_modifier_change();
REVOKE ALL ON FUNCTION public.scale_mana_on_class_modifier_change()
  FROM PUBLIC, anon, authenticated;
NOTIFY pgrst, 'reload schema';
