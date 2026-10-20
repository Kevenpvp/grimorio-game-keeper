import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { allocationTotal, computeValue, conditionAdjustedValue, numberAllocation, type AttributeDef, type Character, type CharacterAttr } from "@/lib/sheets";
import { AttrIcon } from "./icons";

export function PointsDistribution({
  character, attrs, defs, canRemove = false,
}: { character: Character; attrs: CharacterAttr[]; defs: AttributeDef[]; canRemove?: boolean }) {
  const qc = useQueryClient();
  const [alloc, setAlloc] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<"race" | "virtue" | "base">("base");
  const raceAlloc = numberAllocation(character.race_attribute_allocations);
  const virtueAlloc = numberAllocation(character.virtue_attribute_allocations);
  const raceRemaining = Math.max(0, character.race_points_granted - allocationTotal(raceAlloc));
  const virtueRemaining = Math.max(0, character.virtue_points_granted - allocationTotal(virtueAlloc));
  const baseRemaining = Math.max(0, character.available_points - raceRemaining - virtueRemaining);
  const sourceAvailable = source === "race" ? raceRemaining : source === "virtue" ? virtueRemaining : baseRemaining;
  useEffect(() => {
    setAlloc({});
    const raceLeft = Math.max(0, character.race_points_granted - allocationTotal(character.race_attribute_allocations));
    const virtueLeft = Math.max(0, character.virtue_points_granted - allocationTotal(character.virtue_attribute_allocations));
    const baseLeft = Math.max(0, character.available_points - raceLeft - virtueLeft);
    setSource((current) => {
      if (current === "race" && raceLeft > 0) return "race";
      if (current === "virtue" && virtueLeft > 0) return "virtue";
      if (current === "base" && baseLeft > 0) return "base";
      return raceLeft > 0 ? "race" : virtueLeft > 0 ? "virtue" : "base";
    });
  }, [character.id, character.race_id, character.virtue_id, character.race_points_granted, character.virtue_points_granted, character.race_attribute_allocations, character.virtue_attribute_allocations]);
  const byKey = new Map(attrs.map((a) => [a.attribute_key, a]));
  const pointDefs = defs.filter((d) => d.accepts_points);
  const spent = Object.values(alloc).reduce((a, b) => a + b, 0);
  const remaining = sourceAvailable - spent;

  function change(key: string, delta: number) {
    const invested = byKey.get(key)?.points ?? 0;
    const sourceInvested = source === "race"
      ? raceAlloc[key] ?? 0
      : source === "virtue"
        ? virtueAlloc[key] ?? 0
        : Math.max(0, invested - (raceAlloc[key] ?? 0) - (virtueAlloc[key] ?? 0));
    const next = (alloc[key] ?? 0) + delta;
    if (delta > 0 && remaining <= 0) return;
    if (next < 0 && (!canRemove || sourceInvested + next < 0)) return;
    setAlloc({ ...alloc, [key]: next });
  }

  async function confirm() {
    if (busy || remaining < 0) return;
    const clean = Object.fromEntries(Object.entries(alloc).filter(([, value]) => value !== 0));
    if (Object.keys(clean).length === 0) return;
    setBusy(true);
    const { error } = await supabase.rpc("invest_points_from_source", {
      _character_id: character.id,
      _source: source,
      _allocations: clean,
    });
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Distribuição salva");
    }
    // Wait for the fresh balance before unlocking, so the old balance is never reused.
    await qc.refetchQueries({ queryKey: ["character", character.id] });
    qc.invalidateQueries({ queryKey: ["characters"] });
    setAlloc({});
    setBusy(false);
  }

  return (
    <section className="panel space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg text-gold">Distribuição de Pontos</h2>
          <p className="mt-1 text-xs text-muted-foreground">Escolha a origem para que os pontos investidos sejam removidos junto com a raça ou virtude correspondente.</p>
        </div>
        <div className="rounded-md border border-gold/50 px-4 py-2 text-center">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Pontos desta origem</div>
          <div className="tabular text-3xl font-bold text-gold">{remaining}</div>
        </div>
        <label className="w-full space-y-1 text-xs font-medium sm:max-w-xs">
          <span>Origem dos pontos</span>
          <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={source} disabled={busy}
            onChange={(e) => { setSource(e.target.value as "race" | "virtue" | "base"); setAlloc({}); }}>
            <option value="race">Raça ({raceRemaining} disponíveis)</option>
            <option value="virtue">Virtude ({virtueRemaining} disponíveis)</option>
            <option value="base">Pontos livres ({baseRemaining} disponíveis)</option>
          </select>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {pointDefs.map((d) => {
          const invested = byKey.get(d.key)?.points ?? 0;
          const pending = alloc[d.key] ?? 0;
          const total = invested + pending;
          const fromRace = Math.max(0, (raceAlloc[d.key] ?? 0) + (source === "race" ? pending : 0));
          const fromVirtue = Math.max(0, (virtueAlloc[d.key] ?? 0) + (source === "virtue" ? pending : 0));
          const fromBase = Math.max(0, invested - (raceAlloc[d.key] ?? 0) - (virtueAlloc[d.key] ?? 0) + (source === "base" ? pending : 0));
          return (
            <div key={d.key} className="rounded-md border border-border bg-muted/40 p-3">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
                <AttrIcon name={d.icon} className="h-4 w-4 text-gold" /> {d.label}
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <div>
                  <div className="tabular text-xl font-bold">{conditionAdjustedValue(character, d.key, computeValue(d, total))}</div>
                  <div className="tabular text-xs text-muted-foreground">
                    {total} pts {pending !== 0 && <span className="text-gold">({pending > 0 ? "+" : ""}{pending})</span>}
                  </div>
                  {(fromRace > 0 || fromVirtue > 0) && (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      Origem: {fromRace > 0 && <span>{fromRace} raça</span>}
                      {fromRace > 0 && fromVirtue > 0 && " · "}
                      {fromVirtue > 0 && <span>{fromVirtue} virtude</span>}
                      {fromBase > 0 && <> · {fromBase} livres</>}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button size="icon" variant="outline" className="h-8 w-8" aria-label={`Remover ponto de ${d.label}`}
                    disabled={pending <= 0 && (!canRemove || (source === "race" ? (raceAlloc[d.key] ?? 0) : source === "virtue" ? (virtueAlloc[d.key] ?? 0) : Math.max(0, invested - (raceAlloc[d.key] ?? 0) - (virtueAlloc[d.key] ?? 0))) + pending <= 0)} onClick={() => change(d.key, -1)}>
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
