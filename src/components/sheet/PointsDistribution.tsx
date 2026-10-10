import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { computeValue, type AttributeDef, type Character, type CharacterAttr } from "@/lib/sheets";
import { AttrIcon } from "./icons";

export function PointsDistribution({
  character, attrs, defs, canRemove = false,
}: { character: Character; attrs: CharacterAttr[]; defs: AttributeDef[]; canRemove?: boolean }) {
  const qc = useQueryClient();
  const [alloc, setAlloc] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const byKey = new Map(attrs.map((a) => [a.attribute_key, a]));
  const pointDefs = defs.filter((d) => d.accepts_points);
  const spent = Object.values(alloc).reduce((a, b) => a + b, 0);
  const remaining = character.available_points - spent;

  function change(key: string, delta: number) {
    const invested = byKey.get(key)?.points ?? 0;
    const next = (alloc[key] ?? 0) + delta;
    if (delta > 0 && remaining <= 0) return;
    if (next < 0 && (!canRemove || invested + next < 0)) return;
    setAlloc({ ...alloc, [key]: next });
  }

  async function confirm() {
    setBusy(true);
    const { error } = await supabase.rpc("invest_points", { _character_id: character.id, _allocations: alloc });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    setAlloc({});
    toast.success("Distribuição salva");
    qc.invalidateQueries({ queryKey: ["character", character.id] });
    qc.invalidateQueries({ queryKey: ["characters"] });
  }

  return (
    <section className="panel space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg text-gold">Distribuição de Pontos</h2>
        <div className="rounded-md border border-gold/50 px-4 py-2 text-center">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Pontos disponíveis</div>
          <div className="tabular text-3xl font-bold text-gold">{remaining}</div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {pointDefs.map((d) => {
          const invested = byKey.get(d.key)?.points ?? 0;
          const pending = alloc[d.key] ?? 0;
          const total = invested + pending;
          return (
            <div key={d.key} className="rounded-md border border-border bg-muted/40 p-3">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
                <AttrIcon name={d.icon} className="h-4 w-4 text-gold" /> {d.label}
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <div>
                  <div className="tabular text-xl font-bold">{computeValue(d, total)}</div>
                  <div className="tabular text-xs text-muted-foreground">
                    {total} pts {pending !== 0 && <span className="text-gold">({pending > 0 ? "+" : ""}{pending})</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="icon" variant="outline" className="h-8 w-8" aria-label={`Remover ponto de ${d.label}`}
                    disabled={pending <= 0 && (!canRemove || total <= 0)} onClick={() => change(d.key, -1)}>
                    <Minus className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="outline" className="h-8 w-8" aria-label={`Adicionar ponto em ${d.label}`}
                    disabled={remaining <= 0} onClick={() => change(d.key, 1)}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy || Object.keys(alloc).length === 0} onClick={() => setAlloc({})}>Desfazer</Button>
        <Button disabled={busy || Object.values(alloc).every((v) => v === 0)} onClick={confirm}>Confirmar distribuição</Button>
      </div>
    </section>
  );
}
