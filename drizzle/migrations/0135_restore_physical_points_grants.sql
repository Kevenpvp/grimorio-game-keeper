-- Race and virtue selections had stopped writing physical_bonus_points to
-- character grants after database migration. Preserve all existing allocations
-- when confirming the same trait; clear allocations only when changing source.
CREATE OR REPLACE FUNCTION public.choose_character_race(_character_id uuid, _race_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _c public.characters;
  _race_bonus integer := 0;
  _race_physical_bonus integer := 0;
  _old_body_mod integer := 0;
  _old_sanity_mod integer := 0;
  _new_body_mod integer := 0;
  _new_sanity_mod integer := 0;
  _new_hp_max integer;
  _master boolean := public.has_role(auth.uid(), 'master');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;

  SELECT * INTO _c FROM public.characters WHERE id = _character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;

  IF NOT _master THEN
    IF _c.owner_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Sem permissão'; END IF;
    IF _race_id IS NULL THEN RAISE EXCEPTION 'Escolha uma raça'; END IF;
    IF _c.race_id IS NOT NULL AND _c.race_id IS DISTINCT FROM _race_id THEN
      RAISE EXCEPTION 'A raça já foi escolhida; peça ao mestre para trocar';
    END IF;
  END IF;

  IF _c.race_id IS NOT NULL THEN
    SELECT COALESCE((r.modifiers ->> 'body')::integer, 0),
           COALESCE((r.modifiers ->> 'sanity')::integer, 0)
    INTO _old_body_mod, _old_sanity_mod
    FROM public.races r WHERE r.id = _c.race_id;
  END IF;

  IF _race_id IS NOT NULL THEN
    SELECT r.bonus_points,
           r.physical_bonus_points,
           COALESCE((r.modifiers ->> 'body')::integer, 0),
           COALESCE((r.modifiers ->> 'sanity')::integer, 0)
    INTO _race_bonus, _race_physical_bonus, _new_body_mod, _new_sanity_mod
    FROM public.races r WHERE r.id = _race_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raça não encontrada'; END IF;
  END IF;

  UPDATE public.characters
  SET race_id = _race_id,
      body = GREATEST(0, LEAST(100, _c.body - _old_body_mod + _new_body_mod)),
      sanity = GREATEST(0, LEAST(100, _c.sanity - _old_sanity_mod + _new_sanity_mod)),
      available_points = GREATEST(0, available_points - COALESCE(race_points_granted, 0) + _race_bonus),
      race_points_granted = _race_bonus,
      race_physical_points_granted = COALESCE(_race_physical_bonus, 0),
      race_physical_allocations = CASE
        WHEN _c.race_id IS DISTINCT FROM _race_id THEN '{}'::jsonb
        ELSE race_physical_allocations END
  WHERE id = _character_id;

  -- A mudança de raça pode reduzir ou aumentar o HP máximo efetivo.
  -- Só recarregamos HP quando a raça realmente mudou; confirmar a mesma raça
  -- não deve curar o personagem novamente.
  IF _c.race_id IS DISTINCT FROM _race_id THEN
    _new_hp_max := public.calculate_character_resource_max(_character_id, 'hp')::integer;

    UPDATE public.character_attributes
    SET current_value = _new_hp_max,
        updated_at = now()
    WHERE character_id = _character_id
      AND attribute_key = 'hp';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'O atributo de HP não foi encontrado para a ficha';
    END IF;
  END IF;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.choose_character_virtue(_character_id uuid, _virtue_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _c public.characters;
  _virtue_bonus integer := 0;
  _virtue_physical_bonus integer := 0;
  _old_body_mod integer := 0;
  _old_sanity_mod integer := 0;
  _new_body_mod integer := 0;
  _new_sanity_mod integer := 0;
  _master boolean := public.has_role(auth.uid(), 'master');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;

  SELECT * INTO _c FROM public.characters WHERE id = _character_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;

  IF NOT _master THEN
    IF _c.owner_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Sem permissão'; END IF;
    IF _c.race_id IS NULL THEN RAISE EXCEPTION 'Confirme sua raça antes de escolher a virtude'; END IF;
    IF _virtue_id IS NULL THEN RAISE EXCEPTION 'Escolha uma virtude'; END IF;
    IF _c.virtue_id IS NOT NULL AND _c.virtue_id IS DISTINCT FROM _virtue_id THEN
      RAISE EXCEPTION 'A virtude já foi escolhida; peça ao mestre para trocar';
    END IF;
  END IF;

  IF _c.virtue_id IS NOT NULL THEN
    SELECT COALESCE(v.modifiers ->> 'body', '0')::integer,
           COALESCE(v.modifiers ->> 'sanity', '0')::integer
    INTO _old_body_mod, _old_sanity_mod
    FROM public.virtues v WHERE v.id = _c.virtue_id;
  END IF;

  IF _virtue_id IS NOT NULL THEN
    SELECT v.bonus_points,
           v.physical_bonus_points,
           COALESCE(v.modifiers ->> 'body', '0')::integer,
           COALESCE(v.modifiers ->> 'sanity', '0')::integer
    INTO _virtue_bonus, _virtue_physical_bonus, _new_body_mod, _new_sanity_mod
    FROM public.virtues v WHERE v.id = _virtue_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Virtude não encontrada'; END IF;
  END IF;

  UPDATE public.characters
  SET virtue_id = _virtue_id,
      body = GREATEST(0, LEAST(100, _c.body - _old_body_mod + _new_body_mod)),
      sanity = GREATEST(0, LEAST(100, _c.sanity - _old_sanity_mod + _new_sanity_mod)),
      available_points = GREATEST(0, available_points - COALESCE(virtue_points_granted, 0) + _virtue_bonus),
      virtue_points_granted = _virtue_bonus,
      virtue_physical_points_granted = COALESCE(_virtue_physical_bonus,0),
      virtue_physical_allocations = CASE
        WHEN _c.virtue_id IS DISTINCT FROM _virtue_id THEN '{}'::jsonb
        ELSE virtue_physical_allocations END
  WHERE id = _character_id;
END;
$function$
;

-- Repair migrated character balances without touching distributed allocations.
-- Existing investments survive unchanged. Points available are computed by
-- subtracting each saved allocation from the grant.
UPDATE public.characters c
SET race_physical_points_granted = COALESCE(r.physical_bonus_points,0)
FROM public.races r
WHERE c.race_id=r.id
  AND c.race_physical_points_granted IS DISTINCT FROM COALESCE(r.physical_bonus_points,0);
UPDATE public.characters c
SET virtue_physical_points_granted = COALESCE(v.physical_bonus_points,0)
FROM public.virtues v
WHERE c.virtue_id=v.id
  AND c.virtue_physical_points_granted IS DISTINCT FROM COALESCE(v.physical_bonus_points,0);

NOTIFY pgrst,'reload schema';
