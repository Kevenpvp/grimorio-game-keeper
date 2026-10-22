import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

type Scope = "race" | "virtue";

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
  const table = scope === "race" ? "race_transformations" : "virtue_transformations";
  const keyColumn = scope === "race" ? "race_id" : "virtue_id";

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
          Os personagens que possuem esta {scope === "race" ? "raça" : "virtude"} poderão ativar as transformações selecionadas durante o combate.
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
        <div className="grid gap-2 sm:grid-cols-2">
          {transformations.map((transformation) => {
            const checked = assignments.some((row) => row.transformation_id === transformation.id);
            return (
              <label key={transformation.id} className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={checked}
                  onChange={(event) => void toggle(transformation.id, event.target.checked)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{transformation.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {transformation.cooldown_turns} turno(s) · {transformation.mana_cost > 0 ? `${transformation.mana_cost} Mana` : "sem custo de Mana"}
                  </span>
                  {transformation.description && <span className="mt-1 block text-xs text-muted-foreground">{transformation.description}</span>}
                </span>
                {checked && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />}
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
}
