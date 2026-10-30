-- Optional, one-time HP/Body/Sanity costs for Ativar and first Atacar.
-- Attack continuation and repeated targets are deliberately not charged twice.
CREATE OR REPLACE FUNCTION public.valid_ability_activation_costs(_costs jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public'
AS $validation$
DECLARE _entry jsonb; _resource text; _mode text; _amount numeric; _seen text[]:='{}';
BEGIN
 IF _costs IS NULL OR jsonb_typeof(_costs)<>'array' OR jsonb_array_length(_costs)>3 THEN RETURN false; END IF;
 FOR _entry IN SELECT value FROM jsonb_array_elements(_costs) LOOP
   IF jsonb_typeof(_entry)<>'object' THEN RETURN false; END IF;
   _resource:=_entry->>'resource'; _mode:=_entry->>'mode';
   IF _resource IS NULL OR _resource NOT IN ('hp','body','sanity') OR _resource=ANY(_seen) THEN RETURN false; END IF;
   _seen:=array_append(_seen,_resource);
   IF _mode IS NULL OR _mode NOT IN ('fixed','percent') THEN RETURN false; END IF;
   IF _resource IN ('body','sanity') AND _mode<>'percent' THEN RETURN false; END IF;
   IF jsonb_typeof(_entry->'amount')<>'number' THEN RETURN false; END IF;
   _amount:=(_entry->>'amount')::numeric;
   IF _amount<0 OR _amount>(CASE WHEN _mode='percent' THEN 100 ELSE 1000000 END) THEN RETURN false; END IF;
   IF _mode='fixed' AND _amount<>trunc(_amount) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$validation$;

ALTER TABLE public.abilities
  ADD COLUMN IF NOT EXISTS activation_costs jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.character_abilities
  ADD COLUMN IF NOT EXISTS activation_costs jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.abilities
  ADD CONSTRAINT abilities_activation_costs_check
  CHECK (public.valid_ability_activation_costs(activation_costs));
ALTER TABLE public.character_abilities
  ADD CONSTRAINT character_abilities_activation_costs_check
  CHECK (public.valid_ability_activation_costs(activation_costs));

-- Existing grants receive the catalog's costs when they have no custom
-- override. New grants inherit them automatically; later edits preserve
-- personalized values that differ from the previous catalog definition.
UPDATE public.character_abilities ca
SET activation_costs=a.activation_costs
FROM public.abilities a
WHERE ca.ability_id=a.id AND ca.activation_costs='[]'::jsonb
  AND a.activation_costs<>'[]'::jsonb;

CREATE OR REPLACE FUNCTION public.assign_catalog_activation_costs()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $assign$
BEGIN
 IF NEW.ability_id IS NOT NULL AND NEW.activation_costs='[]'::jsonb THEN
   SELECT activation_costs INTO NEW.activation_costs FROM public.abilities WHERE id=NEW.ability_id;
   NEW.activation_costs:=COALESCE(NEW.activation_costs,'[]'::jsonb);
 END IF;
 RETURN NEW;
END;
$assign$;

DROP TRIGGER IF EXISTS assign_catalog_activation_costs ON public.character_abilities;
CREATE TRIGGER assign_catalog_activation_costs
BEFORE INSERT ON public.character_abilities
FOR EACH ROW EXECUTE FUNCTION public.assign_catalog_activation_costs();

CREATE OR REPLACE FUNCTION public.sync_catalog_activation_costs()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $sync$
BEGIN
 IF NEW.activation_costs IS DISTINCT FROM OLD.activation_costs THEN
   UPDATE public.character_abilities ca
   SET activation_costs=NEW.activation_costs
   WHERE ca.ability_id=NEW.id
     AND (ca.activation_costs=OLD.activation_costs OR ca.activation_costs='[]'::jsonb);
 END IF;
 RETURN NEW;
END;
$sync$;

DROP TRIGGER IF EXISTS sync_catalog_activation_costs ON public.abilities;
CREATE TRIGGER sync_catalog_activation_costs
AFTER UPDATE OF activation_costs ON public.abilities
FOR EACH ROW EXECUTE FUNCTION public.sync_catalog_activation_costs();

-- This internal helper is called from the existing SECURITY DEFINER
-- activation/attack transactions after Mana validation. Any error rolls back
-- BOTH Mana and the extra costs, plus effects/cooldowns.
CREATE OR REPLACE FUNCTION public.charge_ability_activation_costs_internal(
  _character_ability_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $charge$
DECLARE
 _caster_id uuid;
 _costs jsonb;
 _entry jsonb;
 _resource text;
 _mode text;
 _amount numeric;
 _drain integer;
 _available integer;
 _maximum numeric;
BEGIN
 SELECT character_id,activation_costs INTO _caster_id,_costs
 FROM public.character_abilities WHERE id=_character_ability_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Habilidade inexistente'; END IF;
 IF NOT public.valid_ability_activation_costs(_costs) THEN
   RAISE EXCEPTION 'Custos adicionais inválidos na habilidade';
 END IF;
 -- Lock character first for consistent ordering and body/sanity update.
 PERFORM 1 FROM public.characters WHERE id=_caster_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Personagem não encontrado'; END IF;

 FOR _entry IN SELECT value FROM jsonb_array_elements(_costs) LOOP
   _resource:=_entry->>'resource';
   _mode:=_entry->>'mode';
   _amount:=(_entry->>'amount')::numeric;
   IF _amount<=0 THEN CONTINUE; END IF;
   IF _resource='hp' THEN
     SELECT current_value INTO _available FROM public.character_attributes
     WHERE character_id=_caster_id AND attribute_key='hp' FOR UPDATE;
     IF NOT FOUND THEN RAISE EXCEPTION 'Esta ficha não possui HP'; END IF;
     _maximum:=CASE WHEN _mode='percent'
       THEN public.calculate_character_resource_max(_caster_id,'hp')
       ELSE 0 END;
     _drain:=CASE WHEN _mode='percent'
       THEN CEIL(GREATEST(0,_maximum)*_amount/100)::integer
       ELSE _amount::integer END;
     IF _available<_drain THEN
       RAISE EXCEPTION 'HP insuficiente para usar a habilidade: precisa de %, possui %',_drain,_available;
     END IF;
     UPDATE public.character_attributes
     SET current_value=current_value-_drain,updated_at=now()
     WHERE character_id=_caster_id AND attribute_key='hp';
   ELSE
     _drain:=CEIL(_amount)::integer;
     IF _resource='body' THEN
       SELECT body INTO _available FROM public.characters WHERE id=_caster_id;
       IF _available<_drain THEN
         RAISE EXCEPTION 'Corpo insuficiente para usar a habilidade: precisa de %, possui %',_drain,_available;
       END IF;
       UPDATE public.characters SET body=body-_drain WHERE id=_caster_id;
     ELSIF _resource='sanity' THEN
       SELECT sanity INTO _available FROM public.characters WHERE id=_caster_id;
       IF _available<_drain THEN
         RAISE EXCEPTION 'Sanidade insuficiente para usar a habilidade: precisa de %, possui %',_drain,_available;
       END IF;
       UPDATE public.characters SET sanity=sanity-_drain WHERE id=_caster_id;
     END IF;
   END IF;
 END LOOP;
END;
$charge$;

REVOKE ALL ON FUNCTION public.charge_ability_activation_costs_internal(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.valid_ability_activation_costs(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.valid_ability_activation_costs(jsonb) TO authenticated;

-- Inject the cost into the two original payment transactions. Replacing only
-- this unique text preserves all their prior targeting, scripts and effects.
DO $patch$
DECLARE
 _name text;
 _def text;
 _needle text := E'      where character_id = _assignment.character_id and attribute_key = ''mana'';\n  end if;\n\n  update public.character_abilities';
 _repl text := E'      where character_id = _assignment.character_id and attribute_key = ''mana'';\n  end if;\n\n  PERFORM public.charge_ability_activation_costs_internal(_assignment.id);\n\n  update public.character_abilities';
BEGIN
 FOREACH _name IN ARRAY ARRAY['activate_character_ability','activate_character_ability_attack']
 LOOP
   SELECT pg_get_functiondef(p.oid) INTO _def
   FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=_name LIMIT 1;
   IF _def IS NULL OR strpos(_def,_needle)=0
     OR strpos(substring(_def FROM strpos(_def,_needle)+length(_needle)),_needle)>0 THEN
     RAISE EXCEPTION 'Formato inesperado de %; alteração abortada',_name;
   END IF;
   EXECUTE replace(_def,_needle,_repl);
 END LOOP;
END;
$patch$;
