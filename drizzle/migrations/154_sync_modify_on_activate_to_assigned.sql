BEGIN;
CREATE OR REPLACE FUNCTION public.merge_catalog_activation_value_flags(
  _assigned jsonb, _old jsonb, _catalog jsonb, _backfill boolean DEFAULT false
)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $function$
 SELECT COALESCE(jsonb_agg(
   CASE WHEN
     entry.effect->>'name' = entry.catalog->>'name'
     AND entry.effect->>'effect_type' = entry.catalog->>'effect_type'
     AND (
       (_backfill AND coalesce((entry.catalog->>'modify_on_activate')::boolean,false))
       OR (
         entry.effect->>'name'=entry.previous->>'name'
         AND entry.effect->>'effect_type'=entry.previous->>'effect_type'
         AND coalesce((entry.previous->>'modify_on_activate')::boolean,false)
           IS DISTINCT FROM coalesce((entry.catalog->>'modify_on_activate')::boolean,false)
       )
     )
   THEN jsonb_set(entry.effect,'{modify_on_activate}',
     to_jsonb(coalesce((entry.catalog->>'modify_on_activate')::boolean,false)),true)
   ELSE entry.effect
   END ORDER BY entry.position), '[]'::jsonb)
 FROM (
    SELECT e.effect,e.position,
      _catalog->((e.position-1)::integer) AS catalog,
      _old->((e.position-1)::integer) AS previous
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(_assigned)='array'
      THEN _assigned ELSE '[]'::jsonb END) WITH ORDINALITY e(effect,position)
 ) entry;
$function$;

CREATE OR REPLACE FUNCTION public.sync_catalog_activation_value_flags()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
 IF OLD.effects IS NOT DISTINCT FROM NEW.effects THEN RETURN NEW; END IF;
 UPDATE public.character_abilities ca
 SET effects=public.merge_catalog_activation_value_flags(ca.effects,OLD.effects,NEW.effects)
 WHERE ca.ability_id=NEW.id
 AND ca.effects IS DISTINCT FROM
  public.merge_catalog_activation_value_flags(ca.effects,OLD.effects,NEW.effects);
 RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS abilities_sync_modify_on_activate ON public.abilities;
CREATE TRIGGER abilities_sync_modify_on_activate
AFTER UPDATE OF effects ON public.abilities FOR EACH ROW
EXECUTE FUNCTION public.sync_catalog_activation_value_flags();

-- Bring current grants in line with any already-enabled global flags,
-- without changing per-character effect values/durations.
UPDATE public.character_abilities ca
SET effects=public.merge_catalog_activation_value_flags(ca.effects,a.effects,a.effects,true)
FROM public.abilities a WHERE ca.ability_id=a.id
AND ca.effects IS DISTINCT FROM
  public.merge_catalog_activation_value_flags(ca.effects,a.effects,a.effects,true);

REVOKE ALL ON FUNCTION public.merge_catalog_activation_value_flags(jsonb,jsonb,jsonb,boolean)
FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.sync_catalog_activation_value_flags()
FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;