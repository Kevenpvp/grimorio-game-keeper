import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { classMods, useDefs, useMe, useClasses, useVirtues, type AttributeDef, type ClassTrait } from "@/lib/sheets";
import { parseAbilityEffects, useAbilities, type AbilityEffectDefinition } from "@/lib/abilities";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import { TRAIT_STARTING_EFFECT_TYPES } from "@/lib/trait-starting-effect-types";
import { TransformationGrantPicker } from "@/components/transformations/TransformationGrantPicker";
import type { Json } from "@/integrations/supabase/types";

export const Route = createFileRoute("/_authenticated/classes")({
  head: () => ({
    meta: [
      { title: "Classes — Grimório" },
      { name: "description", content: "Configure as classes e seus modificadores." },
      { property: "og:title", content: "Classes — Grimório" },
      { property: "og:description", content: "Configure as classes e seus modificadores." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ClassesPage,
});

function ClassesPage() {
  const { data: me } = useMe();
  const { data: classes } = useClasses();
  const { data: defs } = useDefs();
  const qc = useQueryClient();
  const db = supabase as any;
  const [search, setSearch] = useState("");
  const [pendingSaveIds, setPendingSaveIds] = useState<string[]>([]);
  if (!me || !classes || !defs) return <p className="text-muted-foreground">Carregando…</p>;
  if (!me.isMaster) return <p className="text-muted-foreground">Apenas o mestre gerencia classes.</p>;

  async function create() {
    const { data, error } = await db.from("classes").insert({ name: "Nova classe" }).select("id").single();
    if (error) { toast.error(error.message); return; }
    setSearch("");
    setPendingSaveIds((current) => [data.id, ...current.filter((id) => id !== data.id)]);
    toast.success("Nova classe criada. Ela ficará no topo até você salvar.");
    await qc.invalidateQueries({ queryKey: ["classes"] });
  }

  const normalizedSearch = search.trim().toLocaleLowerCase("pt-BR");
  const visibleClasses = classes
    .filter((classTrait) => classTrait.name.toLocaleLowerCase("pt-BR").includes(normalizedSearch))
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
      <div className="grimorio-section-header flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-gold">Classes</h1>
        <Button onClick={create}><Plus className="mr-1 h-4 w-4" /> Nova classe</Button>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" aria-label="Pesquisar classes pelo nome" placeholder="Pesquisar classe pelo nome..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {!classes.length && <p className="text-muted-foreground">Nenhuma classe ainda.</p>}
      {classes.length > 0 && visibleClasses.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma classe encontrada para “{search}”.</p>}
      {visibleClasses.map((r) => <ClassEditor key={r.id} classTrait={r} defs={defs} isNew={pendingSaveIds.includes(r.id)} onSaved={() => setPendingSaveIds((current) => current.filter((id) => id !== r.id))} />)}
    </div>
  );
}

function ClassEditor({ classTrait, defs, isNew, onSaved }: { classTrait: ClassTrait; defs: AttributeDef[]; isNew: boolean; onSaved: () => void }) {
  const qc = useQueryClient();
  const db = supabase as any;
  const { data: virtues = [], isLoading: virtuesLoading } = useVirtues();
  const [name, setName] = useState(classTrait.name);
  const [description, setDescription] = useState(classTrait.description ?? "");
  const [bonus, setBonus] = useState(classTrait.bonus_points);
  const [physicalBonus, setPhysicalBonus] = useState(classTrait.physical_bonus_points);
  const existingMechanics = ((classTrait as unknown as { special_mechanics?: Record<string, unknown> }).special_mechanics ?? {});
  const [duplicateVirtueEffects, setDuplicateVirtueEffects] = useState(existingMechanics.duplicate_virtue_effects === true);
  const [virtueCooldownReductionPercent, setVirtueCooldownReductionPercent] = useState(Math.max(0, Math.min(100, Number(existingMechanics.virtue_cooldown_reduction_percent ?? 0))));
  const [virtueEffectMultiplier, setVirtueEffectMultiplier] = useState(Number(existingMechanics.virtue_effect_multiplier ?? 2));
  const [virtueEffectBlacklist, setVirtueEffectBlacklist] = useState<string[]>(
    Array.isArray(existingMechanics.virtue_effect_blacklist)
      ? existingMechanics.virtue_effect_blacklist.filter((id): id is string => typeof id === "string")
      : [],
  );
  const [mods, setMods] = useState(classMods(classTrait));
  const [startingEffects, setStartingEffects] = useState<AbilityEffectDefinition[]>(() => parseAbilityEffects(classTrait.starting_effects));
  const { data: allAbilities = [], isLoading: catalogLoading } = useAbilities();
  const { data: classTraitAbilityRows = [], isLoading: classTraitAbilitiesLoading, error: classTraitAbilitiesError } = useQuery({
    queryKey: ["class-abilities"],
    queryFn: async () => {
      const { data, error } = await db.from("class_abilities").select("class_id,ability_id");
      if (error) throw error;
      return data ?? [];
    },
  });
  const selectedAbilityIds = new Set(classTraitAbilityRows.filter((row) => row.class_id === classTrait.id).map((row) => row.ability_id));

  async function toggleAbility(abilityId: string, checked: boolean) {
    const result = checked
      ? await db.from("class_abilities").insert({ class_id: classTrait.id, ability_id: abilityId })
      : await db.from("class_abilities").delete().eq("class_id", classTrait.id).eq("ability_id", abilityId);
    if (result.error) { toast.error(result.error.message); return; }
    toast.success(checked ? "Habilidade vinculada à classe" : "Habilidade removida da classe");
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["class-abilities"] }),
      qc.invalidateQueries({ queryKey: ["character-abilities"] }),
      qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
    ]);
  }

  async function save() {
    if (!name.trim()) { toast.error("Informe o nome"); return; }
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(mods)) {
      const rounded = Math.round(v);
      const normalized = k === "body" || k === "sanity" ? Math.max(-100, Math.min(0, rounded)) : rounded;
      if (normalized) clean[k] = normalized;
    }
    const { error } = await db.from("classes").update({
      name: name.trim(), description: description.trim() || null,
      bonus_points: Math.max(0, Math.round(bonus) || 0),
      physical_bonus_points: Math.max(0, Math.round(physicalBonus) || 0),
      modifiers: clean,
      special_mechanics: {
        duplicate_virtue_effects: duplicateVirtueEffects,
        virtue_cooldown_reduction_percent: Math.max(0, Math.min(100, Number(virtueCooldownReductionPercent) || 0)),
        virtue_effect_multiplier: Math.max(1, Math.min(10, Number(virtueEffectMultiplier) || 2)),
        virtue_effect_blacklist: virtueEffectBlacklist,
      } as unknown as Json,
      starting_effects: startingEffects.map((effect) => ({
        ...effect,
        duration: 1,
        until_combat_end: false,
        target_scope: "caster",
        apply_both_on_activation: false,
      })) as unknown as Json,
    }).eq("id", classTrait.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Classe salva");
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["classes"] }),
      qc.invalidateQueries({ queryKey: ["class-abilities"] }),
      qc.invalidateQueries({ queryKey: ["character"] }),
      qc.invalidateQueries({ queryKey: ["characters"] }),
      qc.invalidateQueries({ queryKey: ["my-character"] }),
      qc.invalidateQueries({ queryKey: ["character-abilities"] }),
      qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
    ]);
    onSaved();
  }

  async function remove() {
    if (!confirm(`Excluir a classe ${classTrait.name}? Fichas com ela ficam sem classe.`)) return;
    const { error } = await db.from("classes").delete().eq("id", classTrait.id);
    if (error) { toast.error(error.message); return; }
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["classes"] }),
      qc.invalidateQueries({ queryKey: ["class-abilities"] }),
      qc.invalidateQueries({ queryKey: ["character"] }),
      qc.invalidateQueries({ queryKey: ["characters"] }),
      qc.invalidateQueries({ queryKey: ["my-character"] }),
    ]);
  }

  return (
    <section className="panel space-y-4 p-5">
      {isNew && <p className="text-xs font-semibold text-amber-500">Nova classe — salve para confirmar as alterações.</p>}
      <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
        <div className="space-y-1.5"><Label>Nome</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>Pontos livres extras</Label>
          <Input type="number" min={0} value={bonus} onChange={(e) => setBonus(Number(e.target.value))} /></div>
        <div className="space-y-1.5"><Label>Pontos extras de atributos físicos</Label><Input type="number" min={0} value={physicalBonus} onChange={(e) => setPhysicalBonus(Number(e.target.value))} /></div>
        <div className="space-y-1.5 sm:col-span-2"><Label>Descrição</Label>
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      </div>
      <div className="space-y-3">
        <div>
          <Label className="text-muted-foreground">Modificadores iniciais de Corpo e Sanidade</Label>
          <p className="mt-1 text-xs text-muted-foreground">Use valores negativos para começar abaixo de 100%. Ex.: -10 faz o personagem começar com 90%. Ao mudar a classe, a diferença é ajustada sem zerar o dano já sofrido.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {([{ key: "body", label: "Corpo inicial" }, { key: "sanity", label: "Sanidade inicial" }] as const).map((item) => (
            <div key={item.key} className="space-y-1">
              <Label>{item.label} (%)</Label>
              <Input type="number" min={-100} max={0} step={1} className="tabular" value={mods[item.key] ?? 0}
                onChange={(e) => setMods({ ...mods, [item.key]: Math.max(-100, Math.min(0, Number(e.target.value) || 0)) })} />
            </div>
          ))}
        </div>
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
      <div className="space-y-3 rounded-md border border-violet-500/30 bg-violet-500/5 p-3">
        <div>
          <h3 className="text-sm font-semibold text-gold">Mecânicas especiais da classe</h3>
          <p className="mt-1 text-xs text-muted-foreground">Regras reutilizáveis, configuradas sem escrever código. Desative para não alterar as virtudes dos personagens desta classe.</p>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={duplicateVirtueEffects} onChange={(event) => setDuplicateVirtueEffects(event.target.checked)} />
          <span><span className="font-medium">Duplicar efeitos da virtude</span><span className="mt-1 block text-xs text-muted-foreground">Multiplica valores numéricos dos efeitos das habilidades concedidas pela virtude (incluindo passivas), sem duplicar duração, recarga, custo de Mana ou efeitos binários como Invencível.</span></span>
        </label>
        <div className="max-w-xs space-y-1">
          <Label>Reduzir recarga das habilidades da virtude (%)</Label>
          <Input type="number" min={0} max={100} value={virtueCooldownReductionPercent} onChange={(event) => setVirtueCooldownReductionPercent(Math.max(0, Math.min(100, Number(event.target.value) || 0)))} />
          <p className="text-xs text-muted-foreground">Afeta as habilidades concedidas por virtudes: 25% transforma 8 turnos em 6. Não altera habilidades próprias da ficha.</p>
        </div>
        {duplicateVirtueEffects && <>
          <div className="max-w-xs space-y-1">
            <Label>Multiplicador dos efeitos</Label>
            <Input type="number" min={1} max={10} step={0.5} value={virtueEffectMultiplier} onChange={(event) => setVirtueEffectMultiplier(Math.max(1, Math.min(10, Number(event.target.value) || 1)))} />
            <p className="text-xs text-muted-foreground">Ex.: 2 = dobro; 3 = triplo. Limite de 10x.</p>
          </div>
          <div className="space-y-2 border-t border-border/70 pt-3">
            <div>
              <Label>Virtudes excluídas do multiplicador e da redução de recarga</Label>
              <p className="mt-1 text-xs text-muted-foreground">As virtudes marcadas continuam funcionando normalmente, mas seus efeitos e atributos personalizados não são multiplicados por esta classe. Você pode marcar mais de uma.</p>
            </div>
            {virtuesLoading ? (
              <p className="text-xs text-muted-foreground">Carregando virtudes…</p>
            ) : virtues.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhuma virtude cadastrada.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {virtues.map((virtue) => {
                  const excluded = virtueEffectBlacklist.includes(virtue.id);
                  return (
                    <label key={virtue.id} className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${excluded ? "border-amber-500/50 bg-amber-500/5" : "border-border"}`}>
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={excluded}
                        onChange={(event) => setVirtueEffectBlacklist((current) =>
                          event.target.checked
                            ? [...new Set([...current, virtue.id])]
                            : current.filter((id) => id !== virtue.id)
                        )}
                      />
                      <span>
                        <span className="block font-medium">{virtue.name}</span>
                        <span className="block text-xs text-muted-foreground">{excluded ? "Sem multiplicador da classe" : "Recebe o multiplicador da classe"}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            <p className="text-xs text-muted-foreground">A exclusão afeta somente esta mecânica da classe; não remove a virtude nem suas habilidades da ficha.</p>
          </div>
        </>}
      </div>
      <div className="space-y-3 rounded-md border border-border p-3">
        <div>
          <h3 className="text-sm font-semibold text-gold">Habilidades concedidas por esta classe</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Os personagens recebem automaticamente as habilidades marcadas quando escolhem esta classe.
            Ao trocar ou remover a classe, apenas as habilidades concedidas por ela são retiradas; habilidades
            atribuídas manualmente e habilidades que ainda sejam concedidas pela virtude são preservadas.
          </p>
        </div>
        {classTraitAbilitiesError ? (
          <p className="text-xs text-amber-500">A tabela de habilidades de classe ainda não está disponível neste backend. A migração 0046 precisa ser aplicada para ativar esta opção.</p>
        ) : catalogLoading || classTraitAbilitiesLoading ? (
          <p className="text-xs text-muted-foreground">Carregando habilidades…</p>
        ) : allAbilities.length === 0 ? (
          <p className="text-xs text-muted-foreground">Cadastre habilidades no catálogo para poder vinculá-las a esta classe.</p>
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
      <TransformationGrantPicker scope="class" traitId={classTrait.id} />
      <div className="rounded-md border border-border p-3">
        <AbilityEffectsEditor
          effects={startingEffects}
          onChange={setStartingEffects}
          permanent
          title="Buffs e debuffs iniciais da classe"
          description="Estes efeitos ficam ativos enquanto o personagem mantiver esta classe. Eles não perdem duração ao avançar turnos e são removidos ao trocar ou remover a classe."
          defs={defs}
          allowHealing={false}
          allowPeriodicHealing={false}
          permanentNote="Efeito permanente enquanto o personagem mantiver esta classe."
          allowedTypes={TRAIT_STARTING_EFFECT_TYPES}
          allowPermanentMagicProhibition
        />
      </div>
      <div className="flex gap-2">
        <Button onClick={save}>{isNew ? "Salvar nova classe" : "Salvar"}</Button>
        <Button variant="destructive" onClick={remove}><Trash2 className="mr-1 h-4 w-4" /> Excluir</Button>
      </div>
    </section>
  );
}
