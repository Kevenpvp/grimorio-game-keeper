import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Flame, Plus, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useMe } from "@/lib/sheets";

export const Route = createFileRoute("/_authenticated/tipos-dano")({
  head: () => ({
    meta: [
      { title: "Tipos de Dano Mágico — Grimório" },
      { name: "description", content: "Gerencie os tipos de dano mágico da campanha." },
    ],
  }),
  component: DamageTypesPage,
});

function DamageTypesPage() {
  const { data: me, isLoading: loadingMe } = useMe();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<"magical" | "physical">("magical");
  const { data: types = [], isLoading, error } = useQuery({
    queryKey: ["damage-types"],
    enabled: !!me?.isMaster,
    queryFn: async () => {
      const { data, error } = await supabase.from("damage_types").select("id,name,category").order("name");
      if (error) throw error;
      return data;
    },
  });

  async function addType() {
    const clean = name.trim();
    if (!clean) { toast.error("Digite o nome do tipo mágico"); return; }
    if (clean.length > 40) { toast.error("Use no máximo 40 caracteres"); return; }
    const { error } = await supabase.from("damage_types").insert({ name: clean, category });
    if (error) {
      toast.error(error.message.toLowerCase().includes("duplicate") || error.code === "23505"
        ? "Esse tipo já existe"
        : error.message);
      return;
    }
    setName("");
    await qc.invalidateQueries({ queryKey: ["damage-types"] });
    toast.success(category === "physical" ? "Tipo de dano físico adicionado" : "Tipo de dano mágico adicionado");
  }

  async function removeType(id: string, typeName: string) {
    if (!confirm(`Excluir o tipo de dano "${typeName}"?`)) return;
    const { error } = await supabase.from("damage_types").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    await qc.invalidateQueries({ queryKey: ["damage-types"] });
    toast.success("Tipo removido");
  }

  if (loadingMe || !me) return <p className="text-muted-foreground">Carregando…</p>;
  if (!me.isMaster) return <p className="text-muted-foreground">Apenas o mestre pode gerenciar os tipos de dano.</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-3xl text-gold">
          <Sparkles className="h-7 w-7" /> Tipos de Dano
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Cadastre tipos físicos e mágicos. Os tipos físicos usam Defesa física; os mágicos usam Defesa Mágica.
          Esses tipos também podem ser usados para filtrar Dano Causado, Dano Recebido, Mitigação, Reversão de Cura e Vulnerabilidade de Dano.
        </p>
      </div>

      <section className="panel space-y-4 p-5">
        <h2 className="text-lg text-gold">Adicionar tipo</h2>
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); void addType(); }}>
          <label className="space-y-1 text-xs font-medium">
            Categoria
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={category}
              onChange={(e) => setCategory(e.target.value as "physical" | "magical")}
            >
              <option value="magical">Dano mágico</option>
              <option value="physical">Dano físico</option>
            </select>
          </label>
          <Input
            aria-label="Nome do tipo de dano"
            className="max-w-md"
            placeholder={category === "physical" ? "Ex.: Corte, Perfuração, Impacto, Esmagamento" : "Ex.: Fogo, Luz, Trevas, Sagrado, Gelo"}
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" disabled={!name.trim()}>
            <Plus className="mr-1 h-4 w-4" /> Adicionar tipo
          </Button>
        </form>
      </section>

      <section className="panel space-y-3 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg text-gold">Tipos cadastrados</h2>
          <span className="text-sm text-muted-foreground">{types.length} tipo(s)</span>
        </div>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando tipos…</p>
        ) : error ? (
          <p className="text-sm text-destructive">Não foi possível carregar os tipos. Verifique se a migração do banco de dados foi aplicada.</p>
        ) : types.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum tipo cadastrado.</p>
        ) : (
          <div className="divide-y divide-border">
            {types.map((type) => (
              <div key={type.id} className="flex items-center justify-between gap-3 py-3">
                <div className="flex items-center gap-2">
                  <Flame className="h-4 w-4 text-gold" />
                  <span>{type.name}</span>
                  <span className="rounded border border-border px-2 py-0.5 text-[10px] uppercase text-muted-foreground">
                    {type.category === "physical" ? "Físico" : "Mágico"}
                  </span>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void removeType(type.id, type.name)}>
                  <Trash2 className="mr-1 h-4 w-4" /> Excluir
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
