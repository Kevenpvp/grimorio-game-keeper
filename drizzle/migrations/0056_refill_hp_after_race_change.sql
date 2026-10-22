CREATE OR REPLACE FUNCTION public.choose_character_race(_character_id uuid, _race_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _c public.characters;
  _race_bonus integer := 0;
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
           COALESCE((r.modifiers ->> 'body')::integer, 0),
           COALESCE((r.modifiers ->> 'sanity')::integer, 0)
    INTO _race_bonus, _new_body_mod, _new_sanity_mod
    FROM public.races r WHERE r.id = _race_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Raça não encontrada'; END IF;
  END IF;

  UPDATE public.characters
  SET race_id = _race_id,
      body = GREATEST(0, LEAST(100, _c.body - _old_body_mod + _new_body_mod)),
      sanity = GREATEST(0, LEAST(100, _c.sanity - _old_sanity_mod + _new_sanity_mod)),
      available_points = GREATEST(0, available_points - COALESCE(race_points_granted, 0) + _race_bonus),
      race_points_granted = _race_bonus
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
$function$;
