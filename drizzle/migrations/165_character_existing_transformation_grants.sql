-- Add existing catalog transformations to one character without granting them to every
-- character of the same race/class/virtue. The character gets a private copy;
-- optional origin links use the existing cleanup_trait_linked_content trigger.
CREATE OR REPLACE FUNCTION public.grant_catalog_transformation_to_character(
  _character_id uuid, _transformation_id uuid, _link_kind text DEFAULT 'none'
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  _character public.characters%ROWTYPE;
  _template public.transformations%ROWTYPE;
  _copy_id uuid;
  _race uuid;
  _virtue uuid;
  _class uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode conceder transformações';
  END IF;
  SELECT * INTO _character FROM public.characters WHERE id = _character_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;
  SELECT * INTO _template FROM public.transformations WHERE id = _transformation_id
    AND owner_character_id IS NULL AND source_transformation_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Selecione uma transformação do catálogo geral'; END IF;
  IF _link_kind NOT IN ('none','race','virtue','class') OR _link_kind IS NULL THEN
    RAISE EXCEPTION 'Origem do vínculo inválida';
  END IF;
  IF _link_kind = 'race' THEN
    _race := _character.race_id;
    IF _race IS NULL THEN RAISE EXCEPTION 'A ficha ainda não possui Raça'; END IF;
  ELSIF _link_kind = 'virtue' THEN
    _virtue := _character.virtue_id;
    IF _virtue IS NULL THEN RAISE EXCEPTION 'A ficha ainda não possui Virtude'; END IF;
  ELSIF _link_kind = 'class' THEN
    _class := _character.class_id;
    IF _class IS NULL THEN RAISE EXCEPTION 'A ficha ainda não possui Classe'; END IF;
  END IF;

  SELECT id INTO _copy_id FROM public.transformations
  WHERE owner_character_id = _character_id AND source_transformation_id = _transformation_id
  FOR UPDATE;
  IF _copy_id IS NULL THEN
    INSERT INTO public.transformations (
      owner_character_id,source_transformation_id,linked_by_race_id,
      linked_by_virtue_id,linked_by_class_id,name,description,duration_turns,
      cooldown_turns,mana_cost,modifiers,effects,end_effects
    ) VALUES (
      _character_id,_template.id,_race,_virtue,_class,_template.name,
      _template.description,_template.duration_turns,_template.cooldown_turns,
      _template.mana_cost,_template.modifiers,_template.effects,_template.end_effects
    ) RETURNING id INTO _copy_id;
    INSERT INTO public.transformation_abilities(transformation_id,ability_id,only_while_transformed)
      SELECT _copy_id, ability_id, only_while_transformed FROM public.transformation_abilities
      WHERE transformation_id = _transformation_id
      ON CONFLICT (transformation_id,ability_id) DO NOTHING;
  ELSE
    -- Never overwrite edits to an existing private copy.
    UPDATE public.transformations SET linked_by_race_id=_race,linked_by_virtue_id=_virtue,
      linked_by_class_id=_class, updated_at=now()
    WHERE id=_copy_id AND owner_character_id=_character_id;
  END IF;

  INSERT INTO public.character_transformations(character_id,transformation_id,active,cooldown_remaining)
  VALUES (_character_id,_copy_id,false,0)
  ON CONFLICT (character_id,transformation_id) DO NOTHING;
  RETURN _copy_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.revoke_catalog_transformation_from_character(
  _character_id uuid, _source_transformation_id uuid
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  _copy_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode remover transformações';
  END IF;
  SELECT t.id INTO _copy_id FROM public.transformations t
  WHERE t.owner_character_id=_character_id AND t.source_transformation_id=_source_transformation_id
  FOR UPDATE;
  IF _copy_id IS NULL THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM public.character_transformations ct WHERE ct.character_id=_character_id
    AND ct.transformation_id=_copy_id AND ct.active=true) THEN
    RAISE EXCEPTION 'Encerre a transformação ativa antes de removê-la da ficha';
  END IF;
  DELETE FROM public.transformations WHERE id=_copy_id AND owner_character_id=_character_id;
  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION public.grant_catalog_transformation_to_character(uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.grant_catalog_transformation_to_character(uuid,uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.revoke_catalog_transformation_from_character(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.revoke_catalog_transformation_from_character(uuid,uuid) TO authenticated;
