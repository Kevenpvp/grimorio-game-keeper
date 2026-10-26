import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, RotateCcw, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import {
  clampNonDefenseAttribute, computeValue, conditionAdjustedValue,
  physicalAttributePoints, type AttributeDef, type Character, type CharacterAttr,
} from "@/lib/sheets";
import { AttrIcon } from "@/components/sheet/icons";

type StatusModifier = { fixed: number; percent: number };

type Props = {
  character: Character;
  attrs: CharacterAttr[];
  defs: AttributeDef[];
  traitModifiers: Record<string, number>;
  statusModifiers: Record<string, StatusModifier>;
  noMana: boolean;
  onSaved: () => void;
};

const MIN_BONUS = -1_000_000;
const MAX_BONUS = 1_000_000;

/**
 * Convert a requested effective total into the persisted manual bonus.
 * Origin-specific invested points remain untouched. This is deliberately
 * identical to the final-value calculation in the sheet's AttrEditor.
 */
export function effectiveAttributeValue(
  def: AttributeDef,
  character: Pick<Character, "body" | "sanity">,
  points: number,
  traitPoints: number,
  bonus: number,
  status: StatusModifier,
): number {
  const initial = computeValue(def, points + traitPoints);
  const adjusted = Math.floor((initial + bonus + status.fixed) * (1 + status.percent / 100));
  return conditionAdjustedValue(character, def.key, clampNonDefenseAttribute(def.key, adjusted));
}

/**
 * The effective attribute is monotonic for standard buffs, so a binary
 * search finds a bonus that produces exactly the requested number.
 * If a 200% buff or a Body/Sanity penalty makes a specific integer
 * impossible, do not save an approximation without telling the master.
 */
export function findManualBonus(
  target: number,
  originalBonus: number,
  evaluate: (bonus: number) => number,
): number | null {
  if (evaluate(originalBonus) === target) return originalBonus;
  if (evaluate(MIN_BONUS) > target || evaluate(MAX_BONUS) < target) return null;
  let low = MIN_BONUS;
  let high = MAX_BONUS;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (evaluate(mid) < target) low = mid + 1;
    else high = mid;
  }
  if (evaluate(low) !== target) return null;
  const first = low;
  high = MAX_BONUS;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (evaluate(mid) > target) high = mid - 1;
    else low = mid;
  }
  // Prefer a nearby modifier if many values display the same total.
  return Math.min(Math.max(originalBonus, first), low);
}

