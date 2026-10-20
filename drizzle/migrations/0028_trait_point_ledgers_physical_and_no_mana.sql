-- Trait-attributed point ledgers, separate physical pools, and server-enforced Sem Mana.

ALTER TABLE public.races ADD COLUMN IF NOT EXISTS physical_bonus_points integer NOT NULL DEFAULT 0 CHECK (physical_bonus_points >= 0);
ALTER TABLE public.virtues ADD COLUMN IF NOT EXISTS physical_bonus_points integer NOT NULL DEFAULT 0 CHECK (physical_bonus_points >= 0);
ALTER TABLE public.characters
  ADD COLUMN IF NOT EXISTS race_attribute_allocations jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS virtue_attribute_allocations jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS race_physical_points_granted integer NOT NULL DEFAULT 0 CHECK (race_physical_points_granted >= 0),
  ADD COLUMN IF NOT EXISTS virtue_physical_points_granted integer NOT NULL DEFAULT 0 CHECK (virtue_physical_points_granted >= 0),
  ADD COLUMN IF NOT EXISTS race_physical_allocations jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS virtue_physical_allocations jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE public.characters c SET race_physical_points_granted = COALESCE(r.physical_bonus_points, 0)
FROM public.races r WHERE r.id = c.race_id;
UPDATE public.characters c SET virtue_physical_points_granted = COALESCE(v.physical_bonus_points, 0)
FROM public.virtues v WHERE v.id = c.virtue_id;

ALTER TABLE public.battle_effects DROP CONSTRAINT IF EXISTS battle_effects_effect_type_check;
ALTER TABLE public.battle_effects ADD CONSTRAINT battle_effects_effect_type_check
  CHECK (effect_type IN ('status','regeneration','no_regen_hp','no_regen_mana','stun','mana_used','magic_prohibition','damage_dealt','no_mana'));
ALTER TABLE public.battle_effects DROP CONSTRAINT IF EXISTS battle_effects_check;
ALTER TABLE public.battle_effects ADD CONSTRAINT battle_effects_check CHECK (
  (effect_type = 'status' AND attribute_key IS NOT NULL)
  OR (effect_type = 'regeneration' AND attribute_key IN ('hp','mana'))
  OR effect_type IN ('no_regen_hp','no_regen_mana','stun','mana_used')
  OR (effect_type = 'magic_prohibition' AND attribute_key IS NULL AND polarity = 'debuff')
  OR (effect_type = 'damage_dealt' AND attribute_key IS NULL)
  OR (effect_type = 'no_mana' AND attribute_key IS NULL AND polarity = 'debuff')
);

CREATE OR REPLACE FUNCTION public.character_has_no_mana(_character_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.battle_effects e
    WHERE e.character_id = _character_id AND e.effect_type = 'no_mana' AND e.polarity = 'debuff'
      AND e.duration > 0
      AND (e.battle_id IS NULL OR EXISTS (SELECT 1 FROM public.battles b WHERE b.id = e.battle_id AND b.active))
  ) OR EXISTS (
    SELECT 1 FROM public.character_abilities ca
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(COALESCE(ca.passive_effects, '[]'::jsonb)) = 'array'
        THEN COALESCE(ca.passive_effects, '[]'::jsonb) ELSE '[]'::jsonb END
    ) p(effect)
    WHERE ca.character_id = _character_id
      AND p.effect->>'effect_type' = 'no_mana'
      AND COALESCE(p.effect->>'polarity', 'debuff') = 'debuff'
  );
