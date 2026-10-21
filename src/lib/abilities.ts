import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Tables } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";

export type AbilityEffectType = "status" | "regeneration" | "mana_regeneration" | "mana_used" | "no_regen_hp" | "no_regen_mana" | "magic_prohibition" | "stun" | "damage_dealt" | "damage_reduction" | "damage_received" | "no_mana" | "healing" | "invincible" | "healing_blocked" | "magic_healing_reversal";
export type DamageScope = "any" | "physical" | "magical";
export type DamageReductionScope = "physical" | "magical";
export type DamageReceivedScope = "any" | "physical" | "magical" | "race";
export type DamageMagicLevel = "baixa" | "media" | "alta";
export type DamageTypeOption = Pick<Tables<"damage_types">, "id" | "name">;
export type AbilityEffectDefinition = {
  /** Which character receives this effect when the ability is activated. */
  target_scope?: "caster" | "target" | "both";
  /** Explicitly apply this effect to both caster and selected target. */
  apply_both_on_activation?: boolean;
  /** If true, the effect remains active until its battle ends, independent of turn advances. */
  until_combat_end?: boolean;
  /** Instant restoration or a healing buff that ticks on each combat turn advance. */
  healing_timing?: "instant" | "per_turn";
  healing_hp_enabled?: boolean;
  healing_hp_mode?: "fixed" | "percent";
  healing_hp_amount?: number;
  healing_mana_enabled?: boolean;
  healing_mana_mode?: "fixed" | "percent";
  healing_mana_amount?: number;
  healing_body_enabled?: boolean;
  healing_body_mode?: "fixed" | "percent";
  healing_body_amount?: number;
  healing_sanity_enabled?: boolean;
  healing_sanity_mode?: "fixed" | "percent";
  healing_sanity_amount?: number;
  healing_remove_debuffs?: boolean;
  healing_debuff_blacklist?: string[];
  /** Specific effect names that cleansing/reduction must leave untouched. */
  healing_debuff_name_blacklist?: string[];
  healing_reduce_debuff_turns_fixed?: number;
  healing_reduce_debuff_turns_percent?: number;
  /** Metadata reserved for future race interactions with healing magic. */
  healing_damage_type_id?: string | null;
  healing_magic_level?: DamageMagicLevel | null;
  /** Empty lists mean all magic types / all grades for Reversão de Cura. */
  magic_healing_type_ids?: string[];
  magic_healing_magic_levels?: DamageMagicLevel[];
  magic_healing_reversal_damage_mode?: "healing_amount" | "custom" | "both";
  magic_healing_reversal_custom_damage?: number;
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
  /** How incoming damage is increased by this debuff. */
  damage_received_scope?: DamageReceivedScope;
  /** Empty arrays mean every magic type or magic level is affected. */
  damage_received_type_ids?: string[];
  damage_received_magic_levels?: DamageMagicLevel[];
  /** When scope is race, only attackers whose character race matches this ID trigger it. */
  damage_received_race_id?: string | null;
};
export type Ability = Tables<"abilities">;
export type CharacterAbilityRow = Tables<"character_abilities">;
export type CharacterAbility = Omit<CharacterAbilityRow, "effects" | "passive_effects" | "end_effects"> & { effects: AbilityEffectDefinition[]; passive_effects: AbilityEffectDefinition[]; end_effects: AbilityEffectDefinition[] };

