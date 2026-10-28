import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Tables } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";
import { parseDefenseIgnore, type DefenseIgnore } from "@/lib/defense-ignore";
import { parseAttributeStatusModifiers, statusModifiersForAttribute, type AttributeStatusModifier } from "@/lib/multi-attribute-effects";

export type AbilityEffectType = "status" | "regeneration" | "mana_regeneration" | "mana_used" | "no_regen_hp" | "no_regen_mana" | "magic_prohibition" | "stun" | "damage_dealt" | "damage_reduction" | "damage_received" | "damage_vulnerability" | "no_mana" | "healing" | "invincible" | "healing_blocked" | "magic_healing_reversal" | "mental_control_immunity" | "mental_control_chance" | "mental_control_resistance" | "dot_immunity" | "dot_resistance" | "invisibility" | "temporal_freeze" | "visual_tag";
export type DamageScope = "any" | "physical" | "magical";
export type DamageReductionScope = "physical" | "magical" | "both";
export type DamageReceivedScope = "any" | "physical" | "magical" | "race";
export type DamageMagicLevel = "baixa" | "media" | "alta";
export type DamageTypeCategory = "physical" | "magical";
export type DamageTypeOption = Pick<Tables<"damage_types">, "id" | "name" | "category">;
export type AbilityEffectDefinition = {
  /** Which character receives this effect when the ability is activated. */
  target_scope?: "caster" | "target" | "both";
  /** Explicitly apply this effect to both caster and selected target. */
  apply_both_on_activation?: boolean;
  /** If true, the effect remains active until its battle ends, independent of turn advances. */
  until_combat_end?: boolean;
  remove_on_attack?: boolean;
  /** When enabled, ask the GM for this effect's numeric values before Ativar. */
  modify_on_activate?: boolean;
  /** Remove this temporary effect when its owner receives actual damage, including DoTs. */
  remove_on_hit?: boolean;
  dot_immunity_scope?: "all" | "physical" | "magical" | "specific";
  dot_immunity_template_ids?: string[];
  dot_resistance_scope?: "all" | "physical" | "magical" | "specific";
  dot_resistance_template_ids?: string[];
  dot_resistance_mode?: "damage" | "duration";
  dot_resistance_value_mode?: "fixed" | "percent";
  dot_resistance_amount?: number;
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
  /** Reduces the numeric magnitude of every active debuff while the granted relief lasts. */
  healing_relieve_debuff_percent?: number;
  /** Metadata reserved for future race interactions with healing magic. */
  healing_damage_type_id?: string | null;
  healing_magic_level?: DamageMagicLevel | null;
  /** Empty list means all magical types for Reversão de Cura. */
  magic_healing_type_ids?: string[];
  magic_healing_magic_levels?: DamageMagicLevel[];
  /** Whitelisted healing magic types bypass Reversão de Cura completely. */
  magic_healing_whitelist_type_ids?: string[];
  /** Physical types affected by Dano Causado when damage_scope is physical. */
  damage_dealt_physical_type_ids?: string[];
  /** Physical types affected by Dano Recebido when damage_received_scope is physical. */
  damage_received_physical_type_ids?: string[];
  /** Damage category/type matching that activates Vulnerabilidade de Dano. */
  damage_vulnerability_scope?: DamageScope;
  damage_vulnerability_physical_type_ids?: string[];
  damage_vulnerability_magic_type_ids?: string[];
  damage_vulnerability_magic_levels?: DamageMagicLevel[];
  /** Any normal effect(s) to apply when the vulnerability trigger matches. Nested vulnerability triggers are not allowed. */
  damage_vulnerability_effects?: AbilityEffectDefinition[];
  /** Duration of persistent effects created when the vulnerability triggers. */
  damage_vulnerability_applied_duration?: number;
  magic_healing_reversal_damage_mode?: "healing_amount" | "custom" | "both";
  magic_healing_reversal_custom_damage?: number;
  name: string;
  effect_type: AbilityEffectType;
  attribute_key: string | null;
  /** Optional multi-attribute status, with independent mode and magnitude. */
  attribute_modifiers?: AttributeStatusModifier[];
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
  /** Distinct allowlists let one mitigation cover physical and magical damage. Empty = all. */
  damage_reduction_physical_type_ids?: string[];
  damage_reduction_magic_type_ids?: string[];
  /** Exclusions always win over the allowlists. */
  damage_reduction_physical_blacklist_ids?: string[];
  damage_reduction_magic_blacklist_ids?: string[];
  damage_reduction_magic_level_blacklist?: DamageMagicLevel[];
  /** How incoming damage is increased by this debuff. */
  damage_received_scope?: DamageReceivedScope;
  /** Empty arrays mean every magic type or magic level is affected. */
  damage_received_type_ids?: string[];
  damage_received_magic_levels?: DamageMagicLevel[];
  /** When scope is race, only attackers whose character race matches this ID trigger it. */
  damage_received_race_id?: string | null;
};
export type AbilityAttackDamageKind = "physical" | "magical" | "hybrid" | "true";
export type AbilityAttackDamageConfig = {
  damage_kind: AbilityAttackDamageKind;
  attribute_key: string | null;
  attribute_percent: number;
  /** Optional extra attribute sources for hybrid damage (legacy primary source stays intact). */
  additional_attributes?: Array<{ attribute_key: string; attribute_percent: number }>;
  fixed_damage: number;
  /** Execution only triggers on a confirmed hit and only while target has low HP. */
  execute_enabled: boolean;
  execute_mode: "percent" | "fixed";
  execute_threshold: number;
  defense_ignore: DefenseIgnore;
  physical_damage_type_id: string | null;
  damage_type_id: string | null;
  magic_level: DamageMagicLevel;
};