$$;
REVOKE ALL ON FUNCTION public.character_has_no_mana(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.character_has_no_mana(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.refresh_character_mana_for_no_mana(_character_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _max integer;
BEGIN
  IF public.character_has_no_mana(_character_id) THEN
    UPDATE public.character_attributes SET current_value = 0, max_value = 0, updated_at = now()
    WHERE character_id = _character_id AND attribute_key = 'mana';
    RETURN;
  END IF;
  SELECT GREATEST(0, ROUND(COALESCE(ad.base_value, 0)
    + (ca.points + COALESCE((r.modifiers->>'mana')::numeric, 0) + COALESCE((v.modifiers->>'mana')::numeric, 0))
      * COALESCE(ad.points_multiplier, 1) + ca.bonus))::integer
  INTO _max
  FROM public.character_attributes ca
  JOIN public.attribute_definitions ad ON ad.key = ca.attribute_key
  JOIN public.characters c ON c.id = ca.character_id
  LEFT JOIN public.races r ON r.id = c.race_id
  LEFT JOIN public.virtues v ON v.id = c.virtue_id
  WHERE ca.character_id = _character_id AND ca.attribute_key = 'mana';
  IF _max IS NOT NULL THEN
    UPDATE public.character_attributes SET max_value = _max, current_value = LEAST(current_value, _max), updated_at = now()
    WHERE character_id = _character_id AND attribute_key = 'mana';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.refresh_character_mana_for_no_mana(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.keep_mana_zero_while_no_mana()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.attribute_key = 'mana' AND public.character_has_no_mana(NEW.character_id) THEN
    NEW.current_value := 0; NEW.max_value := 0;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER character_attributes_keep_mana_zero
BEFORE INSERT OR UPDATE ON public.character_attributes
FOR EACH ROW EXECUTE FUNCTION public.keep_mana_zero_while_no_mana();

CREATE OR REPLACE FUNCTION public.refresh_mana_after_battle_effect_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM public.refresh_character_mana_for_no_mana(OLD.character_id); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM public.refresh_character_mana_for_no_mana(NEW.character_id); END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER battle_effects_refresh_mana_no_mana
AFTER INSERT OR UPDATE OR DELETE ON public.battle_effects
FOR EACH ROW EXECUTE FUNCTION public.refresh_mana_after_battle_effect_change();

CREATE OR REPLACE FUNCTION public.refresh_mana_after_character_ability_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM public.refresh_character_mana_for_no_mana(OLD.character_id); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM public.refresh_character_mana_for_no_mana(NEW.character_id); END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER character_abilities_refresh_mana_no_mana
AFTER INSERT OR UPDATE OR DELETE ON public.character_abilities
FOR EACH ROW EXECUTE FUNCTION public.refresh_mana_after_character_ability_change();

CREATE OR REPLACE FUNCTION public.refresh_mana_after_battle_active_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _cid uuid;
BEGIN
  IF OLD.active IS DISTINCT FROM NEW.active THEN
    FOR _cid IN SELECT character_id FROM public.battle_participants WHERE battle_id = NEW.id LOOP
      PERFORM public.refresh_character_mana_for_no_mana(_cid);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER battles_refresh_mana_no_mana
AFTER UPDATE OF active ON public.battles FOR EACH ROW EXECUTE FUNCTION public.refresh_mana_after_battle_active_change();

UPDATE public.character_attributes SET current_value = current_value WHERE attribute_key = 'mana';

-- Trait choices remove allocations belonging only to the trait being replaced.
CREATE OR REPLACE FUNCTION public.choose_character_race(_character_id uuid, _race_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _c public.characters; _bonus integer := 0; _physical integer := 0;
  _spent integer := 0; _unused integer := 0; _other_spent integer := 0; _other_unused integer := 0;
  _key text; _n integer;
  _master boolean := public.has_role(auth.uid(), 'master');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  SELECT * INTO _c FROM public.characters WHERE id = _character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;
  IF NOT _master THEN
    IF _c.owner_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Sem permissão'; END IF;
    IF _race_id IS NULL THEN RAISE EXCEPTION 'Escolha uma raça'; END IF;
    IF _c.race_id IS NOT NULL AND _c.race_id IS DISTINCT FROM _race_id THEN RAISE EXCEPTION 'A raça já foi escolhida; peça ao mestre para trocar'; END IF;
  END IF;
  IF _c.race_id IS NOT DISTINCT FROM _race_id THEN RETURN; END IF;
  IF _race_id IS NOT NULL THEN
    SELECT bonus_points, physical_bonus_points INTO _bonus, _physical FROM public.races WHERE id = _race_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raça não encontrada'; END IF;
  END IF;
  SELECT COALESCE(SUM(value::integer), 0) INTO _spent FROM jsonb_each_text(COALESCE(_c.race_attribute_allocations, '{}'::jsonb));
  SELECT COALESCE(SUM(value::integer), 0) INTO _other_spent FROM jsonb_each_text(COALESCE(_c.virtue_attribute_allocations, '{}'::jsonb));
  _other_unused := GREATEST(0, COALESCE(_c.virtue_points_granted, 0) - _other_spent);
  -- Keep the other trait's remaining balance intact if legacy point history is incomplete.
  _unused := LEAST(GREATEST(0, COALESCE(_c.race_points_granted, 0) - _spent),
    GREATEST(0, COALESCE(_c.available_points, 0) - _other_unused));
  FOR _key, _n IN SELECT key, value::integer FROM jsonb_each_text(COALESCE(_c.race_attribute_allocations, '{}'::jsonb)) LOOP
    UPDATE public.character_attributes SET points = GREATEST(0, points - _n)
    WHERE character_id = _character_id AND attribute_key = _key;
  END LOOP;
  UPDATE public.character_attributes ca
  SET max_value = GREATEST(0, ROUND(COALESCE(ad.base_value,0) + ca.points * COALESCE(ad.points_multiplier,1)))::integer,
      current_value = CASE WHEN ad.cap_current AND ca.current_value > GREATEST(0, ROUND(COALESCE(ad.base_value,0) + ca.points * COALESCE(ad.points_multiplier,1)))::integer
        THEN GREATEST(0, ROUND(COALESCE(ad.base_value,0) + ca.points * COALESCE(ad.points_multiplier,1)))::integer ELSE ca.current_value END
  FROM public.attribute_definitions ad WHERE ca.character_id = _character_id AND ad.key = ca.attribute_key AND ad.accepts_points;
  UPDATE public.characters SET race_id = _race_id, available_points = GREATEST(0, available_points - _unused + _bonus),
    race_points_granted = _bonus, race_attribute_allocations = '{}'::jsonb,
    race_physical_points_granted = _physical, race_physical_allocations = '{}'::jsonb
  WHERE id = _character_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.choose_character_virtue(_character_id uuid, _virtue_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _c public.characters; _bonus integer := 0; _physical integer := 0;
  _spent integer := 0; _unused integer := 0; _other_spent integer := 0; _other_unused integer := 0;
  _key text; _n integer;
  _master boolean := public.has_role(auth.uid(), 'master');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  SELECT * INTO _c FROM public.characters WHERE id = _character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;
  IF NOT _master THEN
    IF _c.owner_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Sem permissão'; END IF;
    IF _c.race_id IS NULL THEN RAISE EXCEPTION 'Confirme sua raça antes de escolher a virtude'; END IF;
    IF _virtue_id IS NULL THEN RAISE EXCEPTION 'Escolha uma virtude'; END IF;
    IF _c.virtue_id IS NOT NULL AND _c.virtue_id IS DISTINCT FROM _virtue_id THEN RAISE EXCEPTION 'A virtude já foi escolhida; peça ao mestre para trocar'; END IF;
  END IF;
  IF _c.virtue_id IS NOT DISTINCT FROM _virtue_id THEN RETURN; END IF;
  IF _virtue_id IS NOT NULL THEN
    SELECT bonus_points, physical_bonus_points INTO _bonus, _physical FROM public.virtues WHERE id = _virtue_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Virtude não encontrada'; END IF;
  END IF;
  SELECT COALESCE(SUM(value::integer), 0) INTO _spent FROM jsonb_each_text(COALESCE(_c.virtue_attribute_allocations, '{}'::jsonb));
  SELECT COALESCE(SUM(value::integer), 0) INTO _other_spent FROM jsonb_each_text(COALESCE(_c.race_attribute_allocations, '{}'::jsonb));
  _other_unused := GREATEST(0, COALESCE(_c.race_points_granted, 0) - _other_spent);
  -- Keep the other trait's remaining balance intact if legacy point history is incomplete.
  _unused := LEAST(GREATEST(0, COALESCE(_c.virtue_points_granted, 0) - _spent),
    GREATEST(0, COALESCE(_c.available_points, 0) - _other_unused));
  FOR _key, _n IN SELECT key, value::integer FROM jsonb_each_text(COALESCE(_c.virtue_attribute_allocations, '{}'::jsonb)) LOOP
    UPDATE public.character_attributes SET points = GREATEST(0, points - _n)
    WHERE character_id = _character_id AND attribute_key = _key;
  END LOOP;
  UPDATE public.character_attributes ca
  SET max_value = GREATEST(0, ROUND(COALESCE(ad.base_value,0) + ca.points * COALESCE(ad.points_multiplier,1)))::integer,
      current_value = CASE WHEN ad.cap_current AND ca.current_value > GREATEST(0, ROUND(COALESCE(ad.base_value,0) + ca.points * COALESCE(ad.points_multiplier,1)))::integer
        THEN GREATEST(0, ROUND(COALESCE(ad.base_value,0) + ca.points * COALESCE(ad.points_multiplier,1)))::integer ELSE ca.current_value END
  FROM public.attribute_definitions ad WHERE ca.character_id = _character_id AND ad.key = ca.attribute_key AND ad.accepts_points;
  UPDATE public.characters SET virtue_id = _virtue_id, available_points = GREATEST(0, available_points - _unused + _bonus),
    virtue_points_granted = _bonus, virtue_attribute_allocations = '{}'::jsonb,
    virtue_physical_points_granted = _physical, virtue_physical_allocations = '{}'::jsonb
  WHERE id = _character_id;
END;
$$;
REVOKE ALL ON FUNCTION public.choose_character_race(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.choose_character_race(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.choose_character_virtue(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.choose_character_virtue(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.choose_character_traits(_character_id uuid, _race_id uuid, _virtue_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.choose_character_race(_character_id, _race_id);
  PERFORM public.choose_character_virtue(_character_id, _virtue_id);
END;
$$;
REVOKE ALL ON FUNCTION public.choose_character_traits(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.choose_character_traits(uuid, uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.invest_points(_character_id uuid, _allocations jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _c public.characters; _ra jsonb; _va jsonb; _available integer; _total integer := 0;
  _key text; _delta integer; _cur integer; _remove integer; _take integer; _used integer; _left integer;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  IF _allocations IS NULL OR jsonb_typeof(_allocations) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Distribuição de pontos inválida'; END IF;
  SELECT * INTO _c FROM public.characters WHERE id = _character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;
  IF NOT public.has_role(auth.uid(), 'master') AND _c.owner_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Sem permissão'; END IF;
  _available := _c.available_points; _ra := COALESCE(_c.race_attribute_allocations, '{}'::jsonb); _va := COALESCE(_c.virtue_attribute_allocations, '{}'::jsonb);

  FOR _key, _delta IN SELECT key, value::integer FROM jsonb_each_text(_allocations) WHERE value::integer < 0 LOOP
    IF NOT public.has_role(auth.uid(), 'master') THEN RAISE EXCEPTION 'Apenas o mestre pode retirar pontos'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.attribute_definitions WHERE key = _key AND accepts_points) THEN RAISE EXCEPTION 'O atributo % não aceita pontos', _key; END IF;
    SELECT points INTO _cur FROM public.character_attributes WHERE character_id = _character_id AND attribute_key = _key FOR UPDATE;
    IF COALESCE(_cur,0) + _delta < 0 THEN RAISE EXCEPTION 'Pontos investidos não podem ficar negativos'; END IF;
    _remove := -_delta; _take := LEAST(_remove, COALESCE((_va->>_key)::integer,0));
    IF _take > 0 THEN
      IF COALESCE((_va->>_key)::integer,0) = _take THEN _va := _va - _key;
      ELSE _va := jsonb_set(_va, ARRAY[_key], to_jsonb((_va->>_key)::integer - _take), true); END IF;
      _remove := _remove - _take;
    END IF;
    _take := LEAST(_remove, COALESCE((_ra->>_key)::integer,0));
    IF _take > 0 THEN
      IF COALESCE((_ra->>_key)::integer,0) = _take THEN _ra := _ra - _key;
      ELSE _ra := jsonb_set(_ra, ARRAY[_key], to_jsonb((_ra->>_key)::integer - _take), true); END IF;
    END IF;
    UPDATE public.character_attributes SET points = points + _delta WHERE character_id = _character_id AND attribute_key = _key;
    _total := _total + _delta;
  END LOOP;

  FOR _key, _delta IN SELECT key, value::integer FROM jsonb_each_text(_allocations) WHERE value::integer > 0 LOOP
    IF NOT EXISTS (SELECT 1 FROM public.attribute_definitions WHERE key = _key AND accepts_points) THEN RAISE EXCEPTION 'O atributo % não aceita pontos', _key; END IF;
    INSERT INTO public.character_attributes (character_id, attribute_key, points) VALUES (_character_id, _key, _delta)
    ON CONFLICT (character_id, attribute_key) DO UPDATE SET points = public.character_attributes.points + EXCLUDED.points;
    _left := _delta;
    SELECT COALESCE(SUM(value::integer),0) INTO _used FROM jsonb_each_text(_ra);
    _take := LEAST(_left, GREATEST(0, COALESCE(_c.race_points_granted,0) - _used));
    IF _take > 0 THEN _ra := jsonb_set(_ra, ARRAY[_key], to_jsonb(COALESCE((_ra->>_key)::integer,0)+_take), true); _left := _left - _take; END IF;
    SELECT COALESCE(SUM(value::integer),0) INTO _used FROM jsonb_each_text(_va);
    _take := LEAST(_left, GREATEST(0, COALESCE(_c.virtue_points_granted,0) - _used));
    IF _take > 0 THEN _va := jsonb_set(_va, ARRAY[_key], to_jsonb(COALESCE((_va->>_key)::integer,0)+_take), true); END IF;
    _total := _total + _delta;
  END LOOP;
  IF _total > _available THEN RAISE EXCEPTION 'Pontos insuficientes (disponível: %)', _available; END IF;
  UPDATE public.characters SET available_points = available_points - _total, race_attribute_allocations = _ra, virtue_attribute_allocations = _va WHERE id = _character_id;
  UPDATE public.character_attributes ca
  SET max_value = GREATEST(0, ROUND(COALESCE(ad.base_value,0)+ca.points*COALESCE(ad.points_multiplier,1)))::integer,
      current_value = CASE WHEN ad.cap_current AND ca.current_value > GREATEST(0,ROUND(COALESCE(ad.base_value,0)+ca.points*COALESCE(ad.points_multiplier,1)))::integer
        THEN GREATEST(0,ROUND(COALESCE(ad.base_value,0)+ca.points*COALESCE(ad.points_multiplier,1)))::integer ELSE ca.current_value END
  FROM public.attribute_definitions ad WHERE ca.character_id = _character_id AND ad.key = ca.attribute_key AND ad.accepts_points;
END;
$$;
REVOKE ALL ON FUNCTION public.invest_points(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invest_points(uuid, jsonb) TO authenticated;

-- Explicit source selector: race, virtue, or independent base points. This keeps the provenance
-- chosen in the UI deterministic rather than silently spending the race pool first.
CREATE OR REPLACE FUNCTION public.invest_points_from_source(
  _character_id uuid,
  _source text,
  _allocations jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _c public.characters;
  _race_alloc jsonb;
  _virtue_alloc jsonb;
  _race_left integer;
  _virtue_left integer;
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
  IF _source NOT IN ('race','virtue','base') THEN RAISE EXCEPTION 'Origem dos pontos inválida'; END IF;
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
  SELECT COALESCE(SUM(value::integer),0) INTO _used FROM jsonb_each_text(_race_alloc);
  _race_left := GREATEST(0, COALESCE(_c.race_points_granted,0) - _used);
  SELECT COALESCE(SUM(value::integer),0) INTO _used FROM jsonb_each_text(_virtue_alloc);
  _virtue_left := GREATEST(0, COALESCE(_c.virtue_points_granted,0) - _used);
  _base_left := GREATEST(0, COALESCE(_c.available_points,0) - _race_left - _virtue_left);
  _source_left := CASE _source WHEN 'race' THEN _race_left WHEN 'virtue' THEN _virtue_left ELSE _base_left END;
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
  _base_left := GREATEST(0, _available - _total - _race_left - _virtue_left);
  _source_left := CASE _source WHEN 'race' THEN _race_left WHEN 'virtue' THEN _virtue_left ELSE _base_left END;

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
      _virtue_alloc := jsonb_set(_virtue_alloc, ARRAY[_key],
        to_jsonb(COALESCE((_virtue_alloc ->> _key)::integer,0) + _delta), true);
    END IF;
  END LOOP;

  UPDATE public.characters
  SET available_points = available_points - _total,
      race_attribute_allocations = _race_alloc,
      virtue_attribute_allocations = _virtue_alloc
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
$$;
REVOKE ALL ON FUNCTION public.invest_points_from_source(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invest_points_from_source(uuid, text, jsonb) TO authenticated;


CREATE OR REPLACE FUNCTION public.invest_physical_points(_character_id uuid, _allocations jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _c public.characters; _ra jsonb; _va jsonb; _ru integer; _vu integer; _rl integer; _vl integer;
  _key text; _delta integer; _left integer; _take integer; _total integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  IF _allocations IS NULL OR jsonb_typeof(_allocations) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Distribuição de pontos físicos inválida'; END IF;
  SELECT * INTO _c FROM public.characters WHERE id = _character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;
  IF NOT public.has_role(auth.uid(), 'master') AND _c.owner_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Sem permissão'; END IF;
  _ra := COALESCE(_c.race_physical_allocations, '{}'::jsonb); _va := COALESCE(_c.virtue_physical_allocations, '{}'::jsonb);
  SELECT COALESCE(SUM(value::integer),0) INTO _ru FROM jsonb_each_text(_ra);
  SELECT COALESCE(SUM(value::integer),0) INTO _vu FROM jsonb_each_text(_va);
  _rl := GREATEST(0, COALESCE(_c.race_physical_points_granted,0)-_ru); _vl := GREATEST(0,COALESCE(_c.virtue_physical_points_granted,0)-_vu);
  FOR _key, _delta IN SELECT key,value::integer FROM jsonb_each_text(_allocations) LOOP
    IF _delta <= 0 THEN RAISE EXCEPTION 'Os pontos físicos precisam ser positivos'; END IF;
    IF _key NOT IN ('strength','phys_def','speed','atk_speed') OR NOT EXISTS (SELECT 1 FROM public.attribute_definitions WHERE key=_key AND accepts_points) THEN
      RAISE EXCEPTION 'O atributo % não aceita pontos extras físicos', _key;
    END IF;
    _total := _total + _delta;
  END LOOP;
  IF _total > _rl+_vl THEN RAISE EXCEPTION 'Pontos físicos insuficientes (disponível: %)', _rl+_vl; END IF;
  FOR _key, _delta IN SELECT key,value::integer FROM jsonb_each_text(_allocations) LOOP
    _left := _delta; _take := LEAST(_left,_rl);
    IF _take>0 THEN _ra:=jsonb_set(_ra,ARRAY[_key],to_jsonb(COALESCE((_ra->>_key)::integer,0)+_take),true); _rl:=_rl-_take; _left:=_left-_take; END IF;
    _take := LEAST(_left,_vl);
    IF _take>0 THEN _va:=jsonb_set(_va,ARRAY[_key],to_jsonb(COALESCE((_va->>_key)::integer,0)+_take),true); _vl:=_vl-_take; _left:=_left-_take; END IF;
    IF _left>0 THEN RAISE EXCEPTION 'Pontos físicos insuficientes'; END IF;
  END LOOP;
  UPDATE public.characters SET race_physical_allocations=_ra, virtue_physical_allocations=_va WHERE id=_character_id;
END;
$$;
REVOKE ALL ON FUNCTION public.invest_physical_points(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invest_physical_points(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.invest_physical_points_from_source(
  _character_id uuid,
  _source text,
  _allocations jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  IF _source NOT IN ('race','virtue') THEN RAISE EXCEPTION 'Origem dos pontos físicos inválida'; END IF;
  IF _allocations IS NULL OR jsonb_typeof(_allocations) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Distribuição de pontos físicos inválida';
  END IF;
  SELECT * INTO _c FROM public.characters WHERE id = _character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;
  IF NOT public.has_role(auth.uid(), 'master') AND _c.owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Sem permissão';
  END IF;

  _current_alloc := CASE WHEN _source = 'race'
    THEN COALESCE(_c.race_physical_allocations, '{}'::jsonb)
    ELSE COALESCE(_c.virtue_physical_allocations, '{}'::jsonb) END;
  SELECT COALESCE(SUM(value::integer),0) INTO _used FROM jsonb_each_text(_current_alloc);
  _remaining := GREATEST(0,
    (CASE WHEN _source = 'race' THEN COALESCE(_c.race_physical_points_granted,0)
      ELSE COALESCE(_c.virtue_physical_points_granted,0) END) - _used
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
  ELSE
    UPDATE public.characters SET virtue_physical_allocations = _current_alloc WHERE id = _character_id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.invest_physical_points_from_source(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invest_physical_points_from_source(uuid, text, jsonb) TO authenticated;


CREATE OR REPLACE FUNCTION public.cleanup_character_race_before_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _cid uuid;
BEGIN
  FOR _cid IN SELECT id FROM public.characters WHERE race_id=OLD.id LOOP PERFORM public.choose_character_race(_cid,NULL); END LOOP;
  RETURN OLD;
END;
$$;
CREATE TRIGGER races_cleanup_character_allocations BEFORE DELETE ON public.races FOR EACH ROW EXECUTE FUNCTION public.cleanup_character_race_before_delete();

CREATE OR REPLACE FUNCTION public.cleanup_character_virtue_before_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _cid uuid;
BEGIN
  FOR _cid IN SELECT id FROM public.characters WHERE virtue_id=OLD.id LOOP PERFORM public.choose_character_virtue(_cid,NULL); END LOOP;
  RETURN OLD;
END;
$$;
CREATE TRIGGER virtues_cleanup_character_allocations BEFORE DELETE ON public.virtues FOR EACH ROW EXECUTE FUNCTION public.cleanup_character_virtue_before_delete();


-- Ability effects: persist and enforce Sem Mana.

-- Ability effects: preserve damage-scope metadata and persist/enforce Sem Mana.

create or replace function public.apply_character_ability_end_effects()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _end_effects jsonb;
  _ability_name text;
  _effect jsonb;
  _effect_type text;
  _attribute_key text;
  _polarity text;
  _value_mode text;
  _amount numeric;
  _duration integer;
  _effect_name text;
  _damage_scope text;
begin
  if old.is_end_effect or old.effect_group_id is null or old.source_character_ability_id is null then
    return old;
  end if;

  -- Ending an entire combat is not the same as a skill's effects expiring.
  if old.battle_id is not null and not exists (
    select 1 from public.battles b where b.id = old.battle_id and b.active
  ) then
    return old;
  end if;

  if exists (
    select 1 from public.battle_effects e
    where e.effect_group_id = old.effect_group_id and not e.is_end_effect
  ) then
    return old;
  end if;

  select ca.end_effects, ca.name
  into _end_effects, _ability_name
  from public.character_abilities ca
  where ca.id = old.source_character_ability_id;

  if not found or jsonb_typeof(coalesce(_end_effects, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(_end_effects, '[]'::jsonb)) = 0 then
    return old;
  end if;

  for _effect in select value from jsonb_array_elements(coalesce(_end_effects, '[]'::jsonb))
  loop
    _effect_type := _effect->>'effect_type';
    _attribute_key := nullif(_effect->>'attribute_key', '');
    _polarity := coalesce(nullif(_effect->>'polarity', ''), 'buff');
    _value_mode := coalesce(nullif(_effect->>'value_mode', ''), 'fixed');
    _amount := coalesce(nullif(_effect->>'amount', '')::numeric, 0);
    _duration := greatest(1, coalesce(nullif(_effect->>'duration', '')::integer, 1));
    _effect_name := coalesce(nullif(_effect->>'name', ''), _ability_name);
    _damage_scope := coalesce(nullif(_effect->>'damage_scope', ''), 'any');
    IF _damage_scope NOT IN ('any', 'physical', 'magical') THEN
      RAISE EXCEPTION 'Escopo de Dano Causado inválido';
    END IF;

    if _effect_type is null or _effect_type not in (
      'status','regeneration','mana_regeneration','mana_used',
      'no_regen_hp','no_regen_mana','stun','magic_prohibition','damage_dealt','no_mana'
    ) then
      raise exception 'Tipo de efeito de encerramento inválido na habilidade %', _ability_name;
    end if;
    if _polarity not in ('buff','debuff') or _value_mode not in ('percent','fixed') then
      raise exception 'Configuração de efeito de encerramento inválida';
    end if;
    if _amount < 0 then raise exception 'Valor de efeito de encerramento inválido'; end if;

    if _effect_type = 'status' then
      if _attribute_key is null or not exists (
        select 1 from public.attribute_definitions where key = _attribute_key
      ) then
        raise exception 'Efeito de encerramento de status precisa de atributo válido';
      end if;
    elsif _effect_type = 'regeneration' then
      if _attribute_key is null or _attribute_key not in ('hp','mana') then
        raise exception 'Regeneração de encerramento só pode afetar HP ou Mana';
      end if;
    elsif _effect_type = 'mana_regeneration' then
      _effect_type := 'regeneration';
      _attribute_key := 'mana';
    elsif _effect_type in ('mana_used', 'damage_dealt') then
      _attribute_key := null;
    elsif _effect_type = 'no_mana' then
      if _polarity <> 'debuff' then raise exception 'Sem Mana só pode ser um debuff'; end if;
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _damage_scope := 'any';
    elsif _effect_type = 'magic_prohibition' then
      if _polarity <> 'debuff' then raise exception 'Proibição de magia só pode ser um debuff'; end if;
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
    else
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
    end if;

    insert into public.battle_effects (
      battle_id, character_id, name, effect_type, attribute_key, polarity,
      value_mode, amount, duration, duration_scope, source_character_ability_id,
      effect_group_id, is_end_effect, damage_scope
    ) values (
      old.battle_id, old.character_id, _ability_name || ': ' || _effect_name,
      _effect_type, _attribute_key, _polarity, _value_mode, _amount, _duration,
      old.duration_scope, old.source_character_ability_id, old.effect_group_id, true, _damage_scope
    );
  end loop;

  return old;
end;
$$;

create or replace function public.activate_character_ability(
  _character_ability_id uuid,
  _target_character_id uuid,
  _battle_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  _assignment public.character_abilities;
  _owner_id uuid;
  _mana integer;
  _effective_battle_id uuid := _battle_id;
  _effect jsonb;
  _effect_type text;
  _attribute_key text;
  _polarity text;
  _value_mode text;
  _amount numeric;
  _duration integer;
  _effect_name text;
  _damage_scope text;
  _mana_fixed_modifier numeric := 0;
  _mana_percent_modifier numeric := 0;
  _effective_mana_cost integer := 0;
  _effect_group_id uuid := gen_random_uuid();
  _is_master boolean := public.has_role(auth.uid(), 'master');
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;

  select * into _assignment
  from public.character_abilities
  where id = _character_ability_id
  for update;
  if not found then raise exception 'Habilidade não encontrada nesta ficha'; end if;

  select owner_id into _owner_id
  from public.characters where id = _assignment.character_id;
  if not found then raise exception 'Ficha do personagem não encontrada'; end if;
  if not _is_master and _owner_id is distinct from auth.uid() then
    raise exception 'Sem permissão para usar esta habilidade';
  end if;

  if not _assignment.can_activate or _assignment.cooldown_turns <= 0 then
    raise exception 'Esta habilidade não pode ser ativada';
  end if;
  if _assignment.cooldown_remaining > 0 then
    raise exception 'Habilidade em cooldown: faltam % turno(s)', _assignment.cooldown_remaining;
  end if;
  if _assignment.self_target_only and _target_character_id <> _assignment.character_id then
    raise exception 'Esta habilidade só pode ser usada no próprio personagem';
  end if;
  if not exists (select 1 from public.characters where id = _target_character_id) then
    raise exception 'Alvo não encontrado'; 
  end if;

  if _effective_battle_id is not null then
    if not exists (select 1 from public.battles where id = _effective_battle_id and active) then
      raise exception 'Batalha não encontrada ou encerrada';
    end if;
    if not exists (
      select 1 from public.battle_participants
      where battle_id = _effective_battle_id and character_id = _assignment.character_id
    ) or not exists (
      select 1 from public.battle_participants
      where battle_id = _effective_battle_id and character_id = _target_character_id
    ) then
      raise exception 'O personagem e o alvo precisam estar na mesma batalha';
    end if;
  else
    if _target_character_id <> _assignment.character_id then
      raise exception 'Fora do combate, a habilidade só pode ser usada no próprio personagem';
    end if;
    select b.id into _effective_battle_id
    from public.battles b
    join public.battle_participants bp on bp.battle_id = b.id
    where b.active and bp.character_id = _target_character_id
    order by b.created_at desc
    limit 1;
  end if;

  -- Passive mana-use modifiers: a buff lowers cost, a debuff raises it.
  select
    coalesce(sum((case when effect->>'polarity' = 'buff' then -1 else 1 end)
      * coalesce(nullif(effect->>'amount','')::numeric, 0))
      filter (where effect->>'effect_type' = 'mana_used' and coalesce(effect->>'value_mode','fixed') = 'fixed'), 0),
    coalesce(sum((case when effect->>'polarity' = 'buff' then -1 else 1 end)
      * coalesce(nullif(effect->>'amount','')::numeric, 0))
      filter (where effect->>'effect_type' = 'mana_used' and coalesce(effect->>'value_mode','fixed') = 'percent'), 0)
  into _mana_fixed_modifier, _mana_percent_modifier
  from public.character_abilities ca
  cross join lateral jsonb_array_elements(ca.passive_effects) as passive_effect(effect)
  where ca.character_id = _assignment.character_id;

  -- Temporary mana-use modifiers on the caster apply only to standalone effects
  -- and effects in the battle in which the activation is happening.
  select
    _mana_fixed_modifier + coalesce(sum((case when e.polarity = 'buff' then -1 else 1 end) * e.amount)
      filter (where e.value_mode = 'fixed'), 0),
    _mana_percent_modifier + coalesce(sum((case when e.polarity = 'buff' then -1 else 1 end) * e.amount)
      filter (where e.value_mode = 'percent'), 0)
  into _mana_fixed_modifier, _mana_percent_modifier
  from public.battle_effects e
  where e.character_id = _assignment.character_id
    and e.effect_type = 'mana_used'
    and e.duration > 0
    and (e.battle_id is null or e.battle_id = _effective_battle_id);

  _effective_mana_cost := greatest(
    0,
    floor(greatest(0, _assignment.mana_cost + _mana_fixed_modifier)
      * greatest(0, 1 + _mana_percent_modifier / 100))::integer
  );

  if ((_assignment.is_magical or _assignment.mana_cost > 0 or _effective_mana_cost > 0)
      and public.character_has_no_mana(_assignment.character_id)) then
    raise exception 'Sem Mana: habilidades mágicas ou que consomem Mana não podem ser usadas enquanto o efeito durar';
  end if;

  if (
    (_assignment.is_magical or _assignment.mana_cost > 0 or _effective_mana_cost > 0)
    and exists (
      select 1 from public.battle_effects e
      where e.character_id = _assignment.character_id
        and e.effect_type = 'magic_prohibition'
        and e.polarity = 'debuff'
        and e.duration > 0
        and (e.battle_id is null or e.battle_id = _effective_battle_id)
    )
  ) then
    raise exception 'Proibição de magia: habilidades mágicas ou que consomem Mana não podem ser usadas enquanto o efeito durar';
  end if;

  if _effective_mana_cost > 0 then
    select current_value into _mana
    from public.character_attributes
    where character_id = _assignment.character_id and attribute_key = 'mana'
    for update;
    if not found then raise exception 'Esta ficha não possui o atributo Mana'; end if;
    if _mana < _effective_mana_cost then
      raise exception 'Mana insuficiente: precisa de %, possui %', _effective_mana_cost, _mana;
    end if;
    update public.character_attributes
      set current_value = _mana - _effective_mana_cost, updated_at = now()
      where character_id = _assignment.character_id and attribute_key = 'mana';
  end if;

  update public.character_abilities
  set cooldown_remaining = cooldown_turns
  where id = _assignment.id;

  if jsonb_typeof(coalesce(_assignment.effects, '[]'::jsonb)) <> 'array' then
    raise exception 'Configuração de efeitos ativos inválida';
  end if;

  for _effect in select value from jsonb_array_elements(coalesce(_assignment.effects, '[]'::jsonb))
  loop
    _effect_type := _effect->>'effect_type';
    _attribute_key := nullif(_effect->>'attribute_key', '');
    _polarity := coalesce(nullif(_effect->>'polarity', ''), 'buff');
    _value_mode := coalesce(nullif(_effect->>'value_mode', ''), 'fixed');
    _amount := coalesce(nullif(_effect->>'amount', '')::numeric, 0);
    _duration := coalesce(nullif(_effect->>'duration', '')::integer, 1);
    _effect_name := coalesce(nullif(_effect->>'name', ''), _assignment.name);
    _damage_scope := coalesce(nullif(_effect->>'damage_scope', ''), 'any');
    IF _damage_scope NOT IN ('any', 'physical', 'magical') THEN
      RAISE EXCEPTION 'Escopo de Dano Causado inválido';
    END IF;

    if _effect_type is null or _effect_type not in (
      'status','regeneration','mana_regeneration','mana_used',
      'no_regen_hp','no_regen_mana','stun','magic_prohibition','damage_dealt','no_mana'
    ) then
      raise exception 'Tipo de efeito inválido na habilidade';
    end if;
    if _polarity not in ('buff','debuff') or _value_mode not in ('percent','fixed') then
      raise exception 'Configuração de efeito inválida';
    end if;
    if _amount < 0 or _duration < 1 then raise exception 'Valor ou duração do efeito inválido'; end if;

    if _effect_type = 'status' then
      if _attribute_key is null or not exists (select 1 from public.attribute_definitions where key = _attribute_key) then
        raise exception 'Buff/debuff de status precisa de um atributo válido';
      end if;
    elsif _effect_type = 'regeneration' then
      if _attribute_key is null or _attribute_key not in ('hp','mana') then raise exception 'Regeneração só pode afetar HP ou Mana'; end if;
    elsif _effect_type = 'mana_regeneration' then
      _effect_type := 'regeneration';
      _attribute_key := 'mana';
    elsif _effect_type in ('mana_used', 'damage_dealt') then
      _attribute_key := null;
    elsif _effect_type = 'no_mana' then
      if _polarity <> 'debuff' then raise exception 'Sem Mana só pode ser um debuff'; end if;
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _damage_scope := 'any';
    elsif _effect_type = 'magic_prohibition' then
      if _polarity <> 'debuff' then raise exception 'Proibição de magia só pode ser um debuff'; end if;
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
    else
      _attribute_key := null;
      _amount := 0;
      _value_mode := 'fixed';
      _polarity := 'buff';
    end if;

    insert into public.battle_effects (
      battle_id, character_id, name, effect_type, attribute_key, polarity,
      value_mode, amount, duration, duration_scope, source_character_ability_id,
      effect_group_id, is_end_effect, damage_scope
    ) values (
      _effective_battle_id, _target_character_id, _assignment.name || ': ' || _effect_name,
      _effect_type, _attribute_key, _polarity, _value_mode, _amount,
      _duration, 'global', _assignment.id, _effect_group_id, false, _damage_scope
    );
  end loop;

  return _effective_mana_cost;
end;
$$;

REVOKE ALL ON FUNCTION public.activate_character_ability(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activate_character_ability(uuid, uuid, uuid) TO authenticated;

-- Defenses include modifiers from both traits and physical extra points in Defense.

CREATE OR REPLACE FUNCTION public.apply_battle_damage(
  _battle_id uuid,
  _character_id uuid,
  _damage_kind text,
  _damage_type_id uuid,
  _damage_values jsonb,
  _magic_level text,
  _source_character_id uuid default null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _physical_defense numeric := 0;
  _magical_defense numeric := 0;
  _hp_before integer;
  _hp_after integer;
  _total_damage integer := 0;
  _hits integer := 0;
  _raw numeric;
  _rounded_raw integer;
  _dealt integer;
  _physical_part integer;
  _magical_part integer;
  _item jsonb;
  _damage_fixed_modifier numeric := 0;
  _damage_percent_modifier numeric := 0;
  _damage_any_fixed numeric := 0;
  _damage_any_percent numeric := 0;
  _damage_physical_fixed numeric := 0;
  _damage_physical_percent numeric := 0;
  _damage_magical_fixed numeric := 0;
  _damage_magical_percent numeric := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode aplicar dano';
  END IF;

  IF _damage_kind IS NULL OR _damage_kind NOT IN ('physical', 'magical', 'hybrid', 'true') THEN
    RAISE EXCEPTION 'Tipo de dano inválido';
  END IF;

  IF _damage_values IS NULL
     OR jsonb_typeof(_damage_values) IS DISTINCT FROM 'array'
     OR jsonb_array_length(_damage_values) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Informe de 1 a 200 valores de dano';
  END IF;

  IF _battle_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.battle_participants
    WHERE battle_id = _battle_id AND character_id = _character_id
  ) THEN
    RAISE EXCEPTION 'O alvo não participa desta batalha';
  END IF;

  IF _source_character_id IS NOT NULL THEN
    IF _source_character_id = _character_id THEN
      RAISE EXCEPTION 'A origem do dano precisa ser diferente do alvo';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.characters WHERE id = _source_character_id) THEN
      RAISE EXCEPTION 'Personagem de origem do dano não encontrado';
    END IF;
    IF _battle_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.battle_participants
      WHERE battle_id = _battle_id AND character_id = _source_character_id
    ) THEN
      RAISE EXCEPTION 'A origem do dano não participa desta batalha';
    END IF;

    -- Read temporary modifiers from effects and persistent modifiers from passive abilities.
    SELECT
      COALESCE(SUM(CASE WHEN modifiers.damage_scope = 'any' AND modifiers.value_mode = 'fixed' THEN modifiers.signed_amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN modifiers.damage_scope = 'any' AND modifiers.value_mode = 'percent' THEN modifiers.signed_amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN modifiers.damage_scope = 'physical' AND modifiers.value_mode = 'fixed' THEN modifiers.signed_amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN modifiers.damage_scope = 'physical' AND modifiers.value_mode = 'percent' THEN modifiers.signed_amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN modifiers.damage_scope = 'magical' AND modifiers.value_mode = 'fixed' THEN modifiers.signed_amount ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN modifiers.damage_scope = 'magical' AND modifiers.value_mode = 'percent' THEN modifiers.signed_amount ELSE 0 END), 0)
    INTO
      _damage_any_fixed, _damage_any_percent,
      _damage_physical_fixed, _damage_physical_percent,
      _damage_magical_fixed, _damage_magical_percent
    FROM (
      SELECT
        e.value_mode,
        COALESCE(e.damage_scope, 'any') AS damage_scope,
        CASE WHEN e.polarity = 'buff' THEN e.amount ELSE -e.amount END AS signed_amount
      FROM public.battle_effects e
      WHERE e.character_id = _source_character_id
        AND e.effect_type = 'damage_dealt'
        AND e.duration > 0
        AND (e.battle_id IS NULL OR e.battle_id = _battle_id)

      UNION ALL

      SELECT
        COALESCE(passive.effect->>'value_mode', 'fixed') AS value_mode,
        CASE WHEN COALESCE(passive.effect->>'damage_scope', 'any') IN ('physical', 'magical')
          THEN passive.effect->>'damage_scope' ELSE 'any' END AS damage_scope,
        CASE WHEN COALESCE(passive.effect->>'polarity', 'buff') = 'buff'
          THEN COALESCE(NULLIF(passive.effect->>'amount', '')::numeric, 0)
          ELSE -COALESCE(NULLIF(passive.effect->>'amount', '')::numeric, 0)
        END AS signed_amount
      FROM public.character_abilities ca
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ca.passive_effects, '[]'::jsonb)) AS passive(effect)
      WHERE ca.character_id = _source_character_id
        AND passive.effect->>'effect_type' = 'damage_dealt'
    ) AS modifiers;

    -- Report the modifiers relevant to the selected damage category.
    IF _damage_kind = 'physical' THEN
      _damage_fixed_modifier := _damage_any_fixed + _damage_physical_fixed;
      _damage_percent_modifier := _damage_any_percent + _damage_physical_percent;
    ELSIF _damage_kind = 'magical' THEN
      _damage_fixed_modifier := _damage_any_fixed + _damage_magical_fixed;
      _damage_percent_modifier := _damage_any_percent + _damage_magical_percent;
    ELSIF _damage_kind = 'hybrid' THEN
      _damage_fixed_modifier := _damage_any_fixed + _damage_physical_fixed + _damage_magical_fixed;
      _damage_percent_modifier := _damage_any_percent + _damage_physical_percent + _damage_magical_percent;
    ELSE
      -- True damage is its own category; only "any" modifiers apply to it.
      _damage_fixed_modifier := _damage_any_fixed;
      _damage_percent_modifier := _damage_any_percent;
    END IF;
  END IF;

  IF _damage_kind IN ('magical', 'hybrid') THEN
    IF _damage_type_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.damage_types WHERE id = _damage_type_id
    ) THEN
      RAISE EXCEPTION 'Selecione um tipo de dano mágico válido';
    END IF;
    IF _magic_level IS NULL OR _magic_level NOT IN ('baixa', 'media', 'alta') THEN
      RAISE EXCEPTION 'Selecione o nível da magia: baixa, média ou alta';
    END IF;
  ELSIF _magic_level IS NOT NULL THEN
    RAISE EXCEPTION 'Nível de magia só pode ser usado em dano mágico ou híbrido';
  END IF;

  SELECT ca.current_value INTO _hp_before
  FROM public.character_attributes ca
  WHERE ca.character_id = _character_id AND ca.attribute_key = 'hp'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'O alvo não possui atributo de HP';
  END IF;

  -- Compute physical and magical defense once; hybrid damage uses both.
  SELECT
    COALESCE(MAX(CASE WHEN ad.key = 'phys_def' THEN
      CASE
        WHEN ad.accepts_points THEN
          round(ad.base_value + (ca.points + COALESCE((r.modifiers ->> ad.key)::numeric, 0) + COALESCE((v.modifiers ->> ad.key)::numeric, 0) + CASE WHEN ad.key = 'phys_def' THEN COALESCE((c.race_physical_allocations ->> 'phys_def')::numeric, 0) + COALESCE((c.virtue_physical_allocations ->> 'phys_def')::numeric, 0) ELSE 0 END) * ad.points_multiplier + ca.bonus)
        ELSE
          ca.max_value + COALESCE((r.modifiers ->> ad.key)::numeric, 0) + COALESCE((v.modifiers ->> ad.key)::numeric, 0) + ca.bonus
      END
    END), 0),
    COALESCE(MAX(CASE WHEN ad.key = 'mag_def' THEN
      CASE
        WHEN ad.accepts_points THEN
          round(ad.base_value + (ca.points + COALESCE((r.modifiers ->> ad.key)::numeric, 0) + COALESCE((v.modifiers ->> ad.key)::numeric, 0) + CASE WHEN ad.key = 'phys_def' THEN COALESCE((c.race_physical_allocations ->> 'phys_def')::numeric, 0) + COALESCE((c.virtue_physical_allocations ->> 'phys_def')::numeric, 0) ELSE 0 END) * ad.points_multiplier + ca.bonus)
        ELSE
          ca.max_value + COALESCE((r.modifiers ->> ad.key)::numeric, 0) + COALESCE((v.modifiers ->> ad.key)::numeric, 0) + ca.bonus
      END
    END), 0)
  INTO _physical_defense, _magical_defense
  FROM public.attribute_definitions ad
  JOIN public.character_attributes ca
    ON ca.attribute_key = ad.key AND ca.character_id = _character_id
  JOIN public.characters c ON c.id = ca.character_id
  LEFT JOIN public.races r ON r.id = c.race_id
  LEFT JOIN public.virtues v ON v.id = c.virtue_id
  WHERE ad.key IN ('phys_def', 'mag_def');

  _physical_defense := GREATEST(0, COALESCE(_physical_defense, 0));
  _magical_defense := GREATEST(0, COALESCE(_magical_defense, 0));

  FOR _item IN SELECT elem FROM jsonb_array_elements(_damage_values) AS items(elem) LOOP
    IF jsonb_typeof(_item) <> 'number' THEN
      RAISE EXCEPTION 'Cada dano precisa ser um número';
    END IF;
    _raw := (_item #>> '{}')::numeric;
    IF _raw < 0 OR _raw > 1000000 THEN
      RAISE EXCEPTION 'Cada dano deve ficar entre 0 e 1000000';
    END IF;

    IF _damage_kind = 'physical' THEN
      _rounded_raw := round(
        GREATEST(0, _raw + _damage_any_fixed + _damage_physical_fixed)
        * GREATEST(0, 1 + (_damage_any_percent + _damage_physical_percent) / 100)
      )::integer;
      _dealt := GREATEST(0, _rounded_raw - _physical_defense)::integer;
    ELSIF _damage_kind = 'magical' THEN
      _rounded_raw := round(
        GREATEST(0, _raw + _damage_any_fixed + _damage_magical_fixed)
        * GREATEST(0, 1 + (_damage_any_percent + _damage_magical_percent) / 100)
      )::integer;
      _dealt := GREATEST(0, _rounded_raw - _magical_defense)::integer;
    ELSIF _damage_kind = 'hybrid' THEN
      -- Apply the universal flat bonus once to the full hit before splitting it.
      -- Then apply type-specific flat bonuses to their own half, with universal and
      -- matching type-specific percentages. Odd damage assigns its extra point to magic.
      _rounded_raw := round(GREATEST(0, _raw + _damage_any_fixed))::integer;
      _physical_part := floor(_rounded_raw / 2.0)::integer;
      _magical_part := _rounded_raw - _physical_part;
      _physical_part := round(
        GREATEST(0, _physical_part + _damage_physical_fixed)
        * GREATEST(0, 1 + (_damage_any_percent + _damage_physical_percent) / 100)
      )::integer;
      _magical_part := round(
        GREATEST(0, _magical_part + _damage_magical_fixed)
        * GREATEST(0, 1 + (_damage_any_percent + _damage_magical_percent) / 100)
      )::integer;
      _dealt := (
        GREATEST(0, _physical_part - _physical_defense)
        + GREATEST(0, _magical_part - _magical_defense)
      )::integer;
    ELSE
      -- True damage is affected only by "any" modifiers and ignores both defenses.
      _rounded_raw := round(
        GREATEST(0, _raw + _damage_any_fixed)
        * GREATEST(0, 1 + _damage_any_percent / 100)
      )::integer;
      _dealt := _rounded_raw;
    END IF;

    _total_damage := _total_damage + _dealt;
    _hits := _hits + 1;
  END LOOP;

  _hp_after := GREATEST(0, _hp_before - _total_damage);
  UPDATE public.character_attributes
  SET current_value = _hp_after, updated_at = now()
  WHERE character_id = _character_id AND attribute_key = 'hp';

  RETURN jsonb_build_object(
    'hits', _hits,
    'physical_defense', _physical_defense,
    'magical_defense', _magical_defense,
    'total_damage', _total_damage,
    'hp_before', _hp_before,
    'hp_after', _hp_after,
    'damage_kind', _damage_kind,
    'magic_level', _magic_level,
    'damage_source_character_id', _source_character_id,
    'damage_fixed_modifier', _damage_fixed_modifier,
    'damage_percent_modifier', _damage_percent_modifier,
    'damage_any_fixed_modifier', _damage_any_fixed,
    'damage_any_percent_modifier', _damage_any_percent,
    'damage_physical_fixed_modifier', _damage_physical_fixed,
    'damage_physical_percent_modifier', _damage_physical_percent,
    'damage_magical_fixed_modifier', _damage_magical_fixed,
    'damage_magical_percent_modifier', _damage_magical_percent
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_battle_damage(uuid, uuid, text, uuid, jsonb, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_battle_damage(uuid, uuid, text, uuid, jsonb, text, uuid) TO authenticated;
