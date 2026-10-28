import type { AbilityAttackDamageConfig } from "@/lib/abilities";

/** Primary legacy attribute + optional extra sources in hybrid attacks.
 * Old saved attacks still calculate exactly as they did before. */
export function abilityAttackAttributeSources(config: AbilityAttackDamageConfig) {
  const result: Array<{ attribute_key: string; attribute_percent: number }> = [];
  const keys = new Set<string>();
  if (config.attribute_key) {
    result.push({ attribute_key: config.attribute_key, attribute_percent: config.attribute_percent });
    keys.add(config.attribute_key);
  }
  if (config.damage_kind === "hybrid") {
    for (const source of config.additional_attributes ?? []) {
      if (!source.attribute_key || keys.has(source.attribute_key)) continue;
      keys.add(source.attribute_key);
      result.push(source);
    }
  }
  return result;
}

/** Calculates the whole base hit before a SINGLE damage/defense pipeline. */
export function calculateAbilityAttackBaseDamage(
  config: AbilityAttackDamageConfig,
  attributeValue: (attributeKey: string) => number,
): number {
  const sum = abilityAttackAttributeSources(config).reduce((total, source) => {
    const stat = Number(attributeValue(source.attribute_key));
    const percent = Number(source.attribute_percent);
    if (!Number.isFinite(stat) || !Number.isFinite(percent)) return total;
    return total + Math.max(0, stat) * Math.max(0, Math.min(1000, percent)) / 100;
  }, Math.max(0, Number(config.fixed_damage) || 0));
  return Math.min(1_000_000, Math.max(0, Math.round(sum)));
}

/**
 * Apply per-target master overrides to the ability's calculated base damage.
 * A signed fixed adjustment is applied first, followed by the signed percent.
 * Example: base 50, +10 fixed, -25% => 45 before defense.
 */
export function applyAbilityTargetDamage(
  baseDamage: number,
  fixedAdjustment: number,
  percentAdjustment: number,
): number {
  const adjustedBase = Math.max(0, baseDamage + fixedAdjustment);
  return Math.max(0, Math.min(1_000_000, Math.round(adjustedBase * (1 + percentAdjustment / 100))));
}

export function isValidAbilityTargetAdjustment(fixed: number, percent: number): boolean {
  return Number.isInteger(fixed) && fixed >= -1_000_000 && fixed <= 1_000_000
    && Number.isFinite(percent) && percent >= -100 && percent <= 1000;
}

/** A zero-damage ability hit applies its effects but must not invoke the damage
 * pipeline: flat damage bonuses, vulnerabilities and negative defenses could
 * turn raw 0 into HP loss. Positive hits retain all those normal modifiers. */
export function shouldApplyAbilityDirectDamage(rawDamage: number): boolean {
  return Number.isFinite(rawDamage) && rawDamage > 0;
}
