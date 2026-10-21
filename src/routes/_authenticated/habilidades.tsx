import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Trash2, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { parseAbilityEffects, useAbilities, type Ability, type AbilityEffectDefinition } from "@/lib/abilities";
import { CUSTOM_ABILITY_SCRIPTS } from "@/lib/custom-ability-scripts";
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
  const [search, setSearch] = useState("");
  const [pendingSaveIds, setPendingSaveIds] = useState<string[]>([]);

  if (!me || !abilities || !defs) return <p className="text-muted-foreground">Carregando…</p>;
  if (!me.isMaster) return <p className="text-muted-foreground">Apenas o mestre pode gerenciar habilidades.</p>;

  async function create() {
    const { data, error } = await supabase.from("abilities").insert({
      name: "Nova habilidade", description: "", is_passive: false, can_activate: true, is_magical: true, self_target_only: false, cooldown_turns: 1, mana_cost: 0, effects: [], passive_effects: [], end_effects: [], custom_script_key: null,
    }).select("id").single();
    if (error) { toast.error(error.message); return; }
    setSearch("");
    setPendingSaveIds((current) => [data.id, ...current.filter((id) => id !== data.id)]);
    toast.success("Nova habilidade criada. Ela ficará no topo até você salvar.");
    await qc.invalidateQueries({ queryKey: ["abilities"] });
  }

  const normalizedSearch = search.trim().toLocaleLowerCase("pt-BR");
  const visibleAbilities = abilities
    .filter((ability) => ability.name.toLocaleLowerCase("pt-BR").includes(normalizedSearch))
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl text-gold"><WandSparkles className="h-6 w-6" /> Habilidades</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Crie habilidades ativáveis com cooldown e custo de Mana e configure efeitos passivos separados, que permanecem aplicados enquanto a habilidade estiver na ficha.</p>
        </div>
        <Button onClick={() => void create()}><Plus className="mr-1 h-4 w-4" /> Nova habilidade</Button>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" aria-label="Pesquisar habilidades pelo nome" placeholder="Pesquisar habilidade pelo nome..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {!abilities.length && <p className="panel p-5 text-sm text-muted-foreground">Nenhuma habilidade cadastrada.</p>}
      {abilities.length > 0 && visibleAbilities.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma habilidade encontrada para “{search}”.</p>}
      {visibleAbilities.map((ability) => <AbilityEditor key={ability.id} ability={ability} defs={defs} isNew={pendingSaveIds.includes(ability.id)} onSaved={() => setPendingSaveIds((current) => current.filter((id) => id !== ability.id))} />)}
    </div>
  );
}

