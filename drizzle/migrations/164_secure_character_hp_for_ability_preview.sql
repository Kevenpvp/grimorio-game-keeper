-- Internal maximum HP RPC is intentionally inaccessible to browser roles.
-- Provide a small, ownership-checked read for the Demonio Interno preview.
-- This does not grant direct access to calculate_character_resource_max.
CREATE OR REPLACE FUNCTION public.get_character_hp_for_ability_preview(_character_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _user_id uuid := auth.uid();
  _owner_id uuid;
  _current_hp numeric;
  _configured_max numeric;
  _effective_max numeric;
BEGIN
  IF _user_id IS NULL OR _character_id IS NULL THEN
    RAISE EXCEPTION 'Acesso não autorizado ao HP do personagem';
  END IF;

  SELECT owner_id INTO _owner_id FROM public.characters WHERE id = _character_id;
  IF NOT FOUND OR (COALESCE(public.has_role(_user_id, 'master'), false) IS DISTINCT FROM true
    AND _owner_id IS DISTINCT FROM _user_id) THEN
    RAISE EXCEPTION 'Acesso não autorizado ao HP do personagem';
  END IF;

  SELECT current_value, max_value
  INTO _current_hp, _configured_max
  FROM public.character_attributes
  WHERE character_id = _character_id AND attribute_key = 'hp';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A ficha não possui um atributo HP configurado';
  END IF;

  _effective_max := public.calculate_character_resource_max(_character_id, 'hp');
  RETURN jsonb_build_object(
    'current', greatest(0, coalesce(_current_hp, 0)),
    'maximum', greatest(0, coalesce(_effective_max, 0)),
    'configured_max', greatest(0, coalesce(_configured_max, 0))
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_character_hp_for_ability_preview(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_character_hp_for_ability_preview(uuid) TO authenticated;
