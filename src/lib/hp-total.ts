/**
 * Effective HP cap for a character sheet.
 * The editable stored maximum is only the base; race/virtue/class and
 * active status modifiers may raise or lower the amount of HP available.
 * The order mirrors calculate_character_resource_max in Supabase.
 */
export function effectiveHpTotal(
  storedMaximum: number,
  traitHpBonus: number,
  manualHpBonus: number,
  fixedStatusHpBonus: number,
  percentStatusHpBonus: number,
): number {
  return Math.max(
    1,
    Math.floor(
      (storedMaximum + traitHpBonus + manualHpBonus + fixedStatusHpBonus)
      * (1 + percentStatusHpBonus / 100),
    ),
  );
}
