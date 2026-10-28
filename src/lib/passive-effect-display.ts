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

/** If a permanent passive has also been materialized in battle_effects,
 * show/count it only once. Keep combat effects and passive ability effects
 * separate for calculations: this helper is strictly for presentation. */
export function unregisteredPassiveEffectsForDisplay(
  passives: readonly PassiveEffectDisplay[],
  registered: readonly {
    source_character_ability_id?: string | null;
    is_sheet_permanent?: boolean | null;
    name: string;
    effect_type: string;
  }[],
): PassiveEffectDisplay[] {
  return passives.filter((item) => !registered.some((effect) =>
    effect.source_character_ability_id === item.abilityId
    && effect.is_sheet_permanent === true
    && effect.name === item.effect.name
    && (effect.effect_type === item.effect.effect_type
      || (effect.effect_type === "regeneration" && item.effect.effect_type === "mana_regeneration"))
  ));
}

/** Number of actual active buffs/debuffs plus non-materialized ability passives,
 * exactly matching the visual list in Efeitos ativos. */
export function combatEffectBadgeCounts(
  registered: readonly {
    source_character_ability_id?: string | null;
    is_sheet_permanent?: boolean | null;
    name: string;
    effect_type: string;
    polarity: string;
  }[],
  passives: readonly PassiveEffectDisplay[],
): { buffs: number; debuffs: number } {
  const extra = unregisteredPassiveEffectsForDisplay(passives, registered);
  return {
    buffs: registered.filter((effect) => effect.polarity === "buff").length
      + extra.filter((item) => item.effect.polarity === "buff").length,
    debuffs: registered.filter((effect) => effect.polarity === "debuff").length
      + extra.filter((item) => item.effect.polarity === "debuff").length,
  };
}
