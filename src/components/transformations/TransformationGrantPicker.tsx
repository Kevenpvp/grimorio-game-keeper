import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { SearchableGrantPicker } from "@/components/ui/searchable-grant-picker";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

type Scope = "race" | "virtue" | "class";

type TransformationRow = {
  id: string;
  name: string;
  description: string | null;
  cooldown_turns: number;
  mana_cost: number;
};

export function TransformationGrantPicker({ scope, traitId }: { scope: Scope; traitId: string }) {
  const db = supabase as any;
  const qc = useQueryClient();
  const table = scope === "race" ? "race_transformations" : scope === "virtue" ? "virtue_transformations" : "class_transformations";
  const keyColumn = scope === "race" ? "race_id" : scope === "virtue" ? "virtue_id" : "class_id";

  const { data: transformations = [], isLoading: loadingCatalog, error: catalogError } = useQuery<TransformationRow[]>({
    queryKey: ["transformations"],
    queryFn: async () => {
      const { data, error } = await db.from("transformations").select("id,name,description,cooldown_turns,mana_cost").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: assignments = [], isLoading: loadingAssignments, error: assignmentsError } = useQuery<Array<{ transformation_id: string }>>({
    queryKey: [table, traitId],
    queryFn: async () => {
      const { data, error } = await db.from(table).select("transformation_id").eq(keyColumn, traitId);
      if (error) throw error;
      return data ?? [];
    },
  });

  async function toggle(transformationId: string, checked: boolean) {
    const result = checked
      ? await db.from(table).insert({ [keyColumn]: traitId, transformation_id: transformationId })
      : await db.from(table).delete().eq(keyColumn, traitId).eq("transformation_id", transformationId);
    if (result.error) {
      toast.error(result.error.message);
      return;
    }
    toast.success(checked ? "Transformação concedida" : "Transformação removida");
    await Promise.all([
      qc.invalidateQueries({ queryKey: [table] }),
      qc.invalidateQueries({ queryKey: [table, traitId] }),
      qc.invalidateQueries({ queryKey: ["character-transformations"] }),
      qc.invalidateQueries({ queryKey: ["battle-character-transformations"] }),
    ]);
  }

  return (
    <section className="space-y-3 rounded-md border border-border p-3">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gold">
          <Sparkles className="h-4 w-4" /> Transformações concedidas
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Os personagens que possuem esta {scope === "race" ? "raça" : scope === "virtue" ? "virtude" : "classe"} poderão ativar as transformações selecionadas durante o combate.
        </p>
      </div>
      {catalogError || assignmentsError ? (
        <p className="text-xs text-destructive">Não foi possível carregar as transformações. Confira se a migração do sistema de transformações está aplicada.</p>
      ) : loadingCatalog || loadingAssignments ? (
        <p className="text-xs text-muted-foreground">Carregando transformações…</p>
      ) : transformations.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nenhuma transformação cadastrada. <Link to="/transformacoes" className="text-gold underline">Criar transformações</Link>.
        </p>
      ) : (
        <SearchableGrantPicker
          options={transformations.map((transformation) => ({
            id: transformation.id,
            name: transformation.name,
            description: `${transformation.cooldown_turns} turno(s) de recarga · ${transformation.mana_cost > 0 ? transformation.mana_cost + " Mana" : "sem custo de Mana"}${transformation.description ? " · " + transformation.description : ""}`,
          }))}
          selectedIds={new Set(assignments.map((row) => row.transformation_id))}
          selectedLabel="Transformações concedidas"
          addLabel="Conceder transformação"
          emptyLabel="Nenhuma transformação concedida ainda."
          searchPlaceholder="Buscar transformação pelo nome…"
          onToggle={(id, checked) => void toggle(id, checked)}
        />
      )}
    </section>
  );
}
