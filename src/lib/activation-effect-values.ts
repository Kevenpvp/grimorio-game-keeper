import type { AbilityEffectDefinition } from "@/lib/abilities";

export type ActivationEffectValueKey =
  | "amount" | "dot_resistance_amount"
  | "healing_hp_amount" | "healing_mana_amount"
  | "healing_body_amount" | "healing_sanity_amount"
  | "healing_reduce_debuff_turns_fixed" | "healing_reduce_debuff_turns_percent"
  | "healing_relieve_debuff_percent" | "magic_healing_reversal_custom_damage";

export type ActivationEffectValueField = {
  key: ActivationEffectValueKey;
  label: string;
  initialValue: number;
  max: number;
};

const AMOUNT_TYPES = new Set([
  "status", "regeneration", "mana_regeneration", "mana_used",
  "damage_dealt", "damage_reduction", "damage_received",
  "mental_control_chance", "mental_control_resistance",
]);

export function activationEffectValueFields(effect: AbilityEffectDefinition): ActivationEffectValueField[] {
  if (AMOUNT_TYPES.has(effect.effect_type)) {
    return [{
      key: "amount",
      label: effect.value_mode === "percent" ? "Valor (%)" : "Valor (pontos)",
      initialValue: effect.amount,
      max: 1_000_000,
    }];
  }
  if (effect.effect_type === "dot_resistance") {
    return [{
      key: "dot_resistance_amount",
      label: (effect.dot_resistance_value_mode ?? "percent") === "percent" ? "Resistência (%)" : "Resistência (valor)",
      initialValue: effect.dot_resistance_amount ?? effect.amount,
      max: (effect.dot_resistance_value_mode ?? "percent") === "percent" ? 100 : 1_000_000,
    }];
  }
  if (effect.effect_type === "magic_healing_reversal") {
    return effect.magic_healing_reversal_damage_mode === "custom" || effect.magic_healing_reversal_damage_mode === "both"
      ? [{ key: "magic_healing_reversal_custom_damage", label: "Dano da reversão", initialValue: effect.magic_healing_reversal_custom_damage ?? 0, max: 1_000_000 }]
      : [];
  }
  if (effect.effect_type !== "healing") return [];
  const fields: ActivationEffectValueField[] = [];
  for (const key of ["hp", "mana", "body", "sanity"] as const) {
    if (!effect[`healing_${key}_enabled`]) continue;
    const fieldKey = `healing_${key}_amount` as ActivationEffectValueKey;
    const isPercent = effect[`healing_${key}_mode`] === "percent";
    fields.push({
      key: fieldKey,
      label: `Cura de ${({ hp: "HP", mana: "Mana", body: "Corpo", sanity: "Sanidade" })[key]} (${isPercent ? "%" : "fixo"})`,
      initialValue: effect[fieldKey] ?? 0,
      max: isPercent ? 100 : 1_000_000,
    });
  }
  for (const [key, label, max] of [
    ["healing_reduce_debuff_turns_fixed", "Reduzir duração de debuffs (turnos)", 1000],
    ["healing_reduce_debuff_turns_percent", "Reduzir duração de debuffs (%)", 100],
    ["healing_relieve_debuff_percent", "Alívio de debuffs (%)", 100],
  ] as const) {
    if ((effect[key] ?? 0) > 0) fields.push({ key, label, initialValue: effect[key] ?? 0, max });
  }
  return fields;
}

export function customizableActivationEffects(effects: AbilityEffectDefinition[]) {
  return effects.flatMap((effect, index) =>
    effect.modify_on_activate && activationEffectValueFields(effect).length
      ? [{ index, effect, fields: activationEffectValueFields(effect) }]
      : []
  );
}

export function parseActivationValueOverrides(
  effects: AbilityEffectDefinition[],
  input: Record<string, Record<string, string>>,
): Record<string, Record<string, number>> | null {
  const output: Record<string, Record<string, number>> = {};
  for (const { index, fields } of customizableActivationEffects(effects)) {
    const values: Record<string, number> = {};
    for (const field of fields) {
      const raw = input[String(index)]?.[field.key] ?? String(field.initialValue);
      if (raw.trim() === "") return null;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > field.max) return null;
      values[field.key] = value;
    }
    output[String(index)] = values;
  }
  return output;
}
