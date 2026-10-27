-- New character inventories begin with ten slots, not twelve.
ALTER TABLE public.characters ALTER COLUMN inventory_slots SET DEFAULT 10;

-- Convert inventories that still have the original twelve-slot default.
-- Never truncate an existing item: keep twelve if any occupied slot is 11+.
UPDATE public.characters c
SET inventory_slots = 10
WHERE c.inventory_slots = 12
  AND NOT EXISTS (
    SELECT 1 FROM public.character_inventory i
    WHERE i.character_id = c.id AND i.slot_index > 10
  );
