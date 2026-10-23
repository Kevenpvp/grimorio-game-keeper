-- Allow a master to customize a shared race/virtue transformation for one character
-- without changing the template used by everyone else.
ALTER TABLE public.transformations
  ADD COLUMN IF NOT EXISTS source_transformation_id uuid
  REFERENCES public.transformations(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS transformations_character_source_unique
  ON public.transformations(owner_character_id, source_transformation_id)
  WHERE source_transformation_id IS NOT NULL;