export function QuickMasterAttributes({
  character, attrs, defs, traitModifiers, statusModifiers, noMana, onSaved,
}: Props) {
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const rows = defs.filter((def) => def.accepts_points).map((def) => {
    const attr = attrs.find((row) => row.attribute_key === def.key);
    const points = attr?.points ?? 0;
    const traits = (traitModifiers[def.key] ?? 0) + physicalAttributePoints(character, def.key);
    const status = statusModifiers[def.key] ?? { fixed: 0, percent: 0 };
    const value = noMana && def.key === "mana"
      ? 0 : effectiveAttributeValue(def, character, points, traits, attr?.bonus ?? 0, status);
    return { def, attr, points, traits, status, value };
  });
  const changed = rows.filter((row) => drafts[row.def.key] !== undefined && drafts[row.def.key] !== String(row.value));
  async function save() {
    if (saving || changed.length === 0) return;
    const updates: Array<{ key: string; bonus: number; current?: number }> = [];
    for (const row of changed) {
      const raw = drafts[row.def.key]?.trim() ?? "";
      if (!/^-?\d+$/.test(raw)) {
        toast.error("Informe um número inteiro para " + row.def.label + ".");
        return;
      }
      const target = Number(raw);
      if (!Number.isSafeInteger(target) || target < -1_000_000 || target > 1_000_000 ||
        (target < 0 && row.def.key !== "phys_def" && row.def.key !== "mag_def")) {
        toast.error("Valor fora do limite permitido para " + row.def.label + ".");
        return;
      }
      if (!row.attr) {
        toast.error("O atributo " + row.def.label + " ainda não existe nesta ficha.");
        return;
      }
      if (noMana && row.def.key === "mana") {
        toast.error("Mana está bloqueada pelo efeito Sem Mana. Remova o efeito antes de definir outro valor.");
        return;
      }
      const bonus = findManualBonus(target, row.attr.bonus ?? 0, (candidate) =>
        effectiveAttributeValue(row.def, character, row.points, row.traits, candidate, row.status));
      if (bonus === null) {
        toast.error("Não é possível alcançar exatamente " + target + " em " + row.def.label +
          " com os efeitos e percentuais atuais. Ajuste os efeitos/Corpo/Sanidade ou escolha outro valor.");
        return;
      }
      if (bonus === row.attr.bonus) continue;
      // A smaller mana total must not leave the current resource above max.
      // Increasing mana never grants free current Mana.
      const current = row.def.key === "mana" && (row.attr.current_value ?? 0) > target
        ? Math.max(0, target) : undefined;
      updates.push({ key: row.def.key, bonus, current });
    }
    if (updates.length === 0) { setDrafts({}); return; }
    setSaving(true);
    let done = 0;
    try {
      for (const item of updates) {
        const { data, error } = await supabase.from("character_attributes")
          .update({
            bonus: item.bonus,
            ...(item.current === undefined ? {} : { current_value: item.current }),
          })
          .eq("character_id", character.id)
          .eq("attribute_key", item.key)
          .select("attribute_key")
          .maybeSingle();
        if (error || !data) throw new Error(error?.message || "O atributo não foi encontrado");
        done++;
        setDrafts((previous) => {
          const next = { ...previous }; delete next[item.key]; return next;
        });
      }
      toast.success(done === 1 ? "Atributo definido diretamente!" : done + " atributos atualizados!");
      onSaved();
    } catch (error) {
      toast.error((done > 0 ? done + " atributo(s) salvo(s). " : "") +
        (error instanceof Error ? error.message : "Falha ao atualizar os atributos."));
    } finally {
      await qc.invalidateQueries({ queryKey: ["character", character.id] });
      await qc.invalidateQueries({ queryKey: ["characters"] });
      setSaving(false);
    }
  }

  return (
    <section className="panel space-y-3 border-gold/45 p-3 sm:p-4" aria-label="Edição rápida de atributos pelo mestre">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 font-display text-lg text-gold"><SlidersHorizontal className="h-5 w-5" /> Definir atributos diretamente</h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            Digite o <strong>valor total desejado</strong> e salve. O sistema ajusta apenas o bônus manual:
            não gasta pontos e não altera os pontos de Raça, Classe ou Virtude. Os buffs e penalidades ativos continuam valendo.
          </p>
        </div>
        {changed.length > 0 && <span className="rounded-md border border-gold/30 bg-gold/10 px-2 py-1 text-xs font-medium text-gold">{changed.length} alteração(ões)</span>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map(({ def, value }) => (
          <label key={def.key} className="flex min-w-0 items-center gap-2 rounded-lg border border-gold/20 bg-[#100c0a]/55 px-3 py-2">
            <AttrIcon name={def.icon} className="h-4 w-4 shrink-0 text-gold" />
            <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={def.label}>{def.label}</span>
            <Input
              type="number" step="1" inputMode="numeric"
              aria-label={"Valor total desejado de " + def.label}
              disabled={saving || (noMana && def.key === "mana")}
              className="h-10 w-24 shrink-0 text-center font-semibold tabular-nums sm:w-28"
              value={drafts[def.key] ?? String(value)}
              onChange={(event) => setDrafts((previous) => ({ ...previous, [def.key]: event.target.value }))}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void save(); } }}
            />
          </label>
        ))}
      </div>
      {noMana && <p className="text-xs text-amber-400">Mana indisponível: o efeito Sem Mana está ativo.</p>}
      <div className="flex flex-col gap-2 border-t border-gold/15 pt-3 sm:flex-row sm:justify-end">
        <Button variant="outline" type="button" className="min-h-11 sm:min-w-32"
          disabled={saving || changed.length === 0} onClick={() => setDrafts({})}>
          <RotateCcw className="mr-1 h-4 w-4" /> Desfazer
        </Button>
        <Button type="button" className="min-h-11 sm:min-w-40" disabled={saving || changed.length === 0}
          onClick={() => void save()}>
          <Check className="mr-1 h-4 w-4" /> {saving ? "Salvando..." : "Salvar valores"}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">HP atual e máximo permanecem editáveis no grupo “HP e Mana” abaixo. Se reduzir a Mana total, a Mana atual será limitada ao novo total.</p>
    </section>
  );
}
