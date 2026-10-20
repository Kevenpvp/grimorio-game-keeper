import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Tables } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";

export type AbilityEffectType = "status" | "regeneration" | "no_regen_hp" | "no_regen_mana" | "stun";
export type AbilityEffectDefinition = {
  name: string;
  effect_type: AbilityEffectType;
  attribute_key: string | null;
  polarity: "buff" | "debuff";
  value_mode: "percent" | "fixed";
  amount: number;
  duration: number;
};
export type Ability = Tables<"abilities">;
export type CharacterAbilityRow = Tables<"character_abilities">;
export type CharacterAbility = Omit<CharacterAbilityRow, "effects"> & { effects: AbilityEffectDefinition[] };

export function parseAbilityEffects(value: unknown): AbilityEffectDefinition[] {
  if (!Array.isArray(value)) return [];
  const validTypes: AbilityEffectType[] = ["status", "regeneration", "no_regen_hp", "no_regen_mana", "stun"];
  return value.flatMap((item): AbilityEffectDefinition[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (!validTypes.includes(raw.effect_type as AbilityEffectType)) return [];
    const effectType = raw.effect_type as AbilityEffectType;
    const polarity = raw.polarity === "debuff" ? "debuff" : "buff";
    const valueMode = raw.value_mode === "percent" ? "percent" : "fixed";
    const amount = Number(raw.amount ?? 0);
    const duration = Number(raw.duration ?? 1);
    return [{
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Efeito",
      effect_type: effectType,
      attribute_key: typeof raw.attribute_key === "string" ? raw.attribute_key : null,
      polarity,
      value_mode: valueMode,
      amount: Number.isFinite(amount) ? Math.max(0, amount) : 0,
      duration: Number.isFinite(duration) ? Math.max(1, Math.floor(duration)) : 1,
    }];
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
    if (!ability.is_passive) continue;
    for (const effect of ability.effects) {
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
  return (abilities ?? []).some((ability) => ability.is_passive && ability.effects.some((effect) => effect.effect_type === type));
}

export function passiveRegenerationModifiers(abilities: CharacterAbility[] | undefined, attributeKey: "hp" | "mana") {
  let fixed = 0;
  let percent = 0;
  for (const ability of abilities ?? []) {
    if (!ability.is_passive) continue;
    for (const effect of ability.effects) {
      if (effect.effect_type !== "regeneration" || effect.attribute_key !== attributeKey) continue;
      const value = effect.polarity === "buff" ? effect.amount : -effect.amount;
      if (effect.value_mode === "percent") percent += value;
      else fixed += value;
    }
  }
  return { fixed, percent };
}
