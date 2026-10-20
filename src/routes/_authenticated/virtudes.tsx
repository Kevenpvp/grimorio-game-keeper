import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { traitMods, useDefs, useMe, useVirtues, type AttributeDef, type Virtue } from "@/lib/sheets";
import { useAbilities } from "@/lib/abilities";

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
  const { data: allAbilities = [], isLoading: catalogLoading } = useAbilities();
  const { data: virtueAbilityRows = [], isLoading: virtueAbilitiesLoading } = useQuery({
    queryKey: ["virtue-abilities", virtue.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("virtue_abilities")
        .select("ability_id")
        .eq("virtue_id", virtue.id);
      if (error) throw error;
      return data ?? [];
    },
  });
  const selectedAbilityIds = new Set(virtueAbilityRows.map((row) => row.ability_id));
  const [name, setName] = useState(virtue.name);
  const [description, setDescription] = useState(virtue.description ?? "");
  const [bonus, setBonus] = useState(virtue.bonus_points);
  const [mods, setMods] = useState(traitMods(virtue));

  async function toggleAbility(abilityId: string, checked: boolean) {
    const result = checked
      ? await supabase.from("virtue_abilities").insert({ virtue_id: virtue.id, ability_id: abilityId })
      : await supabase.from("virtue_abilities").delete().eq("virtue_id", virtue.id).eq("ability_id", abilityId);
    if (result.error) { toast.error(result.error.message); return; }
    toast.success(checked ? "Habilidade vinculada à virtude" : "Habilidade removida da virtude");
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["virtue-abilities", virtue.id] }),
      qc.invalidateQueries({ queryKey: ["character-abilities"] }),
      qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
    ]);
  }

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
      <div className="space-y-3 rounded-md border border-border p-3">
        <div>
          <h3 className="text-sm font-semibold text-gold">Habilidades concedidas por esta virtude</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Ao receber esta virtude, o personagem recebe automaticamente as habilidades marcadas abaixo.
            Ao perder a virtude, só essas habilidades concedidas por ela são removidas; habilidades atribuídas
            manualmente permanecem na ficha.
          </p>
        </div>
        {catalogLoading || virtueAbilitiesLoading ? (
          <p className="text-xs text-muted-foreground">Carregando habilidades…</p>
        ) : allAbilities.length === 0 ? (
          <p className="text-xs text-muted-foreground">Cadastre habilidades no catálogo para poder vinculá-las a esta virtude.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {allAbilities.map((ability) => (
              <label key={ability.id} className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selectedAbilityIds.has(ability.id)}
                  onChange={(event) => void toggleAbility(ability.id, event.target.checked)}
                />
                <span className="min-w-0">
                  <span className="block font-medium">{ability.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {ability.can_activate ? "Ativável" : "Passiva / não ativável"}
                    {ability.description ? ` · ${ability.description}` : ""}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <Button onClick={() => void save()}>Salvar</Button>
        <Button variant="destructive" onClick={() => void remove()}><Trash2 className="mr-1 h-4 w-4" /> Excluir</Button>
      </div>
    </section>
  );
}
