import type { ContinuousInstance, ContinuousRule } from "@/lib/continuous-effects";

export type TransferRequirement = {
  ruleIndex: number;
  name: string;
  needed: number;
  available: ContinuousInstance[];
};

export type TransferPlan = {
  requirements: TransferRequirement[];
  error: string | null;
};

/**
 * Calculate target transfer BEFORE charging mana or consuming cooldown.
 * The server revalidates these choices atomically during attack activation.
 */
export function planContinuousTargetTransfer(
  rules: ContinuousRule[],
  activeLinks: ContinuousInstance[],
  hitTargetIds: string[],
): TransferPlan {
  const hits = [...new Set(hitTargetIds)];
  const requirements: TransferRequirement[] = [];
  if (!hits.length) return { requirements, error: null };
  for (const [index, rule] of rules.entries()) {
    if (rule.max_targets === null) continue;
    const cap = rule.max_targets;
    const active = activeLinks.filter(link => link.active && link.rule_index === index);
    const held = new Set(active.map(link => link.target_character_id));
    const newHits = hits.filter(id => !held.has(id));
    if (newHits.length > cap) {
      return { requirements: [], error: `${rule.name}: selecione até ${cap} novo(s) alvo(s) acertado(s) por ataque.` };
    }
    const excess = active.length + newHits.length - cap;
    if (excess <= 0) continue;
    if (rule.on_limit === "block") {
      return { requirements: [], error: `${rule.name}: limite de ${cap} alvo(s) atingido. Solte um alvo anterior para atacar outro.` };
    }
    if (rule.on_limit === "choose") {
      const available = active.filter(link => !hits.includes(link.target_character_id));
      if (available.length < excess) {
        return { requirements: [], error: `${rule.name}: não há vínculos anteriores suficientes para liberar.` };
      }
      requirements.push({ ruleIndex: index, name: rule.name, needed: excess, available });
    }
  }
  return { requirements, error: null };
}

export function validateTransferSelection(requirements: TransferRequirement[], selectedIds: string[]): boolean {
  const selected = new Set(selectedIds);
  if (selected.size !== selectedIds.length) return false;
  const known = new Set(requirements.flatMap(group => group.available.map(link => link.id)));
  if (selectedIds.some(id => !known.has(id))) return false;
  return requirements.every(group =>
    group.available.filter(link => selected.has(link.id)).length === group.needed
  );
}