export type AbilityDotDamageMode = "fixed" | "percent" | "attribute";
export type AbilityDotEffect = {
  id: string;
  /** Reference to the globally registered DoT (its identity and damage type). */
  template_id?: string | null;
  name: string;
  damage_kind: "physical" | "magical";
  physical_damage_type_id: string | null;
  damage_type_id: string | null;
  magic_level: DamageMagicLevel | null;
  damage_mode: AbilityDotDamageMode;
  damage_amount: number;
  attribute_key: string | null;
  attribute_percent: number;
  fixed_damage: number;
  duration: number;
};

export function parseAbilityDotEffects(value: unknown): AbilityDotEffect[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index): AbilityDotEffect[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "DoT";
    const damageKind = raw.damage_kind === "magical" ? "magical" : raw.damage_kind === "physical" ? "physical" : null;
    const mode: AbilityDotDamageMode = raw.damage_mode === "percent" || raw.damage_mode === "attribute" ? raw.damage_mode : "fixed";
    const magicLevel = raw.magic_level === "media" || raw.magic_level === "alta" ? raw.magic_level : raw.magic_level === "baixa" ? "baixa" : null;
    const amount = Number(raw.damage_amount ?? 10);
    const attributePercent = Number(raw.attribute_percent ?? 100);
    const fixedDamage = Number(raw.fixed_damage ?? 0);
    const duration = Number(raw.duration ?? 3);
    if (!damageKind) return [];
    return [{
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id : `dot-${index + 1}`,
      template_id: typeof raw.template_id === "string" && raw.template_id ? raw.template_id : null,
      name,
      damage_kind: damageKind,
      physical_damage_type_id: typeof raw.physical_damage_type_id === "string" ? raw.physical_damage_type_id : null,
      damage_type_id: typeof raw.damage_type_id === "string" ? raw.damage_type_id : null,
      magic_level: magicLevel,
      damage_mode: mode,
      damage_amount: Number.isFinite(amount) ? Math.max(0, Math.min(1_000_000, amount)) : 10,
      attribute_key: typeof raw.attribute_key === "string" && raw.attribute_key ? raw.attribute_key : null,
      attribute_percent: Number.isFinite(attributePercent) ? Math.max(0, Math.min(1000, attributePercent)) : 100,
      fixed_damage: Number.isFinite(fixedDamage) ? Math.max(0, Math.min(1_000_000, fixedDamage)) : 0,
      duration: Number.isFinite(duration) ? Math.max(1, Math.min(1000, Math.floor(duration))) : 3,
    }];
  });
}

export type AbilityAttackEffectGroup = {
  id: string;
  name: string;
  chance: number;
  effects: AbilityEffectDefinition[];
  dots: AbilityDotEffect[];
  defense_ignore: DefenseIgnore;
};

