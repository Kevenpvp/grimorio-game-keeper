import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { raceMods, useDefs, useMe, useRaces, type AttributeDef, type Race } from "@/lib/sheets";

export const Route = createFileRoute("/_authenticated/racas")({
  head: () => ({
    meta: [
      { title: "Raças — Grimório" },
      { name: "description", content: "Configure as raças e seus modificadores." },
      { property: "og:title", content: "Raças — Grimório" },
      { property: "og:description", content: "Configure as raças e seus modificadores." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: RacasPage,
});

function RacasPage() {
  const { data: me } = useMe();
  const { data: races } = useRaces();
  const { data: defs } = useDefs();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [pendingSaveIds, setPendingSaveIds] = useState<string[]>([]);
  if (!me || !races || !defs) return <p className="text-muted-foreground">Carregando…</p>;
  if (!me.isMaster) return <p className="text-muted-foreground">Apenas o mestre gerencia raças.</p>;

  async function create() {
    const { data, error } = await supabase.from("races").insert({ name: "Nova raça" }).select("id").single();
    if (error) { toast.error(error.message); return; }
    setSearch("");
    setPendingSaveIds((current) => [data.id, ...current.filter((id) => id !== data.id)]);
    toast.success("Nova raça criada. Ela ficará no topo até você salvar.");
    await qc.invalidateQueries({ queryKey: ["races"] });
  }

  const normalizedSearch = search.trim().toLocaleLowerCase("pt-BR");
  const visibleRaces = races
    .filter((race) => race.name.toLocaleLowerCase("pt-BR").includes(normalizedSearch))
    .slice()
    .sort((a, b) => {
      const aPending = pendingSaveIds.indexOf(a.id);
      const bPending = pendingSaveIds.indexOf(b.id);
      if (aPending >= 0 && bPending >= 0) return aPending - bPending;
      if (aPending >= 0) return -1;
      if (bPending >= 0) return 1;
      return 0;
    });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl text-gold">Raças</h1>
        <Button onClick={create}><Plus className="mr-1 h-4 w-4" /> Nova raça</Button>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" aria-label="Pesquisar raças pelo nome" placeholder="Pesquisar raça pelo nome..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {!races.length && <p className="text-muted-foreground">Nenhuma raça ainda.</p>}
      {races.length > 0 && visibleRaces.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma raça encontrada para “{search}”.</p>}
      {visibleRaces.map((r) => <RaceEditor key={r.id} race={r} defs={defs} isNew={pendingSaveIds.includes(r.id)} onSaved={() => setPendingSaveIds((current) => current.filter((id) => id !== r.id))} />)}
    </div>
  );
}

function RaceEditor({ race, defs, isNew, onSaved }: { race: Race; defs: AttributeDef[]; isNew: boolean; onSaved: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(race.name);
  const [description, setDescription] = useState(race.description ?? "");
  const [bonus, setBonus] = useState(race.bonus_points);
  const [physicalBonus, setPhysicalBonus] = useState(race.physical_bonus_points);
  const [mods, setMods] = useState(raceMods(race));

  async function save() {
    if (!name.trim()) { toast.error("Informe o nome"); return; }
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(mods)) if (Math.round(v)) clean[k] = Math.round(v);
    const { error } = await supabase.from("races").update({
      name: name.trim(), description: description.trim() || null,
      bonus_points: Math.max(0, Math.round(bonus) || 0),
      physical_bonus_points: Math.max(0, Math.round(physicalBonus) || 0), modifiers: clean,
    }).eq("id", race.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Raça salva");
    await qc.invalidateQueries({ queryKey: ["races"] });
    onSaved();
  }

  async function remove() {
    if (!confirm(`Excluir a raça ${race.name}? Fichas com ela ficam sem raça.`)) return;
    const { error } = await supabase.from("races").delete().eq("id", race.id);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries({ queryKey: ["races"] });
  }

  return (
    <section className="panel space-y-4 p-5">
      {isNew && <p className="text-xs font-semibold text-amber-500">Nova raça — salve para confirmar as alterações.</p>}
      <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
        <div className="space-y-1.5"><Label>Nome</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Pontos livres extras</Label>
          <Input type="number" min={0} value={bonus} onChange={(e) => setBonus(Number(e.target.value))} /></div>
        <div className="space-y-1.5"><Label>Pontos extras de atributos físicos</Label><Input type="number" min={0} value={physicalBonus} onChange={(e) => setPhysicalBonus(Number(e.target.value))} /></div>
        <div className="space-y-1.5 sm:col-span-2"><Label>Descrição</Label>
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      </div>
      <div>
        <Label className="text-muted-foreground">Pontos iniciais por atributo (negativo = penalidade)</Label>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {defs.map((d) => (
            <div key={d.key} className="space-y-1">
              <span className="text-xs text-muted-foreground">{d.label}</span>
              <Input type="number" className="tabular" value={mods[d.key] ?? 0}
                onChange={(e) => setMods({ ...mods, [d.key]: Number(e.target.value) || 0 })} />
            </div>
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <Button onClick={save}>{isNew ? "Salvar nova raça" : "Salvar"}</Button>
        <Button variant="destructive" onClick={remove}><Trash2 className="mr-1 h-4 w-4" /> Excluir</Button>
      </div>
    </section>
  );
}
