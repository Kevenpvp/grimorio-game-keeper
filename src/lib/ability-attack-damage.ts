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
