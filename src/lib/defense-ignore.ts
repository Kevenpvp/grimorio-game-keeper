/** Defense penetration is calculated after all target defense bonuses and
 * before normal mitigation. Percentages combine additively (up to 100%),
 * followed by flat penetration. All values are nonnegative. */
export type DefenseIgnore = {
  physical_percent: number;
  physical_fixed: number;
  magical_percent: number;
  magical_fixed: number;
};
export const ZERO_DEFENSE_IGNORE: DefenseIgnore = {
  physical_percent: 0, physical_fixed: 0, magical_percent: 0, magical_fixed: 0,
};
export const DEFENSE_IGNORE_FIELDS: Array<{
  key: keyof DefenseIgnore; label: string; max: number;
}> = [
  { key: "physical_percent", label: "Ignorar Defesa Física (%)", max: 100 },
  { key: "physical_fixed", label: "Ignorar Defesa Física (valor)", max: 1_000_000 },
  { key: "magical_percent", label: "Ignorar Defesa Mágica (%)", max: 100 },
  { key: "magical_fixed", label: "Ignorar Defesa Mágica (valor)", max: 1_000_000 },
];
export function parseDefenseIgnore(value: unknown): DefenseIgnore {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const clean = { ...ZERO_DEFENSE_IGNORE };
  for (const { key, max } of DEFENSE_IGNORE_FIELDS) {
    const num = Number(raw[key] ?? 0);
    clean[key] = Number.isFinite(num) ? Math.max(0, Math.min(max, Math.floor(num))) : 0;
  }
  return clean;
}
export function addDefenseIgnore(...values: DefenseIgnore[]): DefenseIgnore {
  return parseDefenseIgnore(Object.fromEntries(
    DEFENSE_IGNORE_FIELDS.map(({ key }) => [
      key, values.reduce((total, config) => total + config[key], 0),
    ]),
  ));
}
export function remainingDefense(defense: number, percent: number, fixed: number): number {
  return Math.max(0, Math.floor(defense * (1 - Math.min(100,Math.max(0,percent))/100) - Math.max(0,fixed)));
}
export function defenseIgnoreText(value: DefenseIgnore): string {
  return [
    value.physical_percent ? `${value.physical_percent}% Def. Física` : "",
    value.physical_fixed ? `${value.physical_fixed} Def. Física` : "",
    value.magical_percent ? `${value.magical_percent}% Def. Mágica` : "",
    value.magical_fixed ? `${value.magical_fixed} Def. Mágica` : "",
  ].filter(Boolean).join(", ");
}
