import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Tables } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";

export type AbilityEffectType = "status" | "regeneration" | "mana_regeneration" | "mana_used" | "no_regen_hp" | "no_regen_mana" | "magic_prohibition" | "stun" | "damage_dealt" | "damage_reduction" | "no_mana";
export type DamageScope = "any" | "physical" | "magical";
export type DamageReductionScope = "physical" | "magical";
export type DamageMagicLevel = "baixa" | "media" | "alta";
export type DamageTypeOption = Pick<Tables<"damage_types">, "id" | "name">;
export type AbilityEffectDefinition = {
  name: string;
  effect_type: AbilityEffectType;
  attribute_key: string | null;
  polarity: "buff" | "debuff";
  value_mode: "percent" | "fixed";
  amount: number;
  duration: number;
  damage_scope: DamageScope;
  damage_reduction_scope?: DamageReductionScope;
  damage_reduction_type_id?: string | null;
  damage_reduction_magic_level?: DamageMagicLevel | null;
  /** Empty arrays mean all registered magic types / all magic grades. */
  damage_reduction_type_ids?: string[] | null;
  damage_reduction_magic_levels?: DamageMagicLevel[] | null;
};
export type Ability = Tables<"abilities">;
export type CharacterAbilityRow = Tables<"character_abilities">;
export type CharacterAbility = Omit<CharacterAbilityRow, "effects" | "passive_effects" | "end_effects"> & { effects: AbilityEffectDefinition[]; passive_effects: AbilityEffectDefinition[]; end_effects: AbilityEffectDefinition[] };

export function parseAbilityEffects(value: unknown): AbilityEffectDefinition[] {
  if (!Array.isArray(value)) return [];
  const validTypes: AbilityEffectType[] = ["status", "regeneration", "mana_regeneration", "mana_used", "no_regen_hp", "no_regen_mana", "magic_prohibition", "stun", "damage_dealt", "damage_reduction", "no_mana"];
  return value.flatMap((item): AbilityEffectDefinition[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (!validTypes.includes(raw.effect_type as AbilityEffectType)) return [];
    const effectType = raw.effect_type as AbilityEffectType;
    const polarity = effectType === "no_mana" ? "debuff" : effectType === "damage_reduction" ? "buff" : raw.polarity === "debuff" ? "debuff" : "buff";
    const valueMode = raw.value_mode === "percent" ? "percent" : "fixed";
    const amount = Number(raw.amount ?? 0);
    const duration = Number(raw.duration ?? 1);
    const damageReductionTypeIds = Array.isArray(raw.damage_reduction_type_ids)
      ? raw.damage_reduction_type_ids.filter((value): value is string => typeof value === "string")
      : typeof raw.damage_reduction_type_id === "string" ? [raw.damage_reduction_type_id] : [];
    const validMagicLevels: DamageMagicLevel[] = ["baixa", "media", "alta"];
    const damageReductionMagicLevels = Array.isArray(raw.damage_reduction_magic_levels)
      ? raw.damage_reduction_magic_levels.filter((value): value is DamageMagicLevel => validMagicLevels.includes(value as DamageMagicLevel))
      : validMagicLevels.includes(raw.damage_reduction_magic_level as DamageMagicLevel)
        ? [raw.damage_reduction_magic_level as DamageMagicLevel]
        : [];
    return [{
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Efeito",
      effect_type: effectType,
      attribute_key: typeof raw.attribute_key === "string" ? raw.attribute_key : null,
      polarity,
      value_mode: valueMode,
      amount: Number.isFinite(amount) ? Math.max(0, amount) : 0,
      duration: Number.isFinite(duration) ? Math.max(1, Math.floor(duration)) : 1,
      damage_scope: raw.damage_scope === "physical" || raw.damage_scope === "magical" ? raw.damage_scope : "any",
      damage_reduction_scope: raw.damage_reduction_scope === "magical" ? "magical" : "physical",
      damage_reduction_type_id: null,
      damage_reduction_magic_level: null,
      damage_reduction_type_ids: damageReductionTypeIds,
      damage_reduction_magic_levels: damageReductionMagicLevels,
    }];
  });
}

export function useDamageTypes() {
  return useQuery({
    queryKey: ["damage-types"],
    queryFn: async () => {
      const { data, error } = await supabase.from("damage_types").select("id,name").order("name");
      if (error) throw error;
      return (data ?? []) as DamageTypeOption[];
    },
  });
}