export function parseAbilityAttackEffectGroups(value: unknown): AbilityAttackEffectGroup[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AbilityAttackEffectGroup[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const chance = Number(raw.chance ?? 50);
    if (!name || !id || !Number.isFinite(chance)) return [];
    return [{
      id,
      name,
      chance: Math.max(0, Math.min(100, Math.round(chance))),
      effects: parseAbilityEffects(raw.effects),
      dots: parseAbilityDotEffects(raw.dots),
      defense_ignore: parseDefenseIgnore(raw.defense_ignore),
    }];
  });
}

export function parseAbilityAttackDamage(value: unknown): AbilityAttackDamageConfig {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const damageKind: AbilityAttackDamageKind = raw.damage_kind === "magical" || raw.damage_kind === "hybrid" || raw.damage_kind === "true"
    ? raw.damage_kind
    : "physical";
  const magicLevel: DamageMagicLevel = raw.magic_level === "media" || raw.magic_level === "alta" ? raw.magic_level : "baixa";
  const attributePercent = Number(raw.attribute_percent ?? 100);
  const fixedDamage = Number(raw.fixed_damage ?? 0);
  const primaryKey = typeof raw.attribute_key === "string" && raw.attribute_key ? raw.attribute_key : null;
  const extraSources: NonNullable<AbilityAttackDamageConfig["additional_attributes"]> = [];
  const usedKeys = new Set<string>(primaryKey ? [primaryKey] : []);
  for (const value of Array.isArray(raw.additional_attributes) ? raw.additional_attributes : []) {
    if (extraSources.length >= 8) break;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const source = value as Record<string, unknown>;
    const key = typeof source.attribute_key === "string" ? source.attribute_key.trim() : "";
    const percent = Number(source.attribute_percent);
    if (!key || usedKeys.has(key) || !Number.isFinite(percent) || percent < 0 || percent > 1000) continue;
    usedKeys.add(key);
    extraSources.push({ attribute_key: key, attribute_percent: percent });
  }
  return {
    damage_kind: damageKind,
    attribute_key: primaryKey,
    attribute_percent: Number.isFinite(attributePercent) ? Math.max(0, Math.min(1000, attributePercent)) : 100,
    additional_attributes: extraSources,
    fixed_damage: Number.isFinite(fixedDamage) ? Math.max(0, Math.min(1_000_000, fixedDamage)) : 0,
    execute_enabled: raw.execute_enabled === true,
    execute_mode: raw.execute_mode === "fixed" ? "fixed" : "percent",
    execute_threshold: Number.isFinite(Number(raw.execute_threshold))
      ? Math.max(0, Math.min(raw.execute_mode === "fixed" ? 1_000_000 : 100, Number(raw.execute_threshold)))
      : 10,
    defense_ignore: parseDefenseIgnore(raw.defense_ignore),
    physical_damage_type_id: typeof raw.physical_damage_type_id === "string" ? raw.physical_damage_type_id : null,
    damage_type_id: typeof raw.damage_type_id === "string" ? raw.damage_type_id : null,
    magic_level: magicLevel,
  };
}

export type DotTemplateOption = Pick<Tables<"damage_over_time_templates">, "id" | "name" | "damage_kind" | "physical_damage_type_id" | "damage_type_id" | "magic_level">;

export function useDotTemplates() {
  return useQuery({
    queryKey: ["damage-over-time-templates"],
    queryFn: async () => {
      const { data, error } = await supabase.from("damage_over_time_templates").select("id,name,damage_kind,physical_damage_type_id,damage_type_id,magic_level").order("name");
      if (error) throw error;
      return (data ?? []) as DotTemplateOption[];
    },
  });
}

export type Ability = Tables<"abilities">;
export type CharacterAbilityRow = Tables<"character_abilities">;
export type CharacterAbility = Omit<CharacterAbilityRow, "effects" | "passive_effects" | "end_effects"> & { effects: AbilityEffectDefinition[]; passive_effects: AbilityEffectDefinition[]; end_effects: AbilityEffectDefinition[] };

