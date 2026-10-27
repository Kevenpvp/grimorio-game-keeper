import type { AbilityAttackDamageConfig } from "@/lib/abilities";

/** Preview only; the server independently validates live HP under row locks. */
export function isAttackExecutionEligible(
  config: AbilityAttackDamageConfig,
  currentHp: number,
  maxHp: number,
): boolean {
  if (!config.execute_enabled || !Number.isFinite(currentHp) || !Number.isFinite(maxHp)
    || maxHp <= 0 || currentHp <= 0) return false;
  const threshold=config.execute_threshold;
  if (!Number.isFinite(threshold) || threshold<0) return false;
  return config.execute_mode==="fixed"
    ? currentHp<=threshold && threshold<=1_000_000
    : threshold<=100 && currentHp*100<=maxHp*threshold;
}
