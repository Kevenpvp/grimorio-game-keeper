/** One logical status effect in the editor, many legacy modifiers at runtime. */
export type AttributeStatusModifier = {
  attribute_key: string;
  value_mode: "fixed" | "percent";
  amount: number;
};

/** Reject duplicates, unknown keys, non-finite numbers; retain first valid occurrence. */
export function parseAttributeStatusModifiers(
  raw: unknown,
  allowedKeys?: ReadonlySet<string>,
): AttributeStatusModifier[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const output: AttributeStatusModifier[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const key = typeof candidate.attribute_key === "string" ? candidate.attribute_key : "";
    const amount = Number(candidate.amount);
    if (!key || seen.has(key) || (allowedKeys && !allowedKeys.has(key)) ||
        !Number.isFinite(amount) || amount < 0 || amount > 1_000_000) continue;
    seen.add(key);
    output.push({
      attribute_key: key,
      amount,
      value_mode: candidate.value_mode === "percent" ? "percent" : "fixed",
    });
  }
  return output;
}

export function statusModifiersForAttribute(
  effect: { attribute_key: string | null; value_mode: string; amount: number; attribute_modifiers?: unknown },
  key: string,
): Array<{ amount: number; value_mode: "fixed" | "percent" }> {
  const rows = parseAttributeStatusModifiers(effect.attribute_modifiers);
  if (rows.length) return rows.filter((r) => r.attribute_key === key);
  return effect.attribute_key === key
    ? [{ amount: Number(effect.amount), value_mode: effect.value_mode === "percent" ? "percent" : "fixed" }]
    : [];
}