export function parseAbilityEffects(value: unknown): AbilityEffectDefinition[] {
  if (!Array.isArray(value)) return [];
  const validTypes: AbilityEffectType[] = ["status", "regeneration", "mana_regeneration", "mana_used", "no_regen_hp", "no_regen_mana", "magic_prohibition", "stun", "damage_dealt", "damage_reduction", "damage_received", "no_mana", "healing", "invincible", "healing_blocked", "magic_healing_reversal"];
  return value.flatMap((item): AbilityEffectDefinition[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (!validTypes.includes(raw.effect_type as AbilityEffectType)) return [];
    const effectType = raw.effect_type as AbilityEffectType;
    const polarity = effectType === "no_mana" || effectType === "healing_blocked" || effectType === "magic_prohibition" || effectType === "magic_healing_reversal" || effectType === "damage_received"
      ? "debuff"
      : effectType === "damage_reduction" || effectType === "invincible"
        ? "buff"
        : raw.polarity === "debuff" ? "debuff" : "buff";
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
      until_combat_end: raw.until_combat_end === true,
      damage_scope: raw.damage_scope === "physical" || raw.damage_scope === "magical" ? raw.damage_scope : "any",
      damage_reduction_scope: raw.damage_reduction_scope === "magical" ? "magical" : "physical",
      damage_reduction_type_id: null,
      damage_reduction_magic_level: null,
      damage_reduction_type_ids: damageReductionTypeIds,
      damage_reduction_magic_levels: damageReductionMagicLevels,
      damage_received_scope: raw.damage_received_scope === "physical" || raw.damage_received_scope === "magical" || raw.damage_received_scope === "race" ? raw.damage_received_scope : "any",
      damage_received_type_ids: Array.isArray(raw.damage_received_type_ids)
        ? [...new Set(raw.damage_received_type_ids.filter((value): value is string => typeof value === "string"))]
        : [],
      damage_received_magic_levels: Array.isArray(raw.damage_received_magic_levels)
        ? [...new Set(raw.damage_received_magic_levels.filter((value): value is DamageMagicLevel => validMagicLevels.includes(value as DamageMagicLevel)))]
        : [],
      damage_received_race_id: typeof raw.damage_received_race_id === "string" ? raw.damage_received_race_id : null,
      target_scope: raw.target_scope === "caster" || raw.target_scope === "both" ? raw.target_scope : "target",
      apply_both_on_activation: raw.apply_both_on_activation === true,
      healing_timing: raw.healing_timing === "per_turn" ? "per_turn" : "instant",
      healing_hp_enabled: raw.healing_hp_enabled === true,
      healing_hp_mode: raw.healing_hp_mode === "percent" ? "percent" : "fixed",
      healing_hp_amount: Math.max(0, Number.isFinite(Number(raw.healing_hp_amount)) ? Number(raw.healing_hp_amount) : 0),
      healing_mana_enabled: raw.healing_mana_enabled === true,
      healing_mana_mode: raw.healing_mana_mode === "percent" ? "percent" : "fixed",
      healing_mana_amount: Math.max(0, Number.isFinite(Number(raw.healing_mana_amount)) ? Number(raw.healing_mana_amount) : 0),
      healing_body_enabled: raw.healing_body_enabled === true,
      healing_body_mode: raw.healing_body_mode === "percent" ? "percent" : "fixed",
      healing_body_amount: Math.max(0, Number.isFinite(Number(raw.healing_body_amount)) ? Number(raw.healing_body_amount) : 0),
      healing_sanity_enabled: raw.healing_sanity_enabled === true,
      healing_sanity_mode: raw.healing_sanity_mode === "percent" ? "percent" : "fixed",
      healing_sanity_amount: Math.max(0, Number.isFinite(Number(raw.healing_sanity_amount)) ? Number(raw.healing_sanity_amount) : 0),
      healing_remove_debuffs: raw.healing_remove_debuffs === true,
      healing_debuff_blacklist: Array.isArray(raw.healing_debuff_blacklist)
        ? raw.healing_debuff_blacklist.filter((item): item is string => typeof item === "string")
        : [],
      healing_debuff_name_blacklist: Array.isArray(raw.healing_debuff_name_blacklist)
        ? raw.healing_debuff_name_blacklist.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
        : [],
      healing_reduce_debuff_turns_fixed: Math.max(0, Math.floor(Number.isFinite(Number(raw.healing_reduce_debuff_turns_fixed)) ? Number(raw.healing_reduce_debuff_turns_fixed) : 0)),
      healing_reduce_debuff_turns_percent: Math.max(0, Math.min(100, Number.isFinite(Number(raw.healing_reduce_debuff_turns_percent)) ? Number(raw.healing_reduce_debuff_turns_percent) : 0)),
      healing_damage_type_id: typeof raw.healing_damage_type_id === "string" ? raw.healing_damage_type_id : null,
      healing_magic_level: validMagicLevels.includes(raw.healing_magic_level as DamageMagicLevel)
        ? raw.healing_magic_level as DamageMagicLevel : null,
      magic_healing_type_ids: Array.isArray(raw.magic_healing_type_ids)
        ? [...new Set(raw.magic_healing_type_ids.filter((value): value is string => typeof value === "string"))]
        : [],
      magic_healing_magic_levels: Array.isArray(raw.magic_healing_magic_levels)
        ? [...new Set(raw.magic_healing_magic_levels.filter((value): value is DamageMagicLevel => validMagicLevels.includes(value as DamageMagicLevel)))]
        : [],
      magic_healing_reversal_damage_mode: raw.magic_healing_reversal_damage_mode === "custom" || raw.magic_healing_reversal_damage_mode === "both"
        ? raw.magic_healing_reversal_damage_mode : "healing_amount",
      magic_healing_reversal_custom_damage: Math.max(0, Math.min(1_000_000,
        Number.isFinite(Number(raw.magic_healing_reversal_custom_damage)) ? Number(raw.magic_healing_reversal_custom_damage) : 0)),
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
  until_combat_end: boolean;
  source_character_ability_id: string | null;
  source_race_id?: string | null;
  source_race_effect_index?: number | null;
  target_character_id?: string | null;
  effect_data?: import("@/integrations/supabase/types").Json;
  damage_reduction_scope?: DamageReductionScope;
  damage_reduction_type_id?: string | null;
  damage_reduction_magic_level?: DamageMagicLevel | null;
  /** Empty arrays mean all registered magic types / all magic grades. */
  damage_reduction_type_ids?: string[] | null;
  damage_reduction_magic_levels?: DamageMagicLevel[] | null;
};

export function useCharacterActiveEffects(characterId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["character-active-effects", characterId],
    enabled: !!characterId && enabled,
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
      const normalizeEffect = (row: ActiveCharacterEffect): ActiveCharacterEffect => {
        const metadata = row.effect_data && typeof row.effect_data === "object" && !Array.isArray(row.effect_data)
          ? row.effect_data as Record<string, unknown>
          : null;
        return {
          ...row,
          effect_type: row.effect_type === "healing_blocked" && metadata?.effect_type === "magic_healing_reversal"
            ? "magic_healing_reversal"
            : row.effect_type,
        };
      };
      let battleEffects: ActiveCharacterEffect[] = [];
      if (activeBattleIds.length > 0) {
        const { data, error } = await supabase.from("battle_effects").select("*")
          .eq("character_id", characterId!).in("battle_id", activeBattleIds);
        if (error) throw error;
        battleEffects = ((data ?? []) as ActiveCharacterEffect[]).map(normalizeEffect);
      }
      const standaloneEffects = ((standaloneResult.data ?? []) as ActiveCharacterEffect[]).map(normalizeEffect);
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
