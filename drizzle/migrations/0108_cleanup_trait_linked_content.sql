CREATE OR REPLACE FUNCTION public.cleanup_trait_linked_content()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF OLD.race_id IS DISTINCT FROM NEW.race_id THEN
   DELETE FROM public.character_abilities WHERE character_id=NEW.id AND linked_by_race_id IS NOT NULL AND linked_by_race_id IS DISTINCT FROM NEW.race_id;
   DELETE FROM public.transformations WHERE owner_character_id=NEW.id AND linked_by_race_id IS NOT NULL AND linked_by_race_id IS DISTINCT FROM NEW.race_id;
 END IF;
 IF OLD.virtue_id IS DISTINCT FROM NEW.virtue_id THEN
   DELETE FROM public.character_abilities WHERE character_id=NEW.id AND linked_by_virtue_id IS NOT NULL AND linked_by_virtue_id IS DISTINCT FROM NEW.virtue_id;
   DELETE FROM public.transformations WHERE owner_character_id=NEW.id AND linked_by_virtue_id IS NOT NULL AND linked_by_virtue_id IS DISTINCT FROM NEW.virtue_id;
 END IF;
 IF OLD.class_id IS DISTINCT FROM NEW.class_id THEN
   DELETE FROM public.character_abilities WHERE character_id=NEW.id AND linked_by_class_id IS NOT NULL AND linked_by_class_id IS DISTINCT FROM NEW.class_id;
   DELETE FROM public.transformations WHERE owner_character_id=NEW.id AND linked_by_class_id IS NOT NULL AND linked_by_class_id IS DISTINCT FROM NEW.class_id;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_cleanup_trait_linked_content ON public.characters;
CREATE TRIGGER trg_cleanup_trait_linked_content AFTER UPDATE OF race_id,virtue_id,class_id ON public.characters
FOR EACH ROW EXECUTE FUNCTION public.cleanup_trait_linked_content();