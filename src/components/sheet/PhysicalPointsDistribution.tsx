import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { allocationTotal, computeValue, numberAllocation, physicalAttributePoints, useCharacterTraitMods, type AttributeDef, type Character, type CharacterAttr } from "@/lib/sheets";
import { AttrIcon } from "./icons";

const physicalKeys = new Set(["strength", "phys_def", "speed", "atk_speed"]);

export function PhysicalPointsDistribution({
  character, attrs, defs,
}: { character: Character; attrs: CharacterAttr[]; defs: AttributeDef[] }) {
  const qc = useQueryClient();
  const [alloc, setAlloc] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const { mods } = useCharacterTraitMods(character.race_id, character.virtue_id);
  const byKey = new Map(attrs.map((a) => [a.attribute_key, a]));
  const raceAlloc = numberAllocation(character.race_physical_allocations);
  const virtueAlloc = numberAllocation(character.virtue_physical_allocations);
  const raceRemaining = Math.max(0, character.race_physical_points_granted - allocationTotal(raceAlloc));
  const virtueRemaining = Math.max(0, character.virtue_physical_points_granted - allocationTotal(virtueAlloc));
  const spentDraft = Object.values(alloc).reduce((sum, n) => sum + n, 0);
  const remaining = raceRemaining + virtueRemaining - spentDraft;
  const pointDefs = defs.filter((d) => physicalKeys.has(d.key) && d.accepts_points);

  function change(key: string, delta: number) {
    const next = (alloc[key] ?? 0) + delta;
    if (delta > 0 && remaining <= 0) return;
    if (next < 0) return;
    setAlloc({ ...alloc, [key]: next });
  }

  async function confirm() {
    if (busy || remaining < 0) return;
    const clean = Object.fromEntries(Object.entries(alloc).filter(([, value]) => value > 0));
    if (!Object.keys(clean).length) return;
    setBusy(true);
    const { error } = await supabase.rpc("invest_physical_points", {
      _character_id: character.id,
      _allocations: clean,
    });
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Pontos físicos distribuídos");
    }
    await qc.refetchQueries({ queryKey: ["character", character.id] });
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["characters"] }),
      qc.invalidateQueries({ queryKey: ["my-character"] }),
    ]);
    setAlloc({});
    setBusy(false);
  }

  return (
    <section className="panel space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg text-gold">Pontos Extras de Atributos Físicos</h2>
          <p className="mt-1 text-xs text-muted-foreground">Só podem ser distribuídos em Força, Defesa física, Velocidade e Velocidade de ataque. Estes pontos são separados dos pontos livres normais.</p>
        </div>
        <div className="rounded-md border border-gold/50 px-4 py-2 text-center">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Pontos físicos disponíveis</div>
          <div className="tabular text-2xl font-bold text-gold">{remaining}</div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {pointDefs.map((def) => {
          const attr = byKey.get(def.key);
          const fromRace = raceAlloc[def.key] ?? 0;
          const fromVirtue = virtueAlloc[def.key] ?? 0;
          const pending = alloc[def.key] ?? 0;
          const totalPoints = (attr?.points ?? 0) + (mods[def.key] ?? 0)
            + physicalAttributePoints(character, def.key) + pending;
          return (
            <div key={def.key} className="rounded-md border border-border bg-muted/40 p-3">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
                <AttrIcon name={def.icon} className="h-4 w-4 text-gold" /> {def.label}
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <div>
                  <div className="tabular text-xl font-bold">{computeValue(def, totalPoints)}</div>
                  <div className="tabular text-xs text-muted-foreground">
                    {totalPoints} pts
                    {(fromRace > 0 || fromVirtue > 0 || pending > 0) && <span className="text-gold"> · físicos {fromRace + fromVirtue + pending}{pending > 0 ? ` (+${pending})` : ""}</span>}
                  </div>
                  {(fromRace > 0 || fromVirtue > 0) && <div className="mt-1 text-[11px] text-muted-foreground">{fromRace > 0 ? `${fromRace} da raça` : ""}{fromRace > 0 && fromVirtue > 0 ? " · " : ""}{fromVirtue > 0 ? `${fromVirtue} da virtude` : ""}</div>}
                </div>
                <div className="flex items-center gap-1">
                  <Button size="icon" variant="outline" className="h-8 w-8" aria-label={`Desfazer ponto físico de ${def.label}`}
                    disabled={pending <= 0 || busy} onClick={() => change(def.key, -1)}><Minus className="h-4 w-4" /></Button>
                  <Button size="icon" variant="outline" className="h-8 w-8" aria-label={`Adicionar ponto físico em ${def.label}`}
                    disabled={remaining <= 0 || busy} onClick={() => change(def.key, 1)}><Plus className="h-4 w-4" /></Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy || Object.values(alloc).every((n) => n === 0)} onClick={() => setAlloc({})}>Desfazer</Button>
        <Button disabled={busy || Object.values(alloc).every((n) => n === 0)} onClick={() => void confirm()}>{busy ? "Salvando..." : "Confirmar pontos físicos"}</Button>
      </div>
    </section>
  );
}
