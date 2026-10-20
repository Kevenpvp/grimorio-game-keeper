import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { traitMods, useDefs, useMe, useVirtues, type AttributeDef, type Virtue } from "@/lib/sheets";

export const Route = createFileRoute("/_authenticated/virtudes")({
  head: () => ({
    meta: [
      { title: "Virtudes — Grimório" },
      { name: "description", content: "Configure as virtudes e seus modificadores." },
      { property: "og:title", content: "Virtudes — Grimório" },
      { property: "og:description", content: "Configure as virtudes e seus modificadores." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: VirtudesPage,
});

function VirtudesPage() {
  const { data: me } = useMe();
  const { data: virtues } = useVirtues();
  const { data: defs } = useDefs();
  const qc = useQueryClient();

  if (!me || !virtues || !defs) return <p className="text-muted-foreground">Carregando…</p>;
  if (!me.isMaster) return <p className="text-muted-foreground">Apenas o mestre gerencia virtudes.</p>;

  async function create() {
    const { error } = await supabase.from("virtues").insert({ name: "Nova virtude" });
    if (error) { toast.error(error.message); return; }
    toast.success("Virtude criada");
    await qc.invalidateQueries({ queryKey: ["virtues"] });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl text-gold">Virtudes</h1>
          <p className="mt-1 text-sm text-muted-foreground">As virtudes usam os mesmos bônus de pontos e modificadores por atributo das raças.</p>
        </div>
        <Button onClick={() => void create()}><Plus className="mr-1 h-4 w-4" /> Nova virtude</Button>
      </div>
      {!virtues.length && <p className="text-muted-foreground">Nenhuma virtude ainda.</p>}
      {virtues.map((virtue) => <VirtueEditor key={virtue.id} virtue={virtue} defs={defs} />)}
    </div>
  );
}

function VirtueEditor({ virtue, defs }: { virtue: Virtue; defs: AttributeDef[] }) {
  const qc = useQueryClient();
  const [name, setName] = useState(virtue.name);
  const [description, setDescription] = useState(virtue.description ?? "");
  const [bonus, setBonus] = useState(virtue.bonus_points);
  const [mods, setMods] = useState(traitMods(virtue));

  async function save() {
    if (!name.trim()) { toast.error("Informe o nome"); return; }
    const clean: Record<string, number> = {};
    for (const [key, value] of Object.entries(mods)) {
      if (Math.round(value)) clean[key] = Math.round(value);
    }
    const { error } = await supabase.from("virtues").update({
      name: name.trim(),
      description: description.trim() || null,
      bonus_points: Math.max(0, Math.round(bonus) || 0),
      modifiers: clean,
    }).eq("id", virtue.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Virtude salva");
    await qc.invalidateQueries({ queryKey: ["virtues"] });
  }

  async function remove() {
    if (!confirm(`Excluir a virtude ${virtue.name}? Fichas com ela ficarão sem virtude.`)) return;
    const { error } = await supabase.from("virtues").delete().eq("id", virtue.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Virtude excluída");
    await qc.invalidateQueries({ queryKey: ["virtues"] });
    await qc.invalidateQueries({ queryKey: ["characters"] });
    await qc.invalidateQueries({ queryKey: ["my-character"] });
  }

  return (
    <section className="panel space-y-4 p-5">
      <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
        <div className="space-y-1.5"><Label>Nome</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="space-y-1.5">
          <Label>Pontos livres extras</Label>
          <Input type="number" min={0} value={bonus} onChange={(e) => setBonus(Number(e.target.value))} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Descrição</Label>
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
      <div>
        <Label className="text-muted-foreground">Pontos iniciais por atributo (negativo = penalidade)</Label>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {defs.map((def) => (
            <div key={def.key} className="space-y-1">
              <span className="text-xs text-muted-foreground">{def.label}</span>
              <Input type="number" className="tabular" value={mods[def.key] ?? 0}
                onChange={(e) => setMods({ ...mods, [def.key]: Number(e.target.value) || 0 })} />
            </div>
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <Button onClick={() => void save()}>Salvar</Button>
        <Button variant="destructive" onClick={() => void remove()}><Trash2 className="mr-1 h-4 w-4" /> Excluir</Button>
      </div>
    </section>
  );
}