export function parseAbilityEffects(value: unknown, nested = false): AbilityEffectDefinition[] {
  if (!Array.isArray(value)) return [];
  const validTypes: AbilityEffectType[] = ["status", "regeneration", "mana_regeneration", "mana_used", "no_regen_hp", "no_regen_mana", "magic_prohibition", "stun", "damage_dealt", "damage_reduction", "damage_received", "damage_vulnerability", "no_mana", "healing", "invincible", "healing_blocked", "magic_healing_reversal", "mental_control_immunity", "mental_control_chance", "mental_control_resistance", "dot_immunity", "dot_resistance", "invisibility", "temporal_freeze", "visual_tag"];
  return value.flatMap((item): AbilityEffectDefinition[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as Record<string, unknown>;
    if (!validTypes.includes(raw.effect_type as AbilityEffectType) || (nested && raw.effect_type === "damage_vulnerability")) return [];
    const effectType = raw.effect_type as AbilityEffectType;
    const polarity = effectType === "no_mana" || effectType === "healing_blocked" || effectType === "magic_prohibition" || effectType === "magic_healing_reversal" || effectType === "damage_received"
      ? "debuff"
      : effectType === "damage_reduction" || effectType === "invincible" || effectType === "mental_control_immunity" || effectType === "mental_control_chance" || effectType === "mental_control_resistance" || effectType === "dot_immunity" || effectType === "dot_resistance" || effectType === "invisibility" || effectType === "temporal_freeze" || effectType === "visual_tag"
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
      attribute_modifiers: effectType === "status" ? parseAttributeStatusModifiers(raw.attribute_modifiers) : [],
      polarity,
      value_mode: effectType === "visual_tag" || effectType === "temporal_freeze" ? "fixed" : valueMode,
      amount: effectType === "visual_tag" || effectType === "temporal_freeze" ? 0 : Number.isFinite(amount) ? Math.max(0, amount) : 0,
      duration: Number.isFinite(duration) ? Math.max(1, Math.floor(duration)) : 1,
      until_combat_end: raw.until_combat_end === true,
      damage_scope: raw.damage_scope === "physical" || raw.damage_scope === "magical" ? raw.damage_scope : "any",
      damage_dealt_physical_type_ids: Array.isArray(raw.damage_dealt_physical_type_ids)
        ? [...new Set(raw.damage_dealt_physical_type_ids.filter((value): value is string => typeof value === "string"))]
        : [],
      damage_reduction_scope: raw.damage_reduction_scope === "magical" || raw.damage_reduction_scope === "both" ? raw.damage_reduction_scope : "physical",
      damage_reduction_type_id: null,
      damage_reduction_magic_level: null,
      damage_reduction_type_ids: damageReductionTypeIds,
      damage_reduction_magic_levels: damageReductionMagicLevels,
      damage_reduction_physical_type_ids: Array.isArray(raw.damage_reduction_physical_type_ids)
        ? [...new Set(raw.damage_reduction_physical_type_ids.filter((x): x is string => typeof x === "string"))]
        : effectType === "damage_reduction" && raw.damage_reduction_scope !== "magical" ? damageReductionTypeIds : [],
      damage_reduction_magic_type_ids: Array.isArray(raw.damage_reduction_magic_type_ids)
        ? [...new Set(raw.damage_reduction_magic_type_ids.filter((x): x is string => typeof x === "string"))]
        : effectType === "damage_reduction" && raw.damage_reduction_scope === "magical" ? damageReductionTypeIds : [],
      damage_reduction_physical_blacklist_ids: Array.isArray(raw.damage_reduction_physical_blacklist_ids)
        ? [...new Set(raw.damage_reduction_physical_blacklist_ids.filter((x): x is string => typeof x === "string"))] : [],
      damage_reduction_magic_blacklist_ids: Array.isArray(raw.damage_reduction_magic_blacklist_ids)
        ? [...new Set(raw.damage_reduction_magic_blacklist_ids.filter((x): x is string => typeof x === "string"))] : [],
      damage_reduction_magic_level_blacklist: Array.isArray(raw.damage_reduction_magic_level_blacklist)
        ? [...new Set(raw.damage_reduction_magic_level_blacklist.filter((x): x is DamageMagicLevel => validMagicLevels.includes(x as DamageMagicLevel)))] : [],
      damage_received_scope: raw.damage_received_scope === "physical" || raw.damage_received_scope === "magical" || raw.damage_received_scope === "race" ? raw.damage_received_scope : "any",
      damage_received_type_ids: Array.isArray(raw.damage_received_type_ids)
        ? [...new Set(raw.damage_received_type_ids.filter((value): value is string => typeof value === "string"))]
        : [],
      damage_received_physical_type_ids: Array.isArray(raw.damage_received_physical_type_ids)
        ? [...new Set(raw.damage_received_physical_type_ids.filter((value): value is string => typeof value === "string"))]
        : [],
      damage_received_magic_levels: Array.isArray(raw.damage_received_magic_levels)
        ? [...new Set(raw.damage_received_magic_levels.filter((value): value is DamageMagicLevel => validMagicLevels.includes(value as DamageMagicLevel)))]
        : [],
      damage_received_race_id: typeof raw.damage_received_race_id === "string" ? raw.damage_received_race_id : null,
      dot_immunity_scope: ["all", "physical", "magical", "specific"].includes(String(raw.dot_immunity_scope)) ? raw.dot_immunity_scope as "all" | "physical" | "magical" | "specific" : "all",
      dot_immunity_template_ids: Array.isArray(raw.dot_immunity_template_ids) ? raw.dot_immunity_template_ids.filter((value): value is string => typeof value === "string") : [],
      dot_resistance_scope: ["all", "physical", "magical", "specific"].includes(String(raw.dot_resistance_scope)) ? raw.dot_resistance_scope as "all" | "physical" | "magical" | "specific" : "all",
      dot_resistance_template_ids: Array.isArray(raw.dot_resistance_template_ids) ? [...new Set(raw.dot_resistance_template_ids.filter((value): value is string => typeof value === "string"))] : [],
      dot_resistance_mode: raw.dot_resistance_mode === "duration" ? "duration" : "damage",
      dot_resistance_value_mode: raw.dot_resistance_value_mode === "fixed" ? "fixed" : "percent",
      dot_resistance_amount: Math.max(0, Math.min(1000000, Number.isFinite(Number(raw.dot_resistance_amount)) ? Number(raw.dot_resistance_amount) : 25)),
      damage_vulnerability_scope: raw.damage_vulnerability_scope === "physical" || raw.damage_vulnerability_scope === "magical"
        ? raw.damage_vulnerability_scope : "any",
      damage_vulnerability_physical_type_ids: Array.isArray(raw.damage_vulnerability_physical_type_ids)
        ? [...new Set(raw.damage_vulnerability_physical_type_ids.filter((value): value is string => typeof value === "string"))]
        : [],
      damage_vulnerability_magic_type_ids: Array.isArray(raw.damage_vulnerability_magic_type_ids)
        ? [...new Set(raw.damage_vulnerability_magic_type_ids.filter((value): value is string => typeof value === "string"))]
        : [],
      damage_vulnerability_magic_levels: Array.isArray(raw.damage_vulnerability_magic_levels)
        ? [...new Set(raw.damage_vulnerability_magic_levels.filter((value): value is DamageMagicLevel => validMagicLevels.includes(value as DamageMagicLevel)))]
        : [],
      damage_vulnerability_applied_duration: Number.isFinite(Number(raw.damage_vulnerability_applied_duration))
        ? Math.max(1, Math.min(1000, Math.floor(Number(raw.damage_vulnerability_applied_duration)))) : 1,
      ...(effectType === "damage_vulnerability" ? {
        damage_vulnerability_effects: parseAbilityEffects(
          Array.isArray(raw.damage_vulnerability_effects)
            ? raw.damage_vulnerability_effects
            : [{
                name: "Efeito aplicado",
                effect_type: "status",
                attribute_key: typeof raw.attribute_key === "string" ? raw.attribute_key : "strength",
                polarity: raw.polarity === "buff" ? "buff" : "debuff",
                value_mode: raw.value_mode === "percent" ? "percent" : "fixed",
                amount: Number.isFinite(Number(raw.amount)) ? Number(raw.amount) : 10,
                duration: Number.isFinite(Number(raw.damage_vulnerability_applied_duration))
                  ? Number(raw.damage_vulnerability_applied_duration) : 1,
                damage_scope: "any",
              }],
          true,
        ),
      } : {}),
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
      healing_relieve_debuff_percent: Math.max(0, Math.min(100, Number.isFinite(Number(raw.healing_relieve_debuff_percent)) ? Number(raw.healing_relieve_debuff_percent) : 0)),
      healing_damage_type_id: typeof raw.healing_damage_type_id === "string" ? raw.healing_damage_type_id : null,
      healing_magic_level: validMagicLevels.includes(raw.healing_magic_level as DamageMagicLevel)
        ? raw.healing_magic_level as DamageMagicLevel : null,
      magic_healing_type_ids: Array.isArray(raw.magic_healing_type_ids)
        ? [...new Set(raw.magic_healing_type_ids.filter((value): value is string => typeof value === "string"))]
        : [],
      magic_healing_magic_levels: Array.isArray(raw.magic_healing_magic_levels)
        ? [...new Set(raw.magic_healing_magic_levels.filter((value): value is DamageMagicLevel => validMagicLevels.includes(value as DamageMagicLevel)))]
        : [],
      magic_healing_whitelist_type_ids: Array.isArray(raw.magic_healing_whitelist_type_ids)
        ? [...new Set(raw.magic_healing_whitelist_type_ids.filter((value): value is string => typeof value === "string"))]
        : [],
      magic_healing_reversal_damage_mode: raw.magic_healing_reversal_damage_mode === "custom" || raw.magic_healing_reversal_damage_mode === "both"
        ? raw.magic_healing_reversal_damage_mode : "healing_amount",
      magic_healing_reversal_custom_damage: Math.max(0, Math.min(1_000_000,
        Number.isFinite(Number(raw.magic_healing_reversal_custom_damage)) ? Number(raw.magic_healing_reversal_custom_damage) : 0)),
      remove_on_attack: raw.remove_on_attack === true,
      modify_on_activate: raw.modify_on_activate === true,
      remove_on_hit: raw.remove_on_hit === true,
      dot_immunity_scope: raw.dot_immunity_scope === "physical" || raw.dot_immunity_scope === "magical" || raw.dot_immunity_scope === "specific" ? raw.dot_immunity_scope : "all",
      dot_immunity_template_ids: Array.isArray(raw.dot_immunity_template_ids)
        ? [...new Set(raw.dot_immunity_template_ids.filter((item): item is string => typeof item === "string"))]
        : [],
    }];
  });
}

