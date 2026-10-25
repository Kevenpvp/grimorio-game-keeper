ALTER TABLE public.characters
  ADD COLUMN IF NOT EXISTS is_summon_snapshot boolean NOT NULL DEFAULT false;
-- All original characters remain persistent and visible normally.
UPDATE public.characters SET is_summon_snapshot=false WHERE is_summon_snapshot IS DISTINCT FROM false;

DO $patch$
DECLARE _fn text;
BEGIN
  SELECT pg_get_functiondef('public.create_summon_instance(uuid,uuid,uuid,jsonb)'::regprocedure)
  INTO _fn;
  IF POSITION('photo_path,owner_id,body,sanity' IN _fn)=0
     OR POSITION('_template.photo_path,_summoner.owner_id,' IN _fn)=0 THEN
    RAISE EXCEPTION 'Estrutura de clonagem mudou';
  END IF;
  _fn := replace(_fn,'photo_path,owner_id,body,sanity',
    'photo_path,owner_id,is_summon_snapshot,body,sanity');
  _fn := replace(_fn,'_template.photo_path,_summoner.owner_id,',
    '_template.photo_path,_summoner.owner_id,true,');
  EXECUTE _fn;
END;
$patch$;
NOTIFY pgrst,'reload schema';