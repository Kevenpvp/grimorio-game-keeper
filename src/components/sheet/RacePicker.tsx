import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { raceMods, useDefs, useRaces, type AttributeDef, type Character, type Race } from "@/lib/sheets";

export function ModsList({ race, defs }: { race: Race; defs: AttributeDef[] }) {
  const mods = raceMods(race);
  const entries = defs.filter((d) => mods[d.key]);
  return (
    <div className="flex flex-wrap gap-1.5 text-xs">
      {entries.map((d) => (
        <span key={d.key} className={`tabular rounded px-2 py-0.5 bg-muted ${mods[d.key] > 0 ? "text-gold" : "text-destructive"}`}>
          {mods[d.key] > 0 ? "+" : ""}{mods[d.key]} {d.label}
        </span>
      ))}
      {race.bonus_points > 0 && (
        <span className="tabular rounded bg-muted px-2 py-0.5 text-gold">+{race.bonus_points} pontos livres</span>
      )}
      {!entries.length && !race.bonus_points && <span className="text-muted-foreground">Sem modificadores</span>}
    </div>
  );
}

/** Race choice. Players choose once; master can change anytime (rules enforced by choose_race in the database). */
export function RacePicker({ character, isMaster }: { character: Character; isMaster: boolean }) {
  const qc = useQueryClient();
  const { data: races } = useRaces();
  const { data: defs } = useDefs();
  const [busy, setBusy] = useState(false);
  const current = races?.find((r) => r.id === character.race_id);

  if (!races || !defs) return null;
  if (!isMaster && current) return null;

  async function choose(id: string | null) {
    if (!isMaster && !confirm("Escolher esta raça? Depois só o mestre pode trocar.")) return;
    setBusy(true);
    const { error } = await supabase.rpc("choose_race", { _character_id: character.id, _race_id: id as string });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success(id ? "Raça definida" : "Raça removida");
    qc.invalidateQueries({ queryKey: ["character", character.id] });
    qc.invalidateQueries({ queryKey: ["characters"] });
  }

  return (
    <section className="panel space-y-3 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg text-gold">{isMaster ? `Raça: ${current?.name ?? "nenhuma"}` : "Escolha sua raça"}</h2>
        {isMaster && current && <Button size="sm" variant="ghost" disabled={busy} onClick={() => choose(null)}>Remover raça</Button>}
      </div>
      {!races.length && <p className="text-sm text-muted-foreground">Nenhuma raça cadastrada ainda.</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {races.map((r) => (
          <div key={r.id} className={`rounded-lg border p-3 ${r.id === character.race_id ? "border-gold" : "border-border"}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{r.name}</span>
              <Button size="sm" variant="outline" disabled={busy || r.id === character.race_id} onClick={() => choose(r.id)}>
                {r.id === character.race_id ? "Atual" : "Escolher"}
              </Button>
            </div>
            {r.description && <p className="mt-1 text-xs text-muted-foreground">{r.description}</p>}
            <div className="mt-2"><ModsList race={r} defs={defs} /></div>
          </div>
        ))}
      </div>
    </section>
  );
}