export function useDamageTypes(category?: DamageTypeCategory) {
  return useQuery({
    queryKey: ["damage-types", category ?? "all"],
    queryFn: async () => {
      let query = supabase.from("damage_types").select("id,name,category").order("name");
      if (category) query = query.eq("category", category);
      const { data, error } = await query;
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
  attribute_modifiers?: AttributeStatusModifier[];
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
    // The script runtime can insert effects after a damage/HP request returns.
    // Realtime is primary, but mobile/embedded previews can miss notifications.
    // Reconcile visible effects periodically while this list is mounted.
    refetchInterval: enabled ? 4000 : false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
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
    if (effect.effect_type !== "status") continue;
    const metadata = effect.effect_data && typeof effect.effect_data === "object" && !Array.isArray(effect.effect_data)
      ? effect.effect_data as Record<string, unknown> : {};
    for (const modifier of statusModifiersForAttribute({
      ...effect, attribute_modifiers: effect.attribute_modifiers ?? metadata.attribute_modifiers,
    }, attributeKey)) {
      const value = effect.polarity === "buff" ? modifier.amount : -modifier.amount;
      if (modifier.value_mode === "percent") result.percent += value;
      else result.fixed += value;
    }
  }
  return result;
}

export function passiveStatusModifiers(abilities: CharacterAbility[] | undefined) {
  const result: Record<string, { fixed: number; percent: number }> = {};
  for (const ability of abilities ?? []) {
    for (const effect of ability.passive_effects) {
      if (effect.effect_type !== "status") continue;
      const rows = parseAttributeStatusModifiers(effect.attribute_modifiers);
      const items = rows.length ? rows : effect.attribute_key
        ? [{ attribute_key: effect.attribute_key, amount: effect.amount, value_mode: effect.value_mode }]
        : [];
      for (const modifier of items) {
        const value = effect.polarity === "buff" ? modifier.amount : -modifier.amount;
        const entry = result[modifier.attribute_key] ?? { fixed: 0, percent: 0 };
        if (modifier.value_mode === "percent") entry.percent += value;
        else entry.fixed += value;
        result[modifier.attribute_key] = entry;
      }
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
