/**
 * Administrative HP adjustment on the combat card. Unlike Regenerar HP and
 * Aplicar Dano, this is a direct adjustment by the master: no buffs, damage
 * mitigation, or healing modifiers are involved.
 */
export function calculateManualCombatHp(
  currentValue: number,
  maximumValue: number,
  amount: number,
  direction: -1 | 1,
): number | null {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1_000_000
    || !Number.isFinite(currentValue) || !Number.isFinite(maximumValue)
    || (direction !== 1 && direction !== -1)) return null;
  const maximum = Math.max(0, Math.floor(maximumValue));
  const current = Math.max(0, Math.floor(currentValue));
  return Math.max(0, Math.min(maximum, current + amount * direction));
}
