-- Player sheets can inspect transformations but may not create or modify their setup.
DROP POLICY IF EXISTS transformations_owner_manage ON public.transformations;
DROP POLICY IF EXISTS transformation_abilities_owner_manage ON public.transformation_abilities;

DROP POLICY IF EXISTS players_insert_own_character_transformations ON public.character_transformations;
DROP POLICY IF EXISTS players_delete_own_character_transformations ON public.character_transformations;
DROP POLICY IF EXISTS character_transformations_master_manage ON public.character_transformations;

CREATE POLICY character_transformations_master_manage
  ON public.character_transformations
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'master'))
  WITH CHECK (public.has_role(auth.uid(), 'master'));

CREATE OR REPLACE FUNCTION public.set_character_transformation_image(
  _character_id uuid,
  _transformation_id uuid,
  _image_path text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _character public.characters;
  _prefix text;
  _master boolean := public.has_role(auth.uid(),'master');
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;
  IF NOT _master THEN
    RAISE EXCEPTION 'Somente o mestre pode alterar a imagem da transformação';
  END IF;

  SELECT * INTO _character FROM public.characters WHERE id=_character_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ficha não encontrada'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.race_transformations rt JOIN public.characters c ON c.race_id=rt.race_id
    WHERE c.id=_character_id AND rt.transformation_id=_transformation_id
    UNION ALL
    SELECT 1 FROM public.virtue_transformations vt JOIN public.characters c ON c.virtue_id=vt.virtue_id
    WHERE c.id=_character_id AND vt.transformation_id=_transformation_id
    UNION ALL
    SELECT 1 FROM public.transformations t
    WHERE t.id=_transformation_id AND t.owner_character_id=_character_id
  ) THEN RAISE EXCEPTION 'Esta transformação não está disponível para o personagem'; END IF;

  _prefix := _character_id::text || '/transformations/' || _transformation_id::text || '/';
  IF _image_path IS NOT NULL AND left(_image_path,length(_prefix)) <> _prefix THEN
    RAISE EXCEPTION 'Caminho de imagem de transformação inválido';
  END IF;

  INSERT INTO public.character_transformations(character_id,transformation_id,image_path)
  VALUES (_character_id,_transformation_id,_image_path)
  ON CONFLICT (character_id,transformation_id)
  DO UPDATE SET image_path=EXCLUDED.image_path,updated_at=now();
END;
$function$;

REVOKE ALL ON FUNCTION public.set_character_transformation_image(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_character_transformation_image(uuid,uuid,text) TO authenticated, service_role;
