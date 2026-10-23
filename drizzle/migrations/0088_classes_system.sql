
-- Class system: independent race-like templates, selection, point budgets,
-- attributes, abilities, transformations and permanent starting effects.
-- The database migration was first applied live and this file mirrors that schema.

CREATE TABLE IF NOT EXISTS public.classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  bonus_points integer NOT NULL DEFAULT 0 CHECK (bonus_points >= 0),
  physical_bonus_points integer NOT NULL DEFAULT 0 CHECK (physical_bonus_points >= 0),
  modifiers jsonb NOT NULL DEFAULT '{}'::jsonb,
  starting_effects jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(starting_effects) = 'array'),
  special_mechanics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.classes TO authenticated;
GRANT ALL ON public.classes TO service_role;
ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "classes readable" ON public.classes;
CREATE POLICY "classes readable" ON public.classes FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "master manages classes" ON public.classes;
CREATE POLICY "master manages classes" ON public.classes FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master'))
  WITH CHECK (public.has_role(auth.uid(), 'master'));

CREATE TABLE IF NOT EXISTS public.class_abilities (
  class_id uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  ability_id uuid NOT NULL REFERENCES public.abilities(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, ability_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_abilities TO authenticated;
ALTER TABLE public.class_abilities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "class abilities readable" ON public.class_abilities;
CREATE POLICY "class abilities readable" ON public.class_abilities FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "master manages class abilities" ON public.class_abilities;
CREATE POLICY "master manages class abilities" ON public.class_abilities FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master'))
  WITH CHECK (public.has_role(auth.uid(), 'master'));

CREATE TABLE IF NOT EXISTS public.class_transformations (
  class_id uuid NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  transformation_id uuid NOT NULL REFERENCES public.transformations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, transformation_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.class_transformations TO authenticated;
ALTER TABLE public.class_transformations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "class transformations readable" ON public.class_transformations;
CREATE POLICY "class transformations readable" ON public.class_transformations FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "master manages class transformations" ON public.class_transformations;
CREATE POLICY "master manages class transformations" ON public.class_transformations FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master'))
  WITH CHECK (public.has_role(auth.uid(), 'master'));

ALTER TABLE public.characters
  ADD COLUMN IF NOT EXISTS class_id uuid REFERENCES public.classes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS class_points_granted integer NOT NULL DEFAULT 0 CHECK (class_points_granted >= 0),
  ADD COLUMN IF NOT EXISTS class_physical_points_granted integer NOT NULL DEFAULT 0 CHECK (class_physical_points_granted >= 0),
  ADD COLUMN IF NOT EXISTS class_attribute_allocations jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS class_physical_allocations jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.character_abilities
  ADD COLUMN IF NOT EXISTS granted_by_class_id uuid REFERENCES public.classes(id) ON DELETE SET NULL;

ALTER TABLE public.battle_effects
  ADD COLUMN IF NOT EXISTS source_class_id uuid REFERENCES public.classes(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS source_class_effect_index integer;
ALTER TABLE public.battle_effects DROP CONSTRAINT IF EXISTS battle_effects_class_effect_source_check;
ALTER TABLE public.battle_effects ADD CONSTRAINT battle_effects_class_effect_source_check CHECK (
  (source_class_id IS NULL AND source_class_effect_index IS NULL)
  OR (source_class_id IS NOT NULL AND source_class_effect_index IS NOT NULL AND source_class_effect_index >= 0)
);
ALTER TABLE public.battle_effects DROP CONSTRAINT IF EXISTS battle_effects_class_effect_key;
ALTER TABLE public.battle_effects ADD CONSTRAINT battle_effects_class_effect_key
  UNIQUE (character_id, source_class_id, source_class_effect_index);
DROP POLICY IF EXISTS "players read own class effects" ON public.battle_effects;
CREATE POLICY "players read own class effects" ON public.battle_effects FOR SELECT TO authenticated USING (
  source_class_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.characters c
    WHERE c.id = battle_effects.character_id AND c.owner_id = auth.uid()
  )
);

CREATE OR REPLACE FUNCTION public.activate_character_transformation(_character_id uuid, _transformation_id uuid, _battle_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _character public.characters;
  _transformation public.transformations;
  _state public.character_transformations;
  _master boolean := public.has_role(auth.uid(),'master');
  _available boolean := false;
  _mana_current integer;
  _mana_max integer;
  _group_id uuid := gen_random_uuid();
  _mod record;
  _delta integer;
  _before integer;
  _after integer;
  _applied_body integer := 0;
  _applied_sanity integer := 0;
  _applied_modifiers jsonb := '{}'::jsonb;
  _old_hp_max numeric;
  _old_mana_max numeric;
  _new_hp_max numeric;
  _new_mana_max numeric;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  SELECT * INTO _character FROM public.characters WHERE id=_character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;
  IF NOT _master AND _character.owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Só o dono da ficha pode ativar esta transformação';
  END IF;

  SELECT * INTO _transformation FROM public.transformations WHERE id=_transformation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transformação não encontrada'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.race_transformations rt WHERE rt.race_id=_character.race_id AND rt.transformation_id=_transformation_id
    UNION ALL
    SELECT 1 FROM public.virtue_transformations vt WHERE vt.virtue_id=_character.virtue_id AND vt.transformation_id=_transformation_id
    UNION ALL
    SELECT 1 FROM public.class_transformations ct WHERE ct.class_id=_character.class_id AND ct.transformation_id=_transformation_id
    UNION ALL
    SELECT 1 FROM public.transformations t WHERE t.id=_transformation_id AND t.owner_character_id=_character_id
  ) INTO _available;
  IF NOT _available AND NOT _master THEN
    RAISE EXCEPTION 'Esta transformação não pertence ao personagem nem foi concedida pela raça ou virtude';
  END IF;

  IF _battle_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.battles b JOIN public.battle_participants bp ON bp.battle_id=b.id
    WHERE b.id=_battle_id AND b.active IS TRUE AND bp.character_id=_character_id
  ) THEN
    RAISE EXCEPTION 'O personagem precisa estar em uma batalha ativa para se transformar';
  END IF;

  IF EXISTS (SELECT 1 FROM public.character_transformations ct WHERE ct.character_id=_character_id AND ct.active) THEN
    RAISE EXCEPTION 'O personagem já está transformado';
  END IF;

  SELECT * INTO _state FROM public.character_transformations
  WHERE character_id=_character_id AND transformation_id=_transformation_id FOR UPDATE;
  IF FOUND AND _state.cooldown_remaining>0 THEN
    RAISE EXCEPTION 'Transformação em cooldown: faltam % turno(s)',_state.cooldown_remaining;
  END IF;

  IF _transformation.mana_cost>0 THEN
    IF public.character_has_no_mana(_character_id) THEN RAISE EXCEPTION 'O personagem está sem acesso à Mana'; END IF;
    SELECT current_value INTO _mana_current FROM public.character_attributes
    WHERE character_id=_character_id AND attribute_key='mana' FOR UPDATE;
    _mana_max := public.calculate_character_resource_max(_character_id,'mana')::integer;
    IF COALESCE(_mana_current,0)<_transformation.mana_cost THEN
      RAISE EXCEPTION 'Mana insuficiente: necessário %, disponível %',_transformation.mana_cost,COALESCE(_mana_current,0);
    END IF;
    UPDATE public.character_attributes SET current_value=GREATEST(0,current_value-_transformation.mana_cost),updated_at=now()
    WHERE character_id=_character_id AND attribute_key='mana';
  END IF;

  -- Snapshot maxima before the transformation changes direct attribute bonuses.
  _old_hp_max := public.calculate_character_resource_max(_character_id, 'hp');
  _old_mana_max := public.calculate_character_resource_max(_character_id, 'mana');

  FOR _mod IN SELECT key,value FROM jsonb_each_text(COALESCE(_transformation.modifiers,'{}'::jsonb))
  LOOP
    IF COALESCE(_mod.value,'') !~ '^-?[0-9]+([.][0-9]+)?$' THEN RAISE EXCEPTION 'Modificador inválido: %',_mod.key; END IF;
    _delta := ROUND(_mod.value::numeric)::integer;
    IF _delta < -1000000 OR _delta > 1000000 THEN RAISE EXCEPTION 'Modificador fora do limite: %',_mod.key; END IF;

    IF _mod.key='body' THEN
      SELECT body INTO _before FROM public.characters WHERE id=_character_id;
      UPDATE public.characters SET body=GREATEST(0,LEAST(100,body+_delta)),updated_at=now()
      WHERE id=_character_id RETURNING body INTO _after;
      _applied_body := _after-_before;
    ELSIF _mod.key='sanity' THEN
      SELECT sanity INTO _before FROM public.characters WHERE id=_character_id;
      UPDATE public.characters SET sanity=GREATEST(0,LEAST(100,sanity+_delta)),updated_at=now()
      WHERE id=_character_id RETURNING sanity INTO _after;
      _applied_sanity := _after-_before;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM public.attribute_definitions WHERE key=_mod.key) THEN
        RAISE EXCEPTION 'Atributo desconhecido na transformação: %',_mod.key;
      END IF;
      UPDATE public.character_attributes
      SET bonus=bonus+_delta,updated_at=now()
      WHERE character_id=_character_id AND attribute_key=_mod.key;
      IF NOT FOUND THEN RAISE EXCEPTION 'Atributo % não existe na ficha',_mod.key; END IF;
      _applied_modifiers := _applied_modifiers || jsonb_build_object(_mod.key,_delta);
    END IF;
  END LOOP;

  -- Keep the same current/max ratio when direct transformation modifiers change HP/Mana max.
  _new_hp_max := public.calculate_character_resource_max(_character_id, 'hp');
  _new_mana_max := public.calculate_character_resource_max(_character_id, 'mana');
  PERFORM public.scale_character_resource_current(_character_id, 'hp', _old_hp_max, _new_hp_max);
  PERFORM public.scale_character_resource_current(_character_id, 'mana', _old_mana_max, _new_mana_max);

  INSERT INTO public.character_transformations(
    character_id,transformation_id,cooldown_remaining,active_duration_remaining,active,active_battle_id,
    active_effect_group_id,applied_attribute_modifiers,applied_body_delta,applied_sanity_delta,activated_at,updated_at
  ) VALUES (
    _character_id,_transformation_id,_transformation.cooldown_turns,_transformation.duration_turns,true,_battle_id,
    _group_id,_applied_modifiers,_applied_body,_applied_sanity,now(),now()
  )
  ON CONFLICT (character_id,transformation_id) DO UPDATE SET
    cooldown_remaining=EXCLUDED.cooldown_remaining,active_duration_remaining=EXCLUDED.active_duration_remaining,active=true,active_battle_id=EXCLUDED.active_battle_id,
    active_effect_group_id=EXCLUDED.active_effect_group_id,applied_attribute_modifiers=EXCLUDED.applied_attribute_modifiers,
    applied_body_delta=EXCLUDED.applied_body_delta,applied_sanity_delta=EXCLUDED.applied_sanity_delta,
    activated_at=now(),updated_at=now();

  PERFORM public.apply_character_transformation_effects(
    _character_id,_battle_id,_transformation_id,COALESCE(_transformation.effects,'[]'::jsonb),
    _group_id,false,_transformation.duration_turns
  );

  FOR _mod IN SELECT unnest(ARRAY['hp','mana']) AS key
  LOOP
    UPDATE public.character_attributes ca
    SET current_value=LEAST(ca.current_value,public.calculate_character_resource_max(_character_id,_mod.key)::integer),
        updated_at=now()
    WHERE ca.character_id=_character_id AND ca.attribute_key=_mod.key;
  END LOOP;

  RETURN jsonb_build_object('ok',true,'transformation_id',_transformation_id,'cooldown_remaining',_transformation.cooldown_turns,'duration_remaining',_transformation.duration_turns);
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_class_condition_modifier_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE ob integer; nb integer; os integer; ns integer;
BEGIN ob:=COALESCE((OLD.modifiers->>'body')::integer,0); nb:=COALESCE((NEW.modifiers->>'body')::integer,0); os:=COALESCE((OLD.modifiers->>'sanity')::integer,0); ns:=COALESCE((NEW.modifiers->>'sanity')::integer,0);
 UPDATE public.characters SET body=GREATEST(0,LEAST(100,body-ob+nb)),sanity=GREATEST(0,LEAST(100,sanity-os+ns)),updated_at=now() WHERE class_id=NEW.id AND (ob<>nb OR os<>ns); RETURN NEW; END $function$;

CREATE OR REPLACE FUNCTION public.apply_racial_virtue_effect_scaling()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _base public.abilities%ROWTYPE; _race_mechanics jsonb:='{}'::jsonb; _class_mechanics jsonb:='{}'::jsonb; _multiplier numeric:=1;
BEGIN
 IF NEW.ability_id IS NULL OR NEW.granted_by_virtue_id IS NULL THEN RETURN NEW; END IF;
 SELECT a.* INTO _base FROM public.abilities a WHERE a.id=NEW.ability_id; IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT COALESCE(r.special_mechanics,'{}'::jsonb),COALESCE(cl.special_mechanics,'{}'::jsonb) INTO _race_mechanics,_class_mechanics
 FROM public.characters c LEFT JOIN public.races r ON r.id=c.race_id LEFT JOIN public.classes cl ON cl.id=c.class_id WHERE c.id=NEW.character_id;
 IF COALESCE((_race_mechanics->>'duplicate_virtue_effects')::boolean,false) AND NOT COALESCE((_race_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(NEW.granted_by_virtue_id::text),false)
 THEN _multiplier:=_multiplier*GREATEST(1,LEAST(10,COALESCE(NULLIF(_race_mechanics->>'virtue_effect_multiplier','')::numeric,2))); END IF;
 IF COALESCE((_class_mechanics->>'duplicate_virtue_effects')::boolean,false) AND NOT COALESCE((_class_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(NEW.granted_by_virtue_id::text),false)
 THEN _multiplier:=_multiplier*GREATEST(1,LEAST(10,COALESCE(NULLIF(_class_mechanics->>'virtue_effect_multiplier','')::numeric,2))); END IF;
 _multiplier:=GREATEST(1,LEAST(100,_multiplier));
 IF _multiplier>1 THEN
  NEW.effects:=public.scale_racial_virtue_effect_json(COALESCE(_base.effects,'[]'::jsonb),_multiplier);
  NEW.passive_effects:=public.scale_racial_virtue_effect_json(COALESCE(_base.passive_effects,'[]'::jsonb),_multiplier);
  NEW.end_effects:=public.scale_racial_virtue_effect_json(COALESCE(_base.end_effects,'[]'::jsonb),_multiplier);
 ELSE NEW.effects:=COALESCE(_base.effects,'[]'::jsonb); NEW.passive_effects:=COALESCE(_base.passive_effects,'[]'::jsonb); NEW.end_effects:=COALESCE(_base.end_effects,'[]'::jsonb);
 END IF; RETURN NEW;
END $function$;

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
$function$;

CREATE OR REPLACE FUNCTION public.choose_character_class(_character_id uuid, _class_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _c public.characters; _bonus integer:=0; _physical integer:=0; _ob integer:=0; _os integer:=0; _nb integer:=0; _ns integer:=0; _new_hp integer; _master boolean:=public.has_role(auth.uid(),'master');
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
 SELECT * INTO _c FROM public.characters WHERE id=_character_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;
 IF NOT _master THEN
  IF _c.owner_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Sem permissão'; END IF;
  IF _class_id IS NULL THEN RAISE EXCEPTION 'Escolha uma classe'; END IF;
  IF _c.class_id IS NOT NULL AND _c.class_id IS DISTINCT FROM _class_id THEN RAISE EXCEPTION 'A classe já foi escolhida; peça ao mestre para trocar'; END IF;
 END IF;
 IF _c.class_id IS NOT NULL THEN SELECT COALESCE((modifiers->>'body')::integer,0),COALESCE((modifiers->>'sanity')::integer,0) INTO _ob,_os FROM public.classes WHERE id=_c.class_id; END IF;
 IF _class_id IS NOT NULL THEN SELECT bonus_points,physical_bonus_points,COALESCE((modifiers->>'body')::integer,0),COALESCE((modifiers->>'sanity')::integer,0) INTO _bonus,_physical,_nb,_ns FROM public.classes WHERE id=_class_id; IF NOT FOUND THEN RAISE EXCEPTION 'Classe não encontrada'; END IF; END IF;
 UPDATE public.characters SET class_id=_class_id,body=GREATEST(0,LEAST(100,_c.body-_ob+_nb)),sanity=GREATEST(0,LEAST(100,_c.sanity-_os+_ns)),
 available_points=GREATEST(0,available_points-COALESCE(class_points_granted,0)+_bonus),class_points_granted=_bonus,class_physical_points_granted=_physical WHERE id=_character_id;
 IF _c.class_id IS DISTINCT FROM _class_id THEN
  _new_hp:=public.calculate_character_resource_max(_character_id,'hp')::integer;
  UPDATE public.character_attributes SET current_value=_new_hp,updated_at=now() WHERE character_id=_character_id AND attribute_key='hp';
  IF NOT FOUND THEN RAISE EXCEPTION 'O atributo de HP não foi encontrado para a ficha'; END IF;
 END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.invest_physical_points_from_source(_character_id uuid, _source text, _allocations jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _c public.characters;
  _current_alloc jsonb;
  _used integer;
  _remaining integer;
  _total integer := 0;
  _key text;
  _delta integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  IF _source NOT IN ('race','virtue','class') THEN RAISE EXCEPTION 'Origem dos pontos físicos inválida'; END IF;
  IF _allocations IS NULL OR jsonb_typeof(_allocations) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Distribuição de pontos físicos inválida';
  END IF;
  SELECT * INTO _c FROM public.characters WHERE id = _character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;
  IF NOT public.has_role(auth.uid(), 'master') AND _c.owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Sem permissão';
  END IF;

  _current_alloc := CASE WHEN _source = 'race' THEN COALESCE(_c.race_physical_allocations, '{}'::jsonb)
    WHEN _source = 'virtue' THEN COALESCE(_c.virtue_physical_allocations, '{}'::jsonb)
    ELSE COALESCE(_c.class_physical_allocations, '{}'::jsonb) END;
  SELECT COALESCE(SUM(value::integer),0) INTO _used FROM jsonb_each_text(_current_alloc);
  _remaining := GREATEST(0,
    (CASE WHEN _source = 'race' THEN COALESCE(_c.race_physical_points_granted,0)
      WHEN _source = 'virtue' THEN COALESCE(_c.virtue_physical_points_granted,0)
      ELSE COALESCE(_c.class_physical_points_granted,0) END) - _used
  );

  FOR _key, _delta IN SELECT key, value::integer FROM jsonb_each_text(_allocations) LOOP
    IF _delta <= 0 THEN RAISE EXCEPTION 'Os pontos físicos precisam ser positivos'; END IF;
    IF _key NOT IN ('strength','phys_def','speed','atk_speed')
      OR NOT EXISTS (SELECT 1 FROM public.attribute_definitions WHERE key = _key AND accepts_points) THEN
      RAISE EXCEPTION 'O atributo % não aceita pontos extras físicos', _key;
    END IF;
    _total := _total + _delta;
  END LOOP;

  IF _total > _remaining THEN
    RAISE EXCEPTION 'Pontos físicos insuficientes nesta origem (disponível: %)', _remaining;
  END IF;

  FOR _key, _delta IN SELECT key, value::integer FROM jsonb_each_text(_allocations) LOOP
    _current_alloc := jsonb_set(
      _current_alloc,
      ARRAY[_key],
      to_jsonb(COALESCE((_current_alloc ->> _key)::integer,0) + _delta),
      true
    );
  END LOOP;

  IF _source = 'race' THEN
    UPDATE public.characters SET race_physical_allocations = _current_alloc WHERE id = _character_id;
  ELSIF _source = 'virtue' THEN
    UPDATE public.characters SET virtue_physical_allocations = _current_alloc WHERE id = _character_id;
  ELSE
    UPDATE public.characters SET class_physical_allocations = _current_alloc WHERE id = _character_id;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.invest_points_from_source(_character_id uuid, _source text, _allocations jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _c public.characters;
  _race_alloc jsonb;
  _virtue_alloc jsonb;
  _class_alloc jsonb;
  _race_left integer;
  _virtue_left integer;
  _class_left integer;
  _base_left integer;
  _source_left integer;
  _available integer;
  _total integer := 0;
  _positive integer := 0;
  _key text;
  _delta integer;
  _current integer;
  _owned integer;
  _take integer;
  _used integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  IF _source NOT IN ('race','virtue','class','base') THEN RAISE EXCEPTION 'Origem dos pontos inválida'; END IF;
  IF _allocations IS NULL OR jsonb_typeof(_allocations) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Distribuição de pontos inválida';
  END IF;

  SELECT * INTO _c FROM public.characters WHERE id = _character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;
  IF NOT public.has_role(auth.uid(), 'master') AND _c.owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Sem permissão';
  END IF;

  _race_alloc := COALESCE(_c.race_attribute_allocations, '{}'::jsonb);
  _virtue_alloc := COALESCE(_c.virtue_attribute_allocations, '{}'::jsonb);
  _class_alloc := COALESCE(_c.class_attribute_allocations, '{}'::jsonb);
  SELECT COALESCE(SUM(value::integer),0) INTO _used FROM jsonb_each_text(_race_alloc);
  _race_left := GREATEST(0, COALESCE(_c.race_points_granted,0) - _used);
  SELECT COALESCE(SUM(value::integer),0) INTO _used FROM jsonb_each_text(_virtue_alloc);
  _virtue_left := GREATEST(0, COALESCE(_c.virtue_points_granted,0) - _used);
  SELECT COALESCE(SUM(value::integer),0) INTO _used FROM jsonb_each_text(_class_alloc);
  _class_left := GREATEST(0, COALESCE(_c.class_points_granted,0) - _used);
  _base_left := GREATEST(0, COALESCE(_c.available_points,0) - _race_left - _virtue_left - _class_left);
  _source_left := CASE _source WHEN 'race' THEN _race_left WHEN 'virtue' THEN _virtue_left WHEN 'class' THEN _class_left ELSE _base_left END;
  _available := COALESCE(_c.available_points,0);

  -- Point removals are master-only and may remove only points belonging to the selected source.
  FOR _key, _delta IN
    SELECT key, value::integer FROM jsonb_each_text(_allocations) WHERE value::integer < 0
  LOOP
    IF NOT public.has_role(auth.uid(), 'master') THEN RAISE EXCEPTION 'Apenas o mestre pode retirar pontos'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.attribute_definitions WHERE key = _key AND accepts_points) THEN
      RAISE EXCEPTION 'O atributo % não aceita pontos', _key;
    END IF;
    SELECT COALESCE(points,0) INTO _current
    FROM public.character_attributes
    WHERE character_id = _character_id AND attribute_key = _key
    FOR UPDATE;
    _take := -_delta;
    IF _source = 'race' THEN
      _owned := COALESCE((_race_alloc ->> _key)::integer,0);
      IF _take > _owned THEN RAISE EXCEPTION 'A raça não possui % ponto(s) investido(s) em %', _take, _key; END IF;
      IF _take = _owned THEN _race_alloc := _race_alloc - _key;
      ELSE _race_alloc := jsonb_set(_race_alloc, ARRAY[_key], to_jsonb(_owned - _take), true); END IF;
    ELSIF _source = 'virtue' THEN
      _owned := COALESCE((_virtue_alloc ->> _key)::integer,0);
      IF _take > _owned THEN RAISE EXCEPTION 'A virtude não possui % ponto(s) investido(s) em %', _take, _key; END IF;
      IF _take = _owned THEN _virtue_alloc := _virtue_alloc - _key;
      ELSE _virtue_alloc := jsonb_set(_virtue_alloc, ARRAY[_key], to_jsonb(_owned - _take), true); END IF;
    ELSIF _source = 'class' THEN
      _owned := COALESCE((_class_alloc ->> _key)::integer,0);
      IF _take > _owned THEN RAISE EXCEPTION 'A classe não possui % ponto(s) investido(s) em %', _take, _key; END IF;
      IF _take = _owned THEN _class_alloc := _class_alloc - _key;
      ELSE _class_alloc := jsonb_set(_class_alloc, ARRAY[_key], to_jsonb(_owned - _take), true); END IF;
    ELSE
      _owned := GREATEST(0, COALESCE(_current,0)
        - COALESCE((_race_alloc ->> _key)::integer,0)
        - COALESCE((_virtue_alloc ->> _key)::integer,0));
      IF _take > _owned THEN RAISE EXCEPTION 'Os pontos livres não possuem % ponto(s) investido(s) em %', _take, _key; END IF;
    END IF;
    IF COALESCE(_current,0) < _take THEN RAISE EXCEPTION 'Pontos investidos insuficientes em %', _key; END IF;
    UPDATE public.character_attributes SET points = points + _delta
    WHERE character_id = _character_id AND attribute_key = _key;
    _total := _total + _delta;
  END LOOP;

  -- Positive allocations consume only the currently selected source.
  SELECT COALESCE(SUM(value::integer),0) INTO _used FROM jsonb_each_text(_race_alloc);
  _race_left := GREATEST(0, COALESCE(_c.race_points_granted,0) - _used);
  SELECT COALESCE(SUM(value::integer),0) INTO _used FROM jsonb_each_text(_virtue_alloc);
  _virtue_left := GREATEST(0, COALESCE(_c.virtue_points_granted,0) - _used);
  SELECT COALESCE(SUM(value::integer),0) INTO _used FROM jsonb_each_text(_class_alloc);
  _class_left := GREATEST(0, COALESCE(_c.class_points_granted,0) - _used);
  _base_left := GREATEST(0, _available - _total - _race_left - _virtue_left - _class_left);
  _source_left := CASE _source WHEN 'race' THEN _race_left WHEN 'virtue' THEN _virtue_left WHEN 'class' THEN _class_left ELSE _base_left END;

  FOR _key, _delta IN
    SELECT key, value::integer FROM jsonb_each_text(_allocations) WHERE value::integer > 0
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.attribute_definitions WHERE key = _key AND accepts_points) THEN
      RAISE EXCEPTION 'O atributo % não aceita pontos', _key;
    END IF;
    _positive := _positive + _delta;
    _total := _total + _delta;
  END LOOP;
  IF _positive > _source_left THEN
    RAISE EXCEPTION 'Pontos insuficientes nesta origem (disponível: %)', _source_left;
  END IF;
  IF _total > _available THEN
    RAISE EXCEPTION 'Pontos insuficientes (disponível: %)', _available;
  END IF;

  FOR _key, _delta IN
    SELECT key, value::integer FROM jsonb_each_text(_allocations) WHERE value::integer > 0
  LOOP
    INSERT INTO public.character_attributes (character_id, attribute_key, points)
    VALUES (_character_id, _key, _delta)
    ON CONFLICT (character_id, attribute_key) DO UPDATE
      SET points = public.character_attributes.points + EXCLUDED.points;
    IF _source = 'race' THEN
      _race_alloc := jsonb_set(_race_alloc, ARRAY[_key],
        to_jsonb(COALESCE((_race_alloc ->> _key)::integer,0) + _delta), true);
    ELSIF _source = 'virtue' THEN
      _virtue_alloc := jsonb_set(_virtue_alloc, ARRAY[_key], to_jsonb(COALESCE((_virtue_alloc ->> _key)::integer,0) + _delta), true);
    ELSIF _source = 'class' THEN
      _class_alloc := jsonb_set(_class_alloc, ARRAY[_key], to_jsonb(COALESCE((_class_alloc ->> _key)::integer,0) + _delta), true);
    END IF;
  END LOOP;

  UPDATE public.characters
  SET available_points = available_points - _total,
      race_attribute_allocations = _race_alloc,
      virtue_attribute_allocations = _virtue_alloc,
      class_attribute_allocations = _class_alloc
  WHERE id = _character_id;

  UPDATE public.character_attributes ca
  SET max_value = GREATEST(0, ROUND(COALESCE(ad.base_value,0) + ca.points * COALESCE(ad.points_multiplier,1)))::integer,
      current_value = CASE
        WHEN ad.cap_current AND ca.current_value > GREATEST(0, ROUND(COALESCE(ad.base_value,0) + ca.points * COALESCE(ad.points_multiplier,1)))::integer
        THEN GREATEST(0, ROUND(COALESCE(ad.base_value,0) + ca.points * COALESCE(ad.points_multiplier,1)))::integer
        ELSE ca.current_value END
  FROM public.attribute_definitions ad
  WHERE ca.character_id = _character_id AND ad.key = ca.attribute_key AND ad.accepts_points;
END;
$function$;

CREATE OR REPLACE FUNCTION public.on_class_abilities_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE cid uuid; target uuid;
BEGIN cid:=CASE WHEN TG_OP='DELETE' THEN OLD.class_id ELSE NEW.class_id END;
 IF TG_OP='UPDATE' AND OLD.class_id IS DISTINCT FROM NEW.class_id THEN FOR target IN SELECT id FROM public.characters WHERE class_id=OLD.class_id LOOP PERFORM public.sync_character_trait_abilities(target); END LOOP; END IF;
 FOR target IN SELECT id FROM public.characters WHERE class_id=cid LOOP PERFORM public.sync_character_trait_abilities(target); END LOOP;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $function$;

CREATE OR REPLACE FUNCTION public.on_class_transformations_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE cid uuid; BEGIN cid:=CASE WHEN TG_OP='DELETE' THEN OLD.class_id ELSE NEW.class_id END; UPDATE public.characters SET updated_at=now() WHERE class_id=cid; RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $function$;

CREATE OR REPLACE FUNCTION public.preserve_class_effect_duration()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN IF OLD.source_class_id IS NOT NULL AND NEW.source_class_id=OLD.source_class_id THEN NEW.duration:=OLD.duration; END IF; RETURN NEW; END $function$;

CREATE OR REPLACE FUNCTION public.sync_character_class_assignments()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN PERFORM public.sync_character_trait_abilities(NEW.id); PERFORM public.sync_character_class_effects(NEW.id); RETURN NEW; END $function$;

CREATE OR REPLACE FUNCTION public.sync_character_class_effects(_character_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _class_id uuid;
  _starting_effects jsonb := '[]'::jsonb;
  _effect jsonb;
  _effect_index integer;
  _effect_type text;
  _stored_type text;
  _attribute_key text;
  _polarity text;
  _value_mode text;
  _amount numeric;
  _damage_scope text;
  _reduction_scope text;
  _type_ids uuid[];
  _magic_levels text[];
  _effect_name text;
BEGIN
  SELECT c.class_id
  INTO _class_id
  FROM public.characters c
  WHERE c.id = _character_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Remove only effects supplied by a previous race. Ability and manual effects remain untouched.
  DELETE FROM public.battle_effects e
  WHERE e.character_id = _character_id
    AND e.source_class_id IS NOT NULL
    AND e.source_class_id IS DISTINCT FROM _class_id;

  IF _class_id IS NULL THEN
    RETURN;
  END IF;

  SELECT r.starting_effects
  INTO _starting_effects
  FROM public.classes r
  WHERE r.id = _class_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF jsonb_typeof(COALESCE(_starting_effects, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Os efeitos iniciais da raça precisam ser uma lista.';
  END IF;

  FOR _effect, _effect_index IN
    SELECT item.value, (item.ordinality - 1)::integer
    FROM jsonb_array_elements(COALESCE(_starting_effects, '[]'::jsonb))
      WITH ORDINALITY AS item(value, ordinality)
  LOOP
    _effect_type := COALESCE(NULLIF(_effect ->> 'effect_type', ''), 'status');
    IF _effect_type NOT IN (
      'status', 'regeneration', 'mana_regeneration', 'mana_used',
      'no_regen_hp', 'no_regen_mana', 'magic_prohibition', 'stun',
      'damage_dealt', 'no_mana', 'damage_reduction', 'damage_received', 'invincible', 'healing_blocked', 'magic_healing_reversal'
    ) THEN
      RAISE EXCEPTION 'Tipo de efeito da classe inválido: %', _effect_type;
    END IF;

    -- Mana regeneration uses the existing battle-effect regeneration implementation.
    _stored_type := CASE WHEN _effect_type = 'mana_regeneration' THEN 'regeneration' WHEN _effect_type = 'magic_healing_reversal' THEN 'healing_blocked' ELSE _effect_type END;
    _attribute_key := CASE
      WHEN _stored_type = 'status' THEN NULLIF(_effect ->> 'attribute_key', '')
      WHEN _stored_type = 'regeneration' THEN
        CASE WHEN _effect_type = 'mana_regeneration' THEN 'mana' ELSE NULLIF(_effect ->> 'attribute_key', '') END
      ELSE NULL
    END;
    IF _stored_type = 'status' AND _attribute_key IS NULL THEN
      RAISE EXCEPTION 'Efeito da classe de status precisa escolher um atributo.';
    END IF;
    IF _stored_type = 'regeneration' AND _attribute_key NOT IN ('hp', 'mana') THEN
      RAISE EXCEPTION 'Efeito da classe de regeneração precisa usar HP ou Mana.';
    END IF;

    _polarity := CASE
      WHEN _stored_type IN ('magic_prohibition', 'no_mana', 'healing_blocked', 'damage_received') OR _effect_type = 'magic_healing_reversal' THEN 'debuff'
      WHEN _stored_type IN ('damage_reduction', 'invincible') THEN 'buff'
      ELSE COALESCE(NULLIF(_effect ->> 'polarity', ''), 'buff')
    END;
    _value_mode := CASE WHEN _effect ->> 'value_mode' = 'percent' THEN 'percent' ELSE 'fixed' END;
    _amount := GREATEST(0, COALESCE(NULLIF(_effect ->> 'amount', '')::numeric, 0));
    _damage_scope := CASE WHEN _effect ->> 'damage_scope' IN ('physical', 'magical') THEN _effect ->> 'damage_scope' ELSE 'any' END;
    _reduction_scope := CASE WHEN _effect ->> 'damage_reduction_scope' = 'magical' THEN 'magical' ELSE 'physical' END;
    _effect_name := LEFT(COALESCE(NULLIF(BTRIM(_effect ->> 'name'), ''), 'Efeito da classe'), 160);
    IF _effect_type = 'magic_healing_reversal' THEN
      IF COALESCE(NULLIF(_effect->>'magic_healing_reversal_damage_mode', ''), 'healing_amount') NOT IN ('healing_amount', 'custom', 'both') THEN
        RAISE EXCEPTION 'Modo de dano da Reversão de Cura inválido';
      END IF;
      IF COALESCE(NULLIF(_effect->>'magic_healing_reversal_custom_damage', '')::numeric, 0) < 0 OR COALESCE(NULLIF(_effect->>'magic_healing_reversal_custom_damage', '')::numeric, 0) > 1000000 THEN
        RAISE EXCEPTION 'Dano customizado da Reversão de Cura deve ficar entre 0 e 1000000';
      END IF;
    END IF;
    IF _effect_type = 'damage_received' THEN
      IF COALESCE(NULLIF(_effect->>'damage_received_scope', ''), 'any') NOT IN ('any', 'physical', 'magical', 'race') THEN
        RAISE EXCEPTION 'Categoria de Dano Recebido da classe inválida';
      END IF;
      IF _amount > 1000000 THEN
        RAISE EXCEPTION 'Dano Recebido da classe deve ficar entre 0 e 1000000';
      END IF;
      IF COALESCE(NULLIF(_effect->>'damage_received_scope', ''), 'any') = 'race'
        AND (
          NULLIF(_effect->>'damage_received_race_id', '') IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.races r WHERE r.id::text = _effect->>'damage_received_race_id')
        ) THEN
        RAISE EXCEPTION 'Selecione uma raça válida para Dano Recebido racial';
      END IF;
      IF jsonb_typeof(_effect->'damage_received_type_ids') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_received_type_ids') selected(value)
        WHERE NOT EXISTS (SELECT 1 FROM public.damage_types dt WHERE dt.id::text = selected.value)
      ) THEN
        RAISE EXCEPTION 'Dano Recebido racial contém um tipo mágico inválido';
      END IF;
      IF jsonb_typeof(_effect->'damage_received_magic_levels') = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(_effect->'damage_received_magic_levels') selected(value)
        WHERE selected.value NOT IN ('baixa', 'media', 'alta')
      ) THEN
        RAISE EXCEPTION 'Dano Recebido racial contém um nível mágico inválido';
      END IF;
    END IF;
    IF _effect_type = 'magic_healing_reversal' THEN _amount := 0; END IF;

    _type_ids := NULL;
    _magic_levels := NULL;
    IF _stored_type = 'damage_reduction' AND _reduction_scope = 'magical' THEN
      IF jsonb_typeof(_effect -> 'damage_reduction_type_ids') = 'array' THEN
        SELECT COALESCE(array_agg(value::uuid), ARRAY[]::uuid[])
        INTO _type_ids
        FROM jsonb_array_elements_text(_effect -> 'damage_reduction_type_ids') AS ids(value);
      ELSE
        _type_ids := ARRAY[]::uuid[];
      END IF;

      IF jsonb_typeof(_effect -> 'damage_reduction_magic_levels') = 'array' THEN
        SELECT COALESCE(array_agg(value), ARRAY[]::text[])
        INTO _magic_levels
        FROM jsonb_array_elements_text(_effect -> 'damage_reduction_magic_levels') AS levels(value);
      ELSE
        _magic_levels := ARRAY[]::text[];
      END IF;
    END IF;

    INSERT INTO public.battle_effects (
      battle_id, character_id, name, effect_type, attribute_key, polarity, value_mode, amount,
      duration, duration_scope, damage_scope, damage_reduction_scope,
      damage_reduction_type_id, damage_reduction_magic_level,
      damage_reduction_type_ids, damage_reduction_magic_levels,
      source_character_ability_id, target_character_id, effect_data, effect_group_id,
      is_end_effect, until_combat_end, source_class_id, source_class_effect_index
    ) VALUES (
      NULL, _character_id, _effect_name, _stored_type, _attribute_key, _polarity, _value_mode, _amount,
      1, 'individual', _damage_scope, _reduction_scope,
      NULL, NULL, _type_ids, _magic_levels,
      NULL, NULL, CASE WHEN _effect_type IN ('magic_healing_reversal', 'damage_received') THEN _effect ELSE '{}'::jsonb END, NULL,
      false, false, _class_id, _effect_index
    )
    ON CONFLICT ON CONSTRAINT battle_effects_class_effect_key
    DO UPDATE SET
      name = EXCLUDED.name,
      effect_type = EXCLUDED.effect_type,
      attribute_key = EXCLUDED.attribute_key,
      polarity = EXCLUDED.polarity,
      value_mode = EXCLUDED.value_mode,
      amount = EXCLUDED.amount,
      duration = 1,
      duration_scope = EXCLUDED.duration_scope,
      damage_scope = EXCLUDED.damage_scope,
      damage_reduction_scope = EXCLUDED.damage_reduction_scope,
      damage_reduction_type_id = EXCLUDED.damage_reduction_type_id,
      damage_reduction_magic_level = EXCLUDED.damage_reduction_magic_level,
      damage_reduction_type_ids = EXCLUDED.damage_reduction_type_ids,
      damage_reduction_magic_levels = EXCLUDED.damage_reduction_magic_levels,
      target_character_id = NULL,
      effect_data = EXCLUDED.effect_data,
      effect_group_id = NULL,
      is_end_effect = false,
      until_combat_end = false;
  END LOOP;

  -- Delete removed trailing effects from the race template.
  DELETE FROM public.battle_effects e
  WHERE e.character_id = _character_id
    AND e.source_class_id = _class_id
    AND e.source_class_effect_index >= jsonb_array_length(COALESCE(_starting_effects, '[]'::jsonb));
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_character_class_effects_after_template_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE cid uuid; BEGIN FOR cid IN SELECT id FROM public.characters WHERE class_id=NEW.id LOOP PERFORM public.sync_character_class_effects(cid); END LOOP; RETURN NEW; END $function$;

CREATE OR REPLACE FUNCTION public.sync_character_class_physical_points()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.characters
  SET class_physical_points_granted = NEW.physical_bonus_points
  WHERE class_id = NEW.id
    AND class_physical_points_granted IS DISTINCT FROM NEW.physical_bonus_points;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_character_class_points()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN UPDATE public.characters SET class_points_granted=NEW.bonus_points WHERE class_id=NEW.id AND class_points_granted IS DISTINCT FROM NEW.bonus_points; RETURN NEW; END $function$;

CREATE OR REPLACE FUNCTION public.sync_character_trait_abilities(_character_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _race_id uuid; _virtue_id uuid; _class_id uuid;
BEGIN
 SELECT c.race_id,c.virtue_id,c.class_id INTO _race_id,_virtue_id,_class_id FROM public.characters c WHERE c.id=_character_id;
 IF NOT FOUND THEN RETURN; END IF;
 UPDATE public.character_abilities ca SET granted_by_class_id=_class_id,granted_by_race_id=NULL,granted_by_virtue_id=NULL
 WHERE ca.character_id=_character_id AND (ca.granted_by_class_id IS NOT NULL OR ca.granted_by_race_id IS NOT NULL OR ca.granted_by_virtue_id IS NOT NULL)
 AND _class_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.class_abilities xa WHERE xa.class_id=_class_id AND xa.ability_id=ca.ability_id);
 UPDATE public.character_abilities ca SET granted_by_class_id=NULL,granted_by_race_id=_race_id,granted_by_virtue_id=NULL
 WHERE ca.character_id=_character_id AND (ca.granted_by_class_id IS NOT NULL OR ca.granted_by_race_id IS NOT NULL OR ca.granted_by_virtue_id IS NOT NULL)
 AND _race_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.race_abilities ra WHERE ra.race_id=_race_id AND ra.ability_id=ca.ability_id)
 AND NOT EXISTS(SELECT 1 FROM public.class_abilities xa WHERE xa.class_id=_class_id AND xa.ability_id=ca.ability_id);
 UPDATE public.character_abilities ca SET granted_by_class_id=NULL,granted_by_race_id=NULL,granted_by_virtue_id=_virtue_id
 WHERE ca.character_id=_character_id AND (ca.granted_by_class_id IS NOT NULL OR ca.granted_by_race_id IS NOT NULL OR ca.granted_by_virtue_id IS NOT NULL)
 AND _virtue_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.virtue_abilities va WHERE va.virtue_id=_virtue_id AND va.ability_id=ca.ability_id)
 AND NOT EXISTS(SELECT 1 FROM public.class_abilities xa WHERE xa.class_id=_class_id AND xa.ability_id=ca.ability_id)
 AND NOT EXISTS(SELECT 1 FROM public.race_abilities ra WHERE ra.race_id=_race_id AND ra.ability_id=ca.ability_id);
 DELETE FROM public.character_abilities ca WHERE ca.character_id=_character_id
 AND (ca.granted_by_class_id IS NOT NULL OR ca.granted_by_race_id IS NOT NULL OR ca.granted_by_virtue_id IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM public.class_abilities xa WHERE xa.class_id=_class_id AND xa.ability_id=ca.ability_id)
 AND NOT EXISTS(SELECT 1 FROM public.race_abilities ra WHERE ra.race_id=_race_id AND ra.ability_id=ca.ability_id)
 AND NOT EXISTS(SELECT 1 FROM public.virtue_abilities va WHERE va.virtue_id=_virtue_id AND va.ability_id=ca.ability_id);
 INSERT INTO public.character_abilities(character_id,ability_id,name,description,can_activate,is_passive,cooldown_turns,cooldown_remaining,mana_cost,effects,passive_effects,end_effects,is_magical,self_target_only,granted_by_class_id,granted_by_race_id,granted_by_virtue_id)
 SELECT _character_id,a.id,a.name,a.description,a.can_activate,NOT a.can_activate,CASE WHEN a.can_activate THEN GREATEST(a.cooldown_turns,1) ELSE 0 END,0,CASE WHEN a.can_activate THEN a.mana_cost ELSE 0 END,a.effects,a.passive_effects,a.end_effects,a.is_magical,a.self_target_only,_class_id,NULL,NULL
 FROM public.class_abilities xa JOIN public.abilities a ON a.id=xa.ability_id WHERE xa.class_id=_class_id ON CONFLICT(character_id,ability_id) DO NOTHING;
 INSERT INTO public.character_abilities(character_id,ability_id,name,description,can_activate,is_passive,cooldown_turns,cooldown_remaining,mana_cost,effects,passive_effects,end_effects,is_magical,self_target_only,granted_by_class_id,granted_by_race_id,granted_by_virtue_id)
 SELECT _character_id,a.id,a.name,a.description,a.can_activate,NOT a.can_activate,CASE WHEN a.can_activate THEN GREATEST(a.cooldown_turns,1) ELSE 0 END,0,CASE WHEN a.can_activate THEN a.mana_cost ELSE 0 END,a.effects,a.passive_effects,a.end_effects,a.is_magical,a.self_target_only,NULL,_race_id,NULL
 FROM public.race_abilities ra JOIN public.abilities a ON a.id=ra.ability_id WHERE ra.race_id=_race_id
 AND NOT EXISTS(SELECT 1 FROM public.class_abilities xa WHERE xa.class_id=_class_id AND xa.ability_id=ra.ability_id) ON CONFLICT(character_id,ability_id) DO NOTHING;
 INSERT INTO public.character_abilities(character_id,ability_id,name,description,can_activate,is_passive,cooldown_turns,cooldown_remaining,mana_cost,effects,passive_effects,end_effects,is_magical,self_target_only,granted_by_class_id,granted_by_race_id,granted_by_virtue_id)
 SELECT _character_id,a.id,a.name,a.description,a.can_activate,NOT a.can_activate,CASE WHEN a.can_activate THEN GREATEST(a.cooldown_turns,1) ELSE 0 END,0,CASE WHEN a.can_activate THEN a.mana_cost ELSE 0 END,a.effects,a.passive_effects,a.end_effects,a.is_magical,a.self_target_only,NULL,NULL,_virtue_id
 FROM public.virtue_abilities va JOIN public.abilities a ON a.id=va.ability_id WHERE va.virtue_id=_virtue_id
 AND NOT EXISTS(SELECT 1 FROM public.class_abilities xa WHERE xa.class_id=_class_id AND xa.ability_id=va.ability_id)
 AND NOT EXISTS(SELECT 1 FROM public.race_abilities ra WHERE ra.race_id=_race_id AND ra.ability_id=va.ability_id) ON CONFLICT(character_id,ability_id) DO NOTHING;
END $function$;

CREATE OR REPLACE FUNCTION public.sync_character_transformations_with_traits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _grant record;
BEGIN
 FOR _grant IN SELECT ct.transformation_id,ct.active FROM public.character_transformations ct WHERE ct.character_id=NEW.id
 AND NOT EXISTS(SELECT 1 FROM public.race_transformations rt WHERE rt.transformation_id=ct.transformation_id AND rt.race_id=NEW.race_id)
 AND NOT EXISTS(SELECT 1 FROM public.virtue_transformations vt WHERE vt.transformation_id=ct.transformation_id AND vt.virtue_id=NEW.virtue_id)
 AND NOT EXISTS(SELECT 1 FROM public.class_transformations xt WHERE xt.transformation_id=ct.transformation_id AND xt.class_id=NEW.class_id)
 AND NOT EXISTS(SELECT 1 FROM public.transformations t WHERE t.id=ct.transformation_id AND t.owner_character_id=NEW.id)
 LOOP
  IF _grant.active THEN PERFORM public.end_character_transformation_internal(NEW.id,_grant.transformation_id,false); END IF;
  DELETE FROM public.character_transformations WHERE character_id=NEW.id AND transformation_id=_grant.transformation_id;
 END LOOP;
 INSERT INTO public.character_transformations(character_id,transformation_id,active,cooldown_remaining)
 SELECT NEW.id,src.transformation_id,false,0 FROM (
  SELECT rt.transformation_id FROM public.race_transformations rt WHERE rt.race_id=NEW.race_id
  UNION SELECT vt.transformation_id FROM public.virtue_transformations vt WHERE vt.virtue_id=NEW.virtue_id
  UNION SELECT xt.transformation_id FROM public.class_transformations xt WHERE xt.class_id=NEW.class_id
  UNION SELECT t.id FROM public.transformations t WHERE t.owner_character_id=NEW.id
 ) src ON CONFLICT(character_id,transformation_id) DO NOTHING;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.sync_class_trait_dependents()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _character_id uuid;
BEGIN
  FOR _character_id IN SELECT id FROM public.characters WHERE class_id = NEW.id LOOP
    PERFORM public.sync_character_trait_abilities(_character_id);
    PERFORM public.sync_character_class_effects(_character_id);
  END LOOP;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.sync_coracao_corrompido_strength_effect_internal(_character_id uuid, _bonus_strength numeric DEFAULT NULL::numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _heat numeric := 0;
  _heart record;
  _current_effects jsonb;
  _next_effects jsonb;
  _should_apply boolean;
  _attributes jsonb;
  _configured_bonus numeric;
  _effective_bonus numeric;
  _racial_multiplier numeric;
  _bonus_scales_with_race boolean := true;
BEGIN
  IF _character_id IS NULL THEN RETURN; END IF;

  SELECT COALESCE(MAX(
    CASE
      WHEN ca.custom_state->>'dano_superaquecimento' ~ '^-?[0-9]+([.][0-9]+)?$'
        THEN GREATEST(0, (ca.custom_state->>'dano_superaquecimento')::numeric)
      ELSE 0
    END
  ), 0)
  INTO _heat
  FROM public.character_abilities ca
  JOIN public.abilities a ON a.id = ca.ability_id
  WHERE ca.character_id = _character_id
    AND (a.custom_script_key = 'demonio_interno' OR lower(btrim(a.name)) = lower('Demônio Interno'));

  FOR _heart IN
    SELECT ca.id, ca.cooldown_remaining, ca.passive_effects,
           ca.custom_attributes AS character_custom_attributes,
           ca.granted_by_virtue_id,
           a.custom_attributes AS catalog_custom_attributes,
           r.special_mechanics AS race_special_mechanics,
           cl.special_mechanics AS class_special_mechanics
    FROM public.character_abilities ca
    JOIN public.abilities a ON a.id = ca.ability_id
    JOIN public.characters c ON c.id = ca.character_id
    LEFT JOIN public.races r ON r.id = c.race_id
    LEFT JOIN public.classes cl ON cl.id = c.class_id
    WHERE ca.character_id = _character_id
      AND (a.custom_script_key = 'coracao_corrompido' OR lower(btrim(a.name)) = lower('Coração Corrompido'))
  LOOP
    _attributes := CASE
      WHEN jsonb_typeof(_heart.character_custom_attributes) = 'array' THEN _heart.character_custom_attributes
      WHEN jsonb_typeof(_heart.catalog_custom_attributes) = 'array' THEN _heart.catalog_custom_attributes
      ELSE '[]'::jsonb
    END;

    IF _bonus_strength IS NOT NULL THEN
      _effective_bonus := _bonus_strength; -- The trusted Edge Function already applies the racial multiplier.
    ELSE
      SELECT COALESCE(MAX(
        CASE
          WHEN lower(regexp_replace(coalesce(attr.value->>'key', ''), '[^a-zA-Z0-9]', '', 'g')) = 'forcabonus'
            AND attr.value->>'type' = 'number'
            AND COALESCE(attr.value->>'value', '') ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN (attr.value->>'value')::numeric
          ELSE NULL
        END
      ), 0)
      INTO _configured_bonus
      FROM jsonb_array_elements(_attributes) AS attr(value);

      SELECT COALESCE(bool_or(coalesce((attr.value->>'scale_with_race')::boolean, true)), true)
      INTO _bonus_scales_with_race
      FROM jsonb_array_elements(_attributes) AS attr(value)
      WHERE lower(regexp_replace(coalesce(attr.value->>'key', ''), '[^a-zA-Z0-9]', '', 'g')) = 'forcabonus'
        AND attr.value->>'type' = 'number';

      _racial_multiplier := 1;
      IF _heart.granted_by_virtue_id IS NOT NULL AND _bonus_scales_with_race THEN
        IF coalesce((_heart.race_special_mechanics->>'duplicate_virtue_effects')::boolean, false) AND NOT coalesce((_heart.race_special_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_heart.granted_by_virtue_id::text), false)
        THEN _racial_multiplier:=_racial_multiplier*greatest(1,least(10,coalesce(nullif(_heart.race_special_mechanics->>'virtue_effect_multiplier','')::numeric,2))); END IF;
        IF coalesce((_heart.class_special_mechanics->>'duplicate_virtue_effects')::boolean, false) AND NOT coalesce((_heart.class_special_mechanics->'virtue_effect_blacklist') @> jsonb_build_array(_heart.granted_by_virtue_id::text), false)
        THEN _racial_multiplier:=_racial_multiplier*greatest(1,least(10,coalesce(nullif(_heart.class_special_mechanics->>'virtue_effect_multiplier','')::numeric,2))); END IF;
      END IF;
      _racial_multiplier:=LEAST(100,_racial_multiplier);
      _effective_bonus:=coalesce(_configured_bonus,0)*_racial_multiplier;
    END IF;
    _effective_bonus := LEAST(1000000, GREATEST(0, COALESCE(_effective_bonus, 0)));

    _current_effects := CASE
      WHEN jsonb_typeof(COALESCE(_heart.passive_effects, '[]'::jsonb)) = 'array' THEN COALESCE(_heart.passive_effects, '[]'::jsonb)
      ELSE '[]'::jsonb
    END;

    SELECT COALESCE(jsonb_agg(item.effect ORDER BY item.ordinality), '[]'::jsonb)
    INTO _next_effects
    FROM jsonb_array_elements(_current_effects) WITH ORDINALITY AS item(effect, ordinality)
    WHERE item.effect->>'special_modifier_key' IS DISTINCT FROM 'coracao_corrompido_demonio_strength';

    _should_apply := COALESCE(_heart.cooldown_remaining, 0) > 0 AND _heat > 0 AND _effective_bonus > 0;
    IF _should_apply THEN
      _next_effects := _next_effects || jsonb_build_array(jsonb_build_object(
        'name', 'Coração Corrompido — Força do Demônio Interno',
        'effect_type', 'status', 'attribute_key', 'strength', 'polarity', 'buff',
        'value_mode', 'fixed', 'amount', _effective_bonus, 'duration', 1,
        'damage_scope', 'any', 'special_modifier_key', 'coracao_corrompido_demonio_strength'
      ));
    END IF;

    IF _current_effects IS DISTINCT FROM _next_effects THEN
      UPDATE public.character_abilities SET passive_effects = _next_effects WHERE id = _heart.id;
    END IF;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.choose_character_class(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.choose_character_class(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.sync_character_class_assignments() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_character_class_effects_after_template_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_character_class_points() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_character_class_physical_points() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.on_class_abilities_changed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.on_class_transformations_changed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_class_condition_modifier_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.preserve_class_effect_duration() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_class_trait_dependents() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS classes_apply_condition_modifiers ON public.classes;
CREATE TRIGGER classes_apply_condition_modifiers AFTER UPDATE OF modifiers ON public.classes
FOR EACH ROW EXECUTE FUNCTION public.apply_class_condition_modifier_change();
DROP TRIGGER IF EXISTS classes_sync_physical_points ON public.classes;
CREATE TRIGGER classes_sync_physical_points AFTER UPDATE OF physical_bonus_points ON public.classes
FOR EACH ROW EXECUTE FUNCTION public.sync_character_class_physical_points();
DROP TRIGGER IF EXISTS classes_sync_points ON public.classes;
CREATE TRIGGER classes_sync_points AFTER UPDATE OF bonus_points ON public.classes
FOR EACH ROW EXECUTE FUNCTION public.sync_character_class_points();
DROP TRIGGER IF EXISTS classes_sync_starting_effects ON public.classes;
CREATE TRIGGER classes_sync_starting_effects AFTER UPDATE OF starting_effects ON public.classes
FOR EACH ROW EXECUTE FUNCTION public.sync_character_class_effects_after_template_change();
DROP TRIGGER IF EXISTS classes_sync_trait_dependents ON public.classes;
CREATE TRIGGER classes_sync_trait_dependents
AFTER UPDATE OF name, description, modifiers, special_mechanics ON public.classes
FOR EACH ROW EXECUTE FUNCTION public.sync_class_trait_dependents();

DROP TRIGGER IF EXISTS characters_sync_class_assignments_insert ON public.characters;
CREATE TRIGGER characters_sync_class_assignments_insert AFTER INSERT ON public.characters
FOR EACH ROW EXECUTE FUNCTION public.sync_character_class_assignments();
DROP TRIGGER IF EXISTS characters_sync_class_assignments_update ON public.characters;
CREATE TRIGGER characters_sync_class_assignments_update AFTER UPDATE OF class_id ON public.characters
FOR EACH ROW WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id)
EXECUTE FUNCTION public.sync_character_class_assignments();
DROP TRIGGER IF EXISTS characters_sync_transformations_class_update ON public.characters;
CREATE TRIGGER characters_sync_transformations_class_update AFTER UPDATE OF class_id ON public.characters
FOR EACH ROW EXECUTE FUNCTION public.sync_character_transformations_with_traits();
DROP TRIGGER IF EXISTS sync_character_transformations_with_traits ON public.characters;
CREATE TRIGGER sync_character_transformations_with_traits AFTER INSERT OR UPDATE OF race_id, virtue_id ON public.characters
FOR EACH ROW EXECUTE FUNCTION public.sync_character_transformations_with_traits();

DROP TRIGGER IF EXISTS class_abilities_sync_assignments ON public.class_abilities;
CREATE TRIGGER class_abilities_sync_assignments AFTER INSERT OR UPDATE OR DELETE ON public.class_abilities
FOR EACH ROW EXECUTE FUNCTION public.on_class_abilities_changed();
DROP TRIGGER IF EXISTS class_transformations_sync_assignments ON public.class_transformations;
CREATE TRIGGER class_transformations_sync_assignments AFTER INSERT OR UPDATE OR DELETE ON public.class_transformations
FOR EACH ROW EXECUTE FUNCTION public.on_class_transformations_changed();
DROP TRIGGER IF EXISTS battle_effects_preserve_class_duration ON public.battle_effects;
CREATE TRIGGER battle_effects_preserve_class_duration BEFORE UPDATE OF duration ON public.battle_effects
FOR EACH ROW EXECUTE FUNCTION public.preserve_class_effect_duration();
