-- Register the trusted Barrincar script for custom sheet abilities and
-- attach it to Roxy Mongrel's existing ability, without creating a duplicate.
ALTER TABLE public.character_abilities
  DROP CONSTRAINT IF EXISTS custom_sheet_script_allowed;
ALTER TABLE public.character_abilities
  ADD CONSTRAINT custom_sheet_script_allowed CHECK (
    custom_script_key IS NULL
    OR custom_script_key = ANY (ARRAY[
      'example','demonio_interno','coracao_corrompido',
      'sedento_por_sangue','barrincar'
    ])
  );

DO $barrincar$
DECLARE _count integer;
BEGIN
  UPDATE public.character_abilities ca
  SET custom_script_key='barrincar',
      is_passive=true,
      can_activate=false,
      custom_state='{}'::jsonb
  FROM public.characters c
  WHERE ca.id='53070a71-0106-4113-b5d4-361c4509b88b'::uuid
    AND ca.character_id='b6a04ab2-5d69-4ef1-a313-3471c612bc6c'::uuid
    AND c.id=ca.character_id
    AND lower(c.name)='roxy mongrel'
    AND lower(ca.name)='barrincar';
  GET DIAGNOSTICS _count=ROW_COUNT;
  IF _count<>1 THEN
    RAISE EXCEPTION 'Habilidade Barrincar da ficha Roxy Mongrel não encontrada; nenhuma outra ficha será alterada';
  END IF;
END;
$barrincar$;
