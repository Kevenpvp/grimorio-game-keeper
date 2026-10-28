-- Sustained abilities can drain Mana, HP, Body or Sanity on each combat turn.
-- HP/Mana: absolute units or percent of the current maximum.
-- Body/Sanity: percentage points of the 0-100 resource only.
ALTER TABLE public.abilities
  ADD COLUMN IF NOT EXISTS sustain_costs jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.character_abilities
  ADD COLUMN IF NOT EXISTS sustain_costs jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE OR REPLACE FUNCTION public.valid_sustain_costs(_costs jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='public'
AS $fn$
DECLARE _entry jsonb; _resource text; _mode text; _amount numeric; _seen text[] := '{}';
BEGIN
 IF _costs IS NULL OR jsonb_typeof(_costs)<>'array' OR jsonb_array_length(_costs)>4 THEN RETURN false; END IF;
 FOR _entry IN SELECT value FROM jsonb_array_elements(_costs) LOOP
   IF jsonb_typeof(_entry)<>'object' THEN RETURN false; END IF;
   _resource:=_entry->>'resource';
   _mode:=_entry->>'mode';
   IF _resource IS NULL OR _resource NOT IN ('mana','hp','body','sanity')
      OR _resource=ANY(_seen) THEN RETURN false; END IF;
   _seen:=array_append(_seen,_resource);
   IF _mode NOT IN ('fixed','percent') OR _mode IS NULL THEN RETURN false; END IF;
   IF _resource IN ('body','sanity') AND _mode<>'percent' THEN RETURN false; END IF;
   IF jsonb_typeof(_entry->'amount')<>'number' THEN RETURN false; END IF;
   _amount:=(_entry->>'amount')::numeric;
   IF _amount < 0 OR _amount > (CASE WHEN _mode='percent' THEN 100 ELSE 1000000 END) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
 RETURN false;
END;
$fn$;
REVOKE ALL ON FUNCTION public.valid_sustain_costs(jsonb) FROM PUBLIC,anon,authenticated;
ALTER TABLE public.abilities ADD CONSTRAINT abilities_sustain_costs_check CHECK (public.valid_sustain_costs(sustain_costs));
ALTER TABLE public.character_abilities ADD CONSTRAINT character_abilities_sustain_costs_check CHECK (public.valid_sustain_costs(sustain_costs));

-- Any new assignment, from a catalog, a race, a virtue, a transformation
-- or an inventory item, inherits the catalog's default drain configuration.
CREATE OR REPLACE FUNCTION public.assign_catalog_sustain_costs()
RETURNS trigger LANGUAGE plpgsql SET search_path='public'
AS $fn$
BEGIN
  IF NEW.ability_id IS NOT NULL AND NEW.sustain_costs='[]'::jsonb THEN
    SELECT a.sustain_costs INTO NEW.sustain_costs
    FROM public.abilities a WHERE a.id=NEW.ability_id;
    NEW.sustain_costs:=COALESCE(NEW.sustain_costs,'[]'::jsonb);
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS assign_catalog_sustain_costs_trigger ON public.character_abilities;
CREATE TRIGGER assign_catalog_sustain_costs_trigger
BEFORE INSERT ON public.character_abilities
FOR EACH ROW EXECUTE FUNCTION public.assign_catalog_sustain_costs();

-- Catalog edits update uncustomized assignments only. Every sheet-specific
-- override remains independent of the shared catalog definition.
CREATE OR REPLACE FUNCTION public.update_catalog_sustain_costs()
RETURNS trigger LANGUAGE plpgsql SET search_path='public'
AS $fn$
BEGIN
  IF OLD.sustain_costs IS DISTINCT FROM NEW.sustain_costs THEN
    IF EXISTS(
      SELECT 1 FROM public.character_abilities ca
      WHERE ca.ability_id=NEW.id AND ca.toggle_active
        AND ca.sustain_costs IS NOT DISTINCT FROM OLD.sustain_costs
    ) THEN
      RAISE EXCEPTION 'Desative a habilidade sustentada antes de mudar o consumo por turno';
    END IF;
    UPDATE public.character_abilities ca
    SET sustain_costs=NEW.sustain_costs
    WHERE ca.ability_id=NEW.id
      AND (ca.sustain_costs=OLD.sustain_costs OR ca.sustain_costs='[]'::jsonb);
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS update_catalog_sustain_costs_trigger ON public.abilities;
CREATE TRIGGER update_catalog_sustain_costs_trigger
AFTER UPDATE OF sustain_costs ON public.abilities
FOR EACH ROW EXECUTE FUNCTION public.update_catalog_sustain_costs();

CREATE OR REPLACE FUNCTION public.tick_sustained_ability_costs_internal(
  _battle_id uuid,_character_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='public'
AS $fn$
DECLARE
  _ability record;
  _cost jsonb;
  _resource text;
  _mode text;
  _amount numeric;
  _maximum numeric;
  _current integer;
  _drain integer;
  _stop boolean;
BEGIN
  -- Called only by advance_combat_turn, which holds the master-only
  -- authorization and a row lock on this active battle.
  FOR _ability IN
    SELECT ca.id,ca.character_id,ca.sustain_costs
    FROM public.character_abilities ca
    JOIN public.battle_participants bp
      ON bp.battle_id=_battle_id AND bp.character_id=ca.character_id
    WHERE ca.toggle_mode AND ca.toggle_active AND ca.toggle_battle_id=_battle_id
      AND (_character_id IS NULL OR ca.character_id=_character_id)
      AND ca.sustain_costs<>'[]'::jsonb
    ORDER BY ca.character_id,ca.id
    FOR UPDATE OF ca
  LOOP
    _stop:=false;
    FOR _cost IN SELECT value FROM jsonb_array_elements(_ability.sustain_costs)
    LOOP
      _resource:=_cost->>'resource';
      _mode:=_cost->>'mode';
      _amount:=(_cost->>'amount')::numeric;
      IF _amount<=0 THEN CONTINUE; END IF;

      IF _resource IN ('mana','hp') THEN
        SELECT current_value INTO _current FROM public.character_attributes
        WHERE character_id=_ability.character_id AND attribute_key=_resource FOR UPDATE;
        IF NOT FOUND THEN CONTINUE; END IF;
        _maximum:=CASE WHEN _mode='percent'
          THEN public.calculate_character_resource_max(_ability.character_id,_resource)
          ELSE 0 END;
        _drain:=CASE WHEN _mode='percent'
          THEN CEIL(GREATEST(0,_maximum)*_amount/100)::integer
          ELSE CEIL(_amount)::integer END;
        _drain:=GREATEST(0,_drain);
        IF _drain>0 THEN
          UPDATE public.character_attributes
          SET current_value=GREATEST(0,COALESCE(current_value,0)-_drain),updated_at=now()
          WHERE character_id=_ability.character_id AND attribute_key=_resource;
          IF _current<=_drain THEN _stop:=true; END IF;
        END IF;
      ELSE
        -- Body and Sanity are stored as 0-100 percentage points. A 5%
        -- configured drain means subtract five points from that meter.
        _drain:=CEIL(_amount)::integer;
        IF _drain>0 THEN
          IF _resource='body' THEN
            UPDATE public.characters
            SET body=GREATEST(0,body-_drain)
            WHERE id=_ability.character_id RETURNING body INTO _current;
          ELSE
            UPDATE public.characters
            SET sanity=GREATEST(0,sanity-_drain)
            WHERE id=_ability.character_id RETURNING sanity INTO _current;
          END IF;
          IF _current=0 THEN _stop:=true; END IF;
        END IF;
      END IF;
    END LOOP;

    IF _stop THEN
      -- Use the normal deactivation lifecycle: clean the active effects,
      -- fire end effects and start its original cooldown (incl. virtue reductions).
      PERFORM public.turn_off_character_ability(_ability.id,_battle_id);
    END IF;
  END LOOP;
END;
$fn$;
REVOKE ALL ON FUNCTION public.tick_sustained_ability_costs_internal(uuid,uuid)
  FROM PUBLIC,anon,authenticated;

-- Integrate before the existing regeneration and duration ticking. Both global
-- and individual turns pass through exactly the same atomic server routine.
DO $patch$
DECLARE
  _fn text;
  _old text := '  -- Apply the configured base regeneration using current database modifiers before ticking durations.';
  _new text := E'  -- Drain each sustained ability on its owner''s turn (never for unrelated fighters).\\n  PERFORM public.tick_sustained_ability_costs_internal(_battle_id,_character_id);\\n\\n' || _old;
BEGIN
  SELECT pg_get_functiondef('public.advance_combat_turn(uuid,uuid,jsonb)'::regprocedure)
  INTO _fn;
  IF position(_old IN _fn)=0 THEN
    RAISE EXCEPTION 'advance_combat_turn has changed; sustained cost integration needs review';
  END IF;
  EXECUTE replace(_fn,_old,_new);
END;
$patch$;

-- Retain accessory-specific ability configurations when the accessory
-- is unequipped/re-equipped.
DO $patch$
DECLARE _fn text;
BEGIN
 SELECT pg_get_functiondef('public.inventory_snapshot_grant_customizations_internal(uuid)'::regprocedure) INTO _fn;
 IF position('''once_per_battle'',ca.once_per_battle,' IN _fn)=0 THEN
   RAISE EXCEPTION 'Accessory snapshot format changed';
 END IF;
 EXECUTE replace(_fn,
   '''once_per_battle'',ca.once_per_battle,',
   '''once_per_battle'',ca.once_per_battle,''sustain_costs'',ca.sustain_costs,'
 );
 SELECT pg_get_functiondef('public.inventory_restore_grant_customizations_internal(uuid)'::regprocedure) INTO _fn;
 IF position('      effects=COALESCE(_entry.value->''effects'',ca.effects),' IN _fn)=0 THEN
   RAISE EXCEPTION 'Accessory restore format changed';
 END IF;
 EXECUTE replace(_fn,
   '      effects=COALESCE(_entry.value->''effects'',ca.effects),',
   '      sustain_costs=COALESCE(_entry.value->''sustain_costs'',ca.sustain_costs),' || E'\n' ||
   '      effects=COALESCE(_entry.value->''effects'',ca.effects),'
 );
END;
$patch$;
