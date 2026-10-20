import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { parseAbilityEffects, useAbilities, type Ability, type AbilityEffectDefinition } from "@/lib/abilities";
import { useDefs, useMe } from "@/lib/sheets";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import type { Json } from "@/integrations/supabase/types";

export const Route = createFileRoute("/_authenticated/habilidades")({
  head: () => ({
    meta: [
      { title: "Habilidades — Grimório" },
      { name: "description", content: "Crie habilidades ativas e passivas para os personagens." },
      { property: "og:title", content: "Habilidades — Grimório" },
      { property: "og:description", content: "Crie habilidades ativas e passivas para os personagens." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: HabilidadesPage,
});

function HabilidadesPage() {
  const { data: me } = useMe();
  const { data: abilities } = useAbilities();
  const { data: defs } = useDefs();
  const qc = useQueryClient();

  if (!me || !abilities || !defs) return <p className="text-muted-foreground">Carregando…</p>;
  if (!me.isMaster) return <p className="text-muted-foreground">Apenas o mestre pode gerenciar habilidades.</p>;

  async function create() {
    const { error } = await supabase.from("abilities").insert({
      name: "Nova habilidade", description: "", is_passive: false, cooldown_turns: 1, mana_cost: 0, effects: [],
    });
    if (error) { toast.error(error.message); return; }
    toast.success("Habilidade criada");
    await qc.invalidateQueries({ queryKey: ["abilities"] });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl text-gold"><WandSparkles className="h-6 w-6" /> Habilidades</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Crie habilidades ativas com cooldown e custo de Mana, ou passivas que permanecem aplicadas enquanto estiverem na ficha.</p>
        </div>
        <Button onClick={() => void create()}><Plus className="mr-1 h-4 w-4" /> Nova habilidade</Button>
      </div>
      {!abilities.length && <p className="panel p-5 text-sm text-muted-foreground">Nenhuma habilidade cadastrada.</p>}
      {abilities.map((ability) => <AbilityEditor key={ability.id} ability={ability} defs={defs} />)}
    </div>
  );
}

function AbilityEditor({ ability, defs }: { ability: Ability; defs: NonNullable<ReturnType<typeof useDefs>["data"]> }) {
  const qc = useQueryClient();
  const [name, setName] = useState(ability.name);
  const [description, setDescription] = useState(ability.description ?? "");
  const [isPassive, setIsPassive] = useState(ability.is_passive);
  const [cooldown, setCooldown] = useState(String(ability.cooldown_turns));
  const [manaCost, setManaCost] = useState(String(ability.mana_cost));
  const [effects, setEffects] = useState<AbilityEffectDefinition[]>(() => parseAbilityEffects(ability.effects));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(ability.name);
    setDescription(ability.description ?? "");
    setIsPassive(ability.is_passive);
    setCooldown(String(ability.cooldown_turns));
    setManaCost(String(ability.mana_cost));
    setEffects(parseAbilityEffects(ability.effects));
  }, [ability]);

  async function save() {
    const cool = isPassive ? 0 : Math.floor(Number(cooldown));
    const mana = Math.floor(Number(manaCost));
    if (!name.trim()) { toast.error("Informe o nome da habilidade"); return; }
    if (!Number.isFinite(mana) || mana < 0) { toast.error("O custo de Mana não pode ser negativo"); return; }
    if (!isPassive && (!Number.isFinite(cool) || cool < 1)) {
      toast.error("Uma habilidade ativa precisa ter cooldown de pelo menos 1 turno. Marque como passiva se não puder ser ativada.");
      return;
    }
    if (effects.some((effect) => !effect.name.trim() || ((effect.effect_type === "status" || effect.effect_type === "regeneration") && (!Number.isFinite(effect.amount) || effect.amount < 0)))) {
      toast.error("Revise os nomes e valores dos efeitos");
      return;
    }
    setBusy(true);
    const { error } = await supabase.from("abilities").update({
      name: name.trim(),
      description: description.trim() || null,
      is_passive: isPassive,
      cooldown_turns: cool,
      mana_cost: isPassive ? 0 : mana,
      effects: effects.map((effect) => ({ ...effect, duration: isPassive ? 1 : Math.max(1, effect.duration) })) as unknown as Json,
    }).eq("id", ability.id);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Habilidade salva");
    await qc.invalidateQueries({ queryKey: ["abilities"] });
  }

  async function remove() {
    if (!confirm(`Excluir a habilidade "${ability.name}"? Ela também será removida das fichas que a possuem.`)) return;
    const { error } = await supabase.from("abilities").delete().eq("id", ability.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Habilidade excluída");
    await qc.invalidateQueries({ queryKey: ["abilities"] });
    await qc.invalidateQueries({ queryKey: ["character-abilities"] });
  }

  return (
    <section className="panel space-y-4 p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label>Nome da habilidade</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome da habilidade" />
        </div>
        <label className="flex min-h-10 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
          <input type="checkbox" checked={isPassive} onChange={(e) => { setIsPassive(e.target.checked); setCooldown(e.target.checked ? "0" : (Number(cooldown) > 0 ? cooldown : "1")); if (e.target.checked) setManaCost("0"); }} />
          Habilidade passiva
        </label>
      </div>
      <div className="space-y-1.5">
        <Label>Descrição</Label>
        <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="O que a habilidade faz..." />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {!isPassive && <div className="space-y-1.5"><Label>Cooldown (turnos)</Label><Input type="number" min="1" value={cooldown} onChange={(e) => setCooldown(e.target.value)} /></div>}
        {!isPassive && <div className="space-y-1.5">
          <Label>Custo de Mana (0 = não gasta)</Label>
          <Input type="number" min="0" value={manaCost} onChange={(e) => setManaCost(e.target.value)} />
        </div>}
        {isPassive && <p className="text-xs text-muted-foreground">Habilidade passiva: não tem botão de ativação, não gasta Mana e não entra em cooldown.</p>}
      </div>
      <AbilityEffectsEditor effects={effects} onChange={setEffects} isPassive={isPassive} defs={defs} />
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Button disabled={busy} onClick={() => void save()}>{busy ? "Salvando..." : "Salvar habilidade"}</Button>
        <Button disabled={busy} variant="destructive" onClick={() => void remove()}><Trash2 className="mr-1 h-4 w-4" /> Excluir</Button>
      </div>
    </section>
  );
}
