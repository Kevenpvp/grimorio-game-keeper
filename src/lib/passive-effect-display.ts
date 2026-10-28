import type { AbilityEffectDefinition } from "@/lib/abilities";

/**
 * Passive effects are already calculated directly from character_abilities.
 * This is a read-only projection for the combat Effects tab: never insert
 * these rows in battle_effects or they would be applied twice.
 */
export type PassiveEffectDisplaySource = {
  id: string;
  name: string;
  passive_effects: AbilityEffectDefinition[];
  source_inventory_item_id?: string | null;
};

export type PassiveEffectDisplay = {
  id: string;
  abilityId: string;
  abilityName: string;
  sourceInventoryItemId: string | null;
  effect: AbilityEffectDefinition;
};

export function passiveEffectsForDisplay(
  abilities: readonly PassiveEffectDisplaySource[] | undefined,
): PassiveEffectDisplay[] {
  return (abilities ?? []).flatMap((ability) =>
    (ability.passive_effects ?? []).map((effect, index) => ({
      id: `passive:${ability.id}:${index}`,
      abilityId: ability.id,
      abilityName: ability.name,
      sourceInventoryItemId: ability.source_inventory_item_id ?? null,
      effect,
    })),
  );
}