function AbilityEditor({ ability, defs, isNew, onSaved }: { ability: Ability; defs: NonNullable<ReturnType<typeof useDefs>["data"]>; isNew: boolean; onSaved: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(ability.name);
  const [description, setDescription] = useState(ability.description ?? "");
  const [customScriptKey, setCustomScriptKey] = useState(ability.custom_script_key ?? "");
  const [canActivate, setCanActivate] = useState(ability.can_activate);
  const [isMagical, setIsMagical] = useState(ability.is_magical);
  const [selfTargetOnly, setSelfTargetOnly] = useState(ability.self_target_only);
  const [cooldown, setCooldown] = useState(String(ability.cooldown_turns));
  const [manaCost, setManaCost] = useState(String(ability.mana_cost));
  const [effects, setEffects] = useState<AbilityEffectDefinition[]>(() => parseAbilityEffects(ability.effects));
  const [passiveEffects, setPassiveEffects] = useState<AbilityEffectDefinition[]>(() => parseAbilityEffects(ability.passive_effects));
  const [endEffects, setEndEffects] = useState<AbilityEffectDefinition[]>(() => parseAbilityEffects(ability.end_effects));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(ability.name);
    setDescription(ability.description ?? "");
    setCustomScriptKey(ability.custom_script_key ?? "");
    setCanActivate(ability.can_activate);
    setIsMagical(ability.is_magical);
    setSelfTargetOnly(ability.self_target_only);
    setCooldown(String(ability.cooldown_turns));
    setManaCost(String(ability.mana_cost));
    setEffects(parseAbilityEffects(ability.effects));
    setPassiveEffects(parseAbilityEffects(ability.passive_effects));
    setEndEffects(parseAbilityEffects(ability.end_effects));
  }, [ability]);

  async function save() {
    const cool = canActivate ? Math.floor(Number(cooldown)) : 0;
    const mana = Math.floor(Number(manaCost));
    if (!name.trim()) { toast.error("Informe o nome da habilidade"); return; }
    if (!Number.isFinite(mana) || mana < 0) { toast.error("O custo de Mana não pode ser negativo"); return; }
    if (canActivate && (!Number.isFinite(cool) || cool < 1)) {
      toast.error("Uma habilidade ativável precisa ter cooldown de pelo menos 1 turno. Marque como não ativável se não puder ser usada.");
      return;
    }
    const canTriggerEndEffects = effects.some((effect) =>
      effect.effect_type !== "healing" || effect.healing_timing === "per_turn"
    );
    if (canActivate && endEffects.length > 0 && !canTriggerEndEffects) {
      toast.error("Efeitos de encerramento precisam de pelo menos um efeito ativo com duração. Uma cura instantânea sozinha não tem duração para encerrar.");
      return;
    }
    const allConfiguredEffects = [...effects, ...passiveEffects, ...endEffects];
    const hasInvalidHealing = allConfiguredEffects.some((effect) =>
      effect.effect_type === "healing" &&
      !effect.healing_hp_enabled &&
      !effect.healing_mana_enabled &&
      !effect.healing_body_enabled &&
      !effect.healing_sanity_enabled &&
      !effect.healing_remove_debuffs &&
      !(effect.healing_reduce_debuff_turns_fixed && effect.healing_reduce_debuff_turns_fixed > 0) &&
      !(effect.healing_reduce_debuff_turns_percent && effect.healing_reduce_debuff_turns_percent > 0)
    );
    if (hasInvalidHealing) {
      toast.error("Configure pelo menos uma ação em cada efeito de cura.");
      return;
    }
    if (allConfiguredEffects.some((effect) => !effect.name.trim() || (
      ["status", "regeneration", "mana_regeneration", "mana_used", "damage_dealt"].includes(effect.effect_type) &&
      (!Number.isFinite(effect.amount) || effect.amount < 0)
    ))) {
      toast.error("Revise os nomes e valores dos efeitos ativos e passivos");
      return;
    }
    setBusy(true);
    const { error } = await supabase.from("abilities").update({
      name: name.trim(),
      description: description.trim() || null,
      custom_script_key: customScriptKey || null,
      can_activate: canActivate,
      is_magical: isMagical,
      self_target_only: canActivate && selfTargetOnly,
      is_passive: !canActivate,
      cooldown_turns: cool,
      mana_cost: canActivate ? mana : 0,
      effects: effects.map((effect) => ({ ...effect, duration: Math.max(1, effect.duration) })) as unknown as Json,
      passive_effects: passiveEffects.map((effect) => ({ ...effect, duration: 1 })) as unknown as Json,
      end_effects: endEffects.map((effect) => ({ ...effect, duration: Math.max(1, effect.duration) })) as unknown as Json,
    }).eq("id", ability.id);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Habilidade salva");
    await qc.invalidateQueries({ queryKey: ["abilities"] });
    onSaved();
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
      {isNew && <p className="text-xs font-semibold text-amber-500">Nova habilidade — salve para confirmar as alterações.</p>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label>Nome da habilidade</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome da habilidade" />
        </div>
        <label className="flex min-h-10 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
          <input type="checkbox" checked={!canActivate} onChange={(e) => {
            const notActivatable = e.target.checked;
            setCanActivate(!notActivatable);
            setCooldown(notActivatable ? "0" : (Number(cooldown) > 0 ? cooldown : "1"));
            if (notActivatable) setManaCost("0");
          }} />
          Habilidade não ativável
        </label>
        <label className="flex min-h-10 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
          <input type="checkbox" checked={isMagical} onChange={(e) => setIsMagical(e.target.checked)} />
          Habilidade Mágica
        </label>
        {canActivate && (
          <label className="flex min-h-10 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
            <input type="checkbox" checked={selfTargetOnly} onChange={(e) => setSelfTargetOnly(e.target.checked)} />
            Só pode ser usada no próprio personagem
          </label>
        )}
      </div>
      <div className="space-y-1.5">
        <Label>Descrição</Label>
        <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="O que a habilidade faz..." />
      </div>
      <div className="space-y-1.5 rounded-md border border-border p-3">
        <Label>Script JavaScript personalizado</Label>
        <select
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={customScriptKey}
          onChange={(e) => setCustomScriptKey(e.target.value)}
        >
          <option value="">Nenhum script personalizado</option>
          {CUSTOM_ABILITY_SCRIPTS.map((script) => (
            <option key={script.key} value={script.key}>{script.label}</option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          Os scripts são executados no servidor quando os eventos da habilidade acontecem. Para adicionar um script, crie o arquivo na pasta supabase/functions/ability-runtime/scripts e registre a chave no registry e nesta lista.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {canActivate && <div className="space-y-1.5"><Label>Cooldown (turnos)</Label><Input type="number" min="1" value={cooldown} onChange={(e) => setCooldown(e.target.value)} /></div>}
        {canActivate && <div className="space-y-1.5">
          <Label>Custo de Mana (0 = não gasta)</Label>
          <Input type="number" min="0" value={manaCost} onChange={(e) => setManaCost(e.target.value)} />
        </div>}
        {!canActivate && <p className="text-xs text-muted-foreground">Esta habilidade não pode ser ativada. Seus efeitos passivos permanecem aplicados enquanto estiver na ficha.</p>}
      </div>
      {canActivate && <AbilityEffectsEditor
        effects={effects}
        onChange={setEffects}
        permanent={false}
        title="Efeitos ao ativar"
        description="Aplicados ao alvo escolhido quando a habilidade for ativada."
        defs={defs}
      />}
      {canActivate && <AbilityEffectsEditor
        effects={endEffects}
        onChange={setEndEffects}
        permanent={false}
        title="Efeitos quando a habilidade acaba"
        description="Aplicados ao destino configurado quando todos os efeitos desta ativação terminarem."
        defs={defs}
        allowPeriodicHealing={false}
      />}
      <AbilityEffectsEditor
        effects={passiveEffects}
        onChange={setPassiveEffects}
        permanent
        title="Efeitos passivos"
        description="Aplicados continuamente a quem tiver esta habilidade na ficha."
        defs={defs}
        allowHealing={false}
      />
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Button disabled={busy} onClick={() => void save()}>{busy ? "Salvando..." : isNew ? "Salvar nova habilidade" : "Salvar habilidade"}</Button>
        <Button disabled={busy} variant="destructive" onClick={() => void remove()}><Trash2 className="mr-1 h-4 w-4" /> Excluir</Button>
      </div>
    </section>
  );
}