export function useAbilities() {
  return useQuery({
    queryKey: ["abilities"],
    queryFn: async () => {
      const { data, error } = await supabase.from("abilities").select("*").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useCharacterAbilities(characterId: string | undefined) {
  return useQuery({
    queryKey: ["character-abilities", characterId],
    enabled: !!characterId,
    queryFn: async () => {
      const { data, error } = await supabase.from("character_abilities").select("*")
        .eq("character_id", characterId!).order("created_at");
      if (error) throw error;
      return (data ?? []).map((row) => ({
        ...row,
        effects: parseAbilityEffects(row.effects),
        passive_effects: parseAbilityEffects(row.passive_effects),
        end_effects: parseAbilityEffects(row.end_effects),
      })) as CharacterAbility[];
    },
  });
}

export function useBattleCharacterAbilities(battleId: string, characterIds: string[]) {
  return useQuery({
    queryKey: ["character-abilities-battle", battleId, characterIds],
    enabled: characterIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.from("character_abilities").select("*").in("character_id", characterIds);
      if (error) throw error;
      return (data ?? []).map((row) => ({
        ...row,
        effects: parseAbilityEffects(row.effects),
        passive_effects: parseAbilityEffects(row.passive_effects),
        end_effects: parseAbilityEffects(row.end_effects),
      })) as CharacterAbility[];
    },
  });
}

export type ActiveCharacterEffect = {
  id: string;
  battle_id: string | null;
  character_id: string;
  name: string;
  effect_type: AbilityEffectType;
  attribute_key: string | null;
  polarity: "buff" | "debuff";
  value_mode: "percent" | "fixed";
  amount: number;
  duration: number;
  duration_scope: string;
  source_character_ability_id: string | null;
  damage_reduction_scope?: DamageReductionScope;
  damage_reduction_type_id?: string | null;
  damage_reduction_magic_level?: DamageMagicLevel | null;
  /** Empty arrays mean all registered magic types / all magic grades. */
  damage_reduction_type_ids?: string[] | null;
  damage_reduction_magic_levels?: DamageMagicLevel[] | null;
};

export function useCharacterActiveEffects(characterId: string | undefined) {
  return useQuery({
    queryKey: ["character-active-effects", characterId],
    enabled: !!characterId,
    queryFn: async () => {
      const [standaloneResult, participantsResult] = await Promise.all([
        supabase.from("battle_effects").select("*").eq("character_id", characterId!).is("battle_id", null),
        supabase.from("battle_participants").select("battle_id").eq("character_id", characterId!),
      ]);
      if (standaloneResult.error) throw standaloneResult.error;
      if (participantsResult.error) throw participantsResult.error;
      const participantBattleIds = [...new Set((participantsResult.data ?? []).map((row) => row.battle_id))];
      let activeBattleIds: string[] = [];
      if (participantBattleIds.length > 0) {
        const { data, error } = await supabase.from("battles").select("id")
          .in("id", participantBattleIds).eq("active", true);
        if (error) throw error;
        activeBattleIds = (data ?? []).map((row) => row.id);
      }
      let battleEffects: ActiveCharacterEffect[] = [];
      if (activeBattleIds.length > 0) {
        const { data, error } = await supabase.from("battle_effects").select("*")
          .eq("character_id", characterId!).in("battle_id", activeBattleIds);
        if (error) throw error;
        battleEffects = (data ?? []) as ActiveCharacterEffect[];
      }
      const standaloneEffects = (standaloneResult.data ?? []) as ActiveCharacterEffect[];
      return [...standaloneEffects, ...battleEffects];
    },
  });
}

export function statusEffectModifiers(effects: ActiveCharacterEffect[] | undefined, attributeKey: string) {
  const result = { fixed: 0, percent: 0 };
  for (const effect of effects ?? []) {
    if (effect.effect_type !== "status" || effect.attribute_key !== attributeKey) continue;
    const value = effect.polarity === "buff" ? Number(effect.amount) : -Number(effect.amount);
    if (effect.value_mode === "percent") result.percent += value;
    else result.fixed += value;
  }
  return result;
}

export function passiveStatusModifiers(abilities: CharacterAbility[] | undefined) {
  const result: Record<string, { fixed: number; percent: number }> = {};
  for (const ability of abilities ?? []) {
    for (const effect of ability.passive_effects) {
      if (effect.effect_type !== "status" || !effect.attribute_key) continue;
      const value = effect.polarity === "buff" ? effect.amount : -effect.amount;
      const entry = result[effect.attribute_key] ?? { fixed: 0, percent: 0 };
      if (effect.value_mode === "percent") entry.percent += value;
      else entry.fixed += value;
      result[effect.attribute_key] = entry;
    }
  }
  return result;
}

export function passiveEffectTypeActive(abilities: CharacterAbility[] | undefined, type: AbilityEffectType) {
  return (abilities ?? []).some((ability) => ability.passive_effects.some((effect) => effect.effect_type === type));
}

export function passiveRegenerationModifiers(abilities: CharacterAbility[] | undefined, attributeKey: "hp" | "mana") {
  let fixed = 0;
  let percent = 0;
  for (const ability of abilities ?? []) {
    for (const effect of ability.passive_effects) {
      const affectsAttribute =
        (effect.effect_type === "regeneration" && effect.attribute_key === attributeKey) ||
        (effect.effect_type === "mana_regeneration" && attributeKey === "mana");
      if (!affectsAttribute) continue;
      const value = effect.polarity === "buff" ? effect.amount : -effect.amount;
      if (effect.value_mode === "percent") percent += value;
      else fixed += value;
    }
  }
  return { fixed, percent };
}

/** Signed modification to mana cost: buffs reduce usage, debuffs increase it. */
export function passiveManaUsedModifiers(abilities: CharacterAbility[] | undefined) {
  let fixed = 0;
  let percent = 0;
  for (const ability of abilities ?? []) {
    for (const effect of ability.passive_effects) {
      if (effect.effect_type !== "mana_used") continue;
      const value = effect.polarity === "buff" ? -effect.amount : effect.amount;
      if (effect.value_mode === "percent") percent += value;
      else fixed += value;
    }
  }
  return { fixed, percent };
}
