import { createFileRoute } from "@tanstack/react-router";
import { Flame } from "lucide-react";
import { DamageOverTimeManager } from "@/components/combat/DamageOverTimeManager";
import { useMe } from "@/lib/sheets";

export const Route = createFileRoute("/_authenticated/dots")({
  head: () => ({
    meta: [
      { title: "Dano por Turno — Grimório" },
      { name: "description", content: "Cadastre e gerencie modelos persistentes de dano por turno (DoT)." },
    ],
  }),
  component: DamageOverTimeTemplatesPage,
});

function DamageOverTimeTemplatesPage() {
  const { data: me, isLoading } = useMe();

  if (isLoading || !me) return <p className="text-muted-foreground">Carregando…</p>;
  if (!me.isMaster) {
    return <p className="text-muted-foreground">Apenas o mestre pode cadastrar e gerenciar modelos de DoT.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="grimorio-section-header">
        <h1 className="flex items-center gap-2 font-display text-3xl font-semibold text-gold">
          <Flame className="h-7 w-7" /> Dano por Turno (DoT)
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Cadastre modelos uma única vez e reutilize-os em qualquer batalha. Os modelos são salvos no banco de dados
          e permanecem disponíveis até que você os exclua. Para aplicar um modelo a um personagem, use a seção DoT
          dentro do Modo de Combate.
        </p>
      </div>

      <DamageOverTimeManager mode="templates" battleId={null} fighters={[]} active={false} />
    </div>
  );
}
