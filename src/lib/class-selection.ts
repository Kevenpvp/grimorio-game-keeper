/**
 * Check whether the class picker has anything new to confirm.
 * The master may also edit per-character bonuses without changing the class;
 * blank fields and zero represent the same unchanged bonus.
 */
export function classSelectionHasChanges({
  selectedClassId,
  confirmedClassId,
  draftModifiers,
  confirmedModifiers,
  isMaster,
}: {
  selectedClassId: string | null;
  confirmedClassId: string | null;
  draftModifiers: Record<string, string>;
  confirmedModifiers: Record<string, number>;
  isMaster: boolean;
}): boolean {
  if (selectedClassId !== confirmedClassId) return true;
  if (!isMaster || selectedClassId === null) return false;

  const keys = new Set([...Object.keys(draftModifiers), ...Object.keys(confirmedModifiers)]);
  return [...keys].some((key) => {
    const rawValue = draftModifiers[key]?.trim() ?? "";
    const numberValue = rawValue === "" ? 0 : Number(rawValue);
    // Invalid draft values must still allow confirmation so validation can
    // explain what's wrong instead of silently disabling the button.
    return !Number.isFinite(numberValue) || numberValue !== (confirmedModifiers[key] ?? 0);
  });
}
