CREATE OR REPLACE FUNCTION public.apply_virtue_cooldown_reduction()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE _race jsonb; _class jsonb; _virtue uuid; _r numeric; _c numeric; _rblock boolean; _cblock boolean;
BEGIN
 IF NEW.cooldown_remaining <= 0 OR NEW.cooldown_remaining = OLD.cooldown_remaining THEN RETURN NEW; END IF;
 -- Only modify when a fresh cooldown is started, not when the master edits an active cooldown.
 IF OLD.cooldown_remaining > 0 OR NEW.cooldown_remaining <> NEW.cooldown_turns THEN RETURN NEW; END IF;
 _virtue := coalesce(NEW.linked_by_virtue_id, NEW.granted_by_virtue_id);
 IF _virtue IS NULL THEN RETURN NEW; END IF;
 SELECT coalesce(r.special_mechanics,'{}'::jsonb),coalesce(cl.special_mechanics,'{}'::jsonb)
 INTO _race,_class FROM public.characters ch
 LEFT JOIN public.races r ON r.id=ch.race_id LEFT JOIN public.classes cl ON cl.id=ch.class_id
 WHERE ch.id=NEW.character_id AND ch.virtue_id=_virtue;
 IF NOT FOUND THEN RETURN NEW; END IF;
 _rblock := coalesce(_race->'virtue_effect_blacklist','[]'::jsonb) ? _virtue::text;
 _cblock := coalesce(_class->'virtue_effect_blacklist','[]'::jsonb) ? _virtue::text;
 _r := CASE WHEN _rblock THEN 0 ELSE greatest(0,least(100,coalesce(nullif(_race->>'virtue_cooldown_reduction_percent','')::numeric,0))) END;
 _c := CASE WHEN _cblock THEN 0 ELSE greatest(0,least(100,coalesce(nullif(_class->>'virtue_cooldown_reduction_percent','')::numeric,0))) END;
 NEW.cooldown_remaining := greatest(0,ceil(NEW.cooldown_turns*(1-_r/100)*(1-_c/100))::integer);
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_apply_virtue_cooldown_reduction ON public.character_abilities;
CREATE TRIGGER trg_apply_virtue_cooldown_reduction BEFORE UPDATE OF cooldown_remaining ON public.character_abilities
FOR EACH ROW EXECUTE FUNCTION public.apply_virtue_cooldown_reduction();