import type { Dispatch, SetStateAction } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import { DefenseIgnoreInputs } from "@/components/abilities/DefenseIgnoreInputs";
import { AbilityAttackExecutionEditor } from "@/components/abilities/AbilityAttackExecutionEditor";
import { AbilityAttackOnHitHealingEditor } from "@/components/abilities/AbilityAttackOnHitHealingEditor";
import { ZERO_DEFENSE_IGNORE } from "@/lib/defense-ignore";
import { useDamageTypes, useDotTemplates, type AbilityDotEffect, type AbilityAttackEffectGroup, type AbilityAttackDamageConfig, type AbilityAttackDamageKind } from "@/lib/abilities";
import type { useDefs } from "@/lib/sheets";
import { applyRegisteredDotTemplate, findRegisteredDotTemplate } from "@/lib/ability-dot-templates";

/** Shared catalog-grade attack configuration editor for character-exclusive abilities. */

type DotDamageTypeOption = { id: string; name: string };
type DotAttributeOption = { key: string; label: string };

/**
 * Shared by catalog abilities, exclusive sheet abilities, and the temporary
 * per-target battle editor. Registered DoT name/type are read-only.
 */
export function AbilityDotEffectsEditor({
  dots, onChange, defs, physicalTypes, magicalTypes, title, description,
}: {
  dots: AbilityDotEffect[];
  onChange: (next: AbilityDotEffect[]) => void;
  defs: DotAttributeOption[];
  physicalTypes: DotDamageTypeOption[];
  magicalTypes: DotDamageTypeOption[];
  title: string;
  description: string;
}) {
  const { data: templates = [], isLoading } = useDotTemplates();

  function update(dotId: string, patch: Partial<AbilityDotEffect>) {
    onChange(dots.map((dot) => dot.id === dotId ? { ...dot, ...patch } : dot));
  }

  function addRegisteredDot() {
    const template = templates[0];
    if (!template) return;
    const dot: AbilityDotEffect = {
      id: crypto.randomUUID(), template_id: null, name: template.name,
      damage_kind: template.damage_kind, physical_damage_type_id: null,
      damage_type_id: null, magic_level: null,
      damage_mode: "fixed", damage_amount: 10,
      attribute_key: null, attribute_percent: 100, fixed_damage: 0, duration: 3,
    };
    onChange([...dots, applyRegisteredDotTemplate(dot, template)]);
  }

  return (
    <section className="space-y-3 rounded-md border border-orange-500/25 bg-orange-500/[0.03] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-gold">{title}</h4>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Escolha um DoT registrado na página DoTs. O nome e o tipo de dano vêm desse cadastro;
            aqui você configura apenas o dano e sua duração.
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={!templates.length || isLoading}
          onClick={addRegisteredDot}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Adicionar DoT registrado
        </Button>
      </div>
      {!templates.length && <p className="text-xs text-amber-400">
        {isLoading ? "Carregando DoTs registrados..." : "Nenhum DoT cadastrado. Crie o modelo primeiro na página DoTs."}
      </p>}
      {!dots.length && <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">Nenhum DoT configurado.</p>}
      {dots.map((dot) => {
        const template = findRegisteredDotTemplate(dot, templates);
        const typeName = template?.damage_kind === "physical"
          ? physicalTypes.find((type) => type.id === template.physical_damage_type_id)?.name ?? "Tipo físico"
          : magicalTypes.find((type) => type.id === template?.damage_type_id)?.name ?? "Tipo mágico";
        return (
          <article key={dot.id} className="space-y-3 rounded-md border border-border bg-background/50 p-3">
            <div className="flex items-start gap-2">
              <label className="min-w-0 flex-1 space-y-1 text-xs font-medium">
                DoT cadastrado
                <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={template?.id ?? ""}
                  onChange={(event) => {
                    const chosen = templates.find((item) => item.id === event.target.value);
                    if (chosen) onChange(dots.map((item) => item.id === dot.id
                      ? applyRegisteredDotTemplate(item, chosen) : item));
                  }}>
                  {!template && <option value="">Selecione um DoT registrado</option>}
                  {templates.map((entry) => (
                    <option key={entry.id} value={entry.id}>{entry.name}</option>
                  ))}
                </select>
              </label>
              <Button type="button" size="icon" variant="ghost" className="mt-5 shrink-0 text-destructive"
                aria-label={"Remover DoT " + dot.name}
                onClick={() => onChange(dots.filter((entry) => entry.id !== dot.id))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            {template ? (
              <p className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                {template.damage_kind === "physical" ? "Físico" : "Mágico"} · {typeName}
                {template.damage_kind === "magical" ? ` · grau ${template.magic_level ?? "baixa"}` : ""}
                <span className="ml-2 text-emerald-500">Definido no cadastro de DoTs</span>
              </p>
            ) : (
              <p className="text-xs text-destructive">
                O DoT "{dot.name}" não possui um modelo registrado correspondente. Selecione um modelo acima antes de salvar.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs font-medium">
                Cálculo do dano por turno
                <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={dot.damage_mode}
                  onChange={(event) => update(dot.id, { damage_mode: event.target.value as AbilityDotEffect["damage_mode"] })}>
                  <option value="fixed">Dano fixo</option>
                  <option value="percent">% do HP máximo do alvo</option>
                  <option value="attribute">Baseado em um atributo do lançador</option>
                </select>
              </label>
              {dot.damage_mode !== "attribute" ? (
                <label className="space-y-1 text-xs font-medium">
                  {dot.damage_mode === "percent" ? "Percentual por turno (%)" : "Dano bruto por turno"}
                  <Input type="number" min={dot.damage_mode === "percent" ? 0.1 : 1}
                    max={dot.damage_mode === "percent" ? 1000 : 1000000}
                    step={dot.damage_mode === "percent" ? "any" : "1"}
                    value={dot.damage_amount}
                    onChange={(event) => update(dot.id, { damage_amount: Number(event.target.value) || 0 })} />
                </label>
              ) : (
                <>
                  <label className="space-y-1 text-xs font-medium">
                    Atributo do lançador
                    <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={dot.attribute_key ?? ""}
                      onChange={(event) => update(dot.id, { attribute_key: event.target.value || null })}>
                      <option value="">Selecione um atributo</option>
                      {defs.filter((def) => !["hp", "mana"].includes(def.key)).map((def) => (
                        <option key={def.key} value={def.key}>{def.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs font-medium">
                    Percentual do atributo (%)
                    <Input type="number" min={0} max={1000} step="any"
                      value={dot.attribute_percent}
                      onChange={(event) => update(dot.id, { attribute_percent: Math.max(0, Math.min(1000, Number(event.target.value) || 0)) })} />
                  </label>
                  <label className="space-y-1 text-xs font-medium">
                    Dano fixo adicional
                    <Input type="number" min={0} max={1000000} step="1"
                      value={dot.fixed_damage}
                      onChange={(event) => update(dot.id, { fixed_damage: Math.max(0, Math.min(1000000, Number(event.target.value) || 0)) })} />
                  </label>
                </>
              )}
              <label className="space-y-1 text-xs font-medium">
                Duração (turnos do alvo)
                <Input type="number" min={1} max={1000} step={1}
                  value={dot.duration}
                  onChange={(event) => update(dot.id, { duration: Math.max(1, Math.min(1000, Math.floor(Number(event.target.value) || 1))) })} />
              </label>
            </div>
            {dot.damage_mode === "attribute" && <p className="text-xs text-muted-foreground">
              O dano fica registrado quando a habilidade é usada e utiliza o atributo do lançador.
            </p>}
            {dot.damage_mode === "percent" && <p className="text-xs text-muted-foreground">
              O percentual é calculado sobre o HP máximo do alvo a cada turno.
            </p>}
          </article>
        );
      })}
    </section>
  );
}

export function SheetAbilityAttackEditor({
  defs, canActivate, toggleMode, selfTargetOnly,
  attackEnabled, setAttackEnabled, attackDamage, setAttackDamage,
  attackEffectGroups, setAttackEffectGroups, dotEffects, setDotEffects,
}: {
  defs: NonNullable<ReturnType<typeof useDefs>["data"]>;
  canActivate: boolean;
  toggleMode: boolean;
  selfTargetOnly: boolean;
  attackEnabled: boolean;
  setAttackEnabled: Dispatch<SetStateAction<boolean>>;
  attackDamage: AbilityAttackDamageConfig;
  setAttackDamage: Dispatch<SetStateAction<AbilityAttackDamageConfig>>;
  attackEffectGroups: AbilityAttackEffectGroup[];
  setAttackEffectGroups: Dispatch<SetStateAction<AbilityAttackEffectGroup[]>>;
  dotEffects: AbilityDotEffect[];
  setDotEffects: Dispatch<SetStateAction<AbilityDotEffect[]>>;
}) {
  const { data: damageTypes = [] } = useDamageTypes();
  const physicalDamageTypes = damageTypes.filter((item) => item.category === "physical");
  const magicalDamageTypes = damageTypes.filter((item) => item.category === "magical");
  return (
    <div className="space-y-3">
      <section className="space-y-3 rounded-md border border-violet-500/30 bg-violet-500/5 p-3">
        <div>
          <h3 className="text-sm font-semibold text-gold">Ataque da habilidade</h3>
          <p className="mt-1 text-xs text-muted-foreground">Permite usar o botão Atacar no combate, selecionar vários alvos, mostrar os dados para lançar/esquivar e aplicar dano pela regra normal de defesas e mitigação.</p>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={attackEnabled}
            disabled={!canActivate || selfTargetOnly || toggleMode}
            onChange={(event) => setAttackEnabled(event.target.checked)}
          />
          <span>
            <span className="font-medium">Habilidade pode Atacar</span>
            <span className="mt-1 block text-xs text-muted-foreground">O botão Ativar continua existindo separadamente. Ataques com esta habilidade consomem o custo de Mana/cooldown uma vez, mesmo que todos os alvos esquivem.</span>
          </span>
        </label>
        {(!canActivate || selfTargetOnly || toggleMode) && <p className="text-xs text-amber-500">Para habilitar Atacar, a habilidade precisa ser ativável e não pode estar limitada ao próprio personagem.</p>}
        {attackEnabled && canActivate && !selfTargetOnly && !toggleMode && (
          <div className="space-y-3 border-t border-border/70 pt-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs font-medium">
                Tipo de dano
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={attackDamage.damage_kind}
                  onChange={(event) => setAttackDamage((current) => ({ ...current, damage_kind: event.target.value as AbilityAttackDamageKind }))}
                >
                  <option value="physical">Físico</option>
                  <option value="magical">Mágico</option>
                  <option value="hybrid">Híbrido (físico + mágico)</option>
                  <option value="true">Verdadeiro (ignora defesas)</option>
                </select>
              </label>
              <label className="space-y-1 text-xs font-medium">
                Atributo usado para calcular o dano
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={attackDamage.attribute_key ?? ""}
                  onChange={(event) => setAttackDamage((current) => ({
                    ...current,
                    attribute_key: event.target.value || null,
                    additional_attributes: (current.additional_attributes ?? []).filter((source) => source.attribute_key !== event.target.value),
                  }))}
                >
                  <option value="">Nenhum — dano fixo</option>
                  {defs.map((def) => <option key={def.key} value={def.key}>{def.label}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-xs font-medium">
                Percentual do atributo
                <div className="flex items-center gap-2">
                  <Input type="number" min={0} max={1000} step={5} value={attackDamage.attribute_percent}
                    disabled={!attackDamage.attribute_key}
                    onChange={(event) => setAttackDamage((current) => ({ ...current, attribute_percent: Math.max(0, Math.min(1000, Number(event.target.value) || 0)) }))} />
                  <span className="text-muted-foreground">%</span>
                </div>
              </label>
              <label className="space-y-1 text-xs font-medium">
                Dano fixo adicional
                <Input type="number" min={0} max={1000000} value={attackDamage.fixed_damage}
                  onChange={(event) => setAttackDamage((current) => ({ ...current, fixed_damage: Math.max(0, Math.min(1000000, Number(event.target.value) || 0)) }))} />
              </label>
              {attackDamage.damage_kind === "hybrid" && (
                <div className="space-y-3 rounded-xl border border-gold/25 bg-gold/5 p-3 sm:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-semibold text-gold">Fontes adicionais de dano</h4>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Combine atributos no golpe híbrido. Exemplo: 100% de Dano Mágico + 100% de Força + dano fixo.
                      </p>
                    </div>
                    <Button type="button" size="sm" variant="outline" className="min-h-10"
                      disabled={(attackDamage.additional_attributes ?? []).length >= 8 ||
                        !defs.some((def) => def.key !== attackDamage.attribute_key &&
                          !(attackDamage.additional_attributes ?? []).some((source) => source.attribute_key === def.key))}
                      onClick={() => setAttackDamage((current) => {
                        const extras = current.additional_attributes ?? [];
                        const nextKey = defs.find((def) => def.key !== current.attribute_key &&
                          !extras.some((source) => source.attribute_key === def.key))?.key;
                        return nextKey ? { ...current, additional_attributes: [...extras, { attribute_key: nextKey, attribute_percent: 100 }] } : current;
                      })}>
                      <Plus className="mr-1.5 h-4 w-4" /> Adicionar atributo
                    </Button>
                  </div>
                  {(attackDamage.additional_attributes ?? []).length === 0 && (
                    <p className="text-xs text-muted-foreground">Nenhuma fonte extra. O ataque usará apenas o atributo principal e o dano fixo.</p>
                  )}
                  {(attackDamage.additional_attributes ?? []).map((source, index) => (
                    <div key={index} className="grid min-w-0 gap-2 rounded-lg border border-border/75 bg-background/40 p-2 sm:grid-cols-[minmax(0,1fr)_130px_auto] sm:items-end">
                      <label className="min-w-0 space-y-1 text-xs font-medium">
                        Atributo adicional {index + 1}
                        <select className="min-h-10 w-full rounded-md border border-input bg-background px-2 text-sm"
                          value={source.attribute_key}
                          onChange={(event) => setAttackDamage((current) => ({
                            ...current,
                            additional_attributes: (current.additional_attributes ?? []).map((item, i) =>
                              i === index ? { ...item, attribute_key: event.target.value } : item),
                          }))}>
                          {defs.filter((def) => def.key === source.attribute_key ||
                            (def.key !== attackDamage.attribute_key &&
                              !(attackDamage.additional_attributes ?? []).some((other, i) => i !== index && other.attribute_key === def.key)))
                            .map((def) => <option key={def.key} value={def.key}>{def.label}</option>)}
                        </select>
                      </label>
                      <label className="space-y-1 text-xs font-medium">
                        Percentual (%)
                        <Input type="number" min={0} max={1000} step={5} value={source.attribute_percent}
                          onChange={(event) => setAttackDamage((current) => ({
                            ...current,
                            additional_attributes: (current.additional_attributes ?? []).map((item, i) =>
                              i === index ? { ...item, attribute_percent: Math.max(0, Math.min(1000, Number(event.target.value) || 0)) } : item),
                          }))} />
                      </label>
                      <Button type="button" variant="outline" size="sm" className="min-h-10 border-red-500/25 text-red-300"
                        onClick={() => setAttackDamage((current) => ({
                          ...current,
                          additional_attributes: (current.additional_attributes ?? []).filter((_, i) => i !== index),
                        }))}>
                        <Trash2 className="mr-1.5 h-4 w-4" /> Remover
                      </Button>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">As fontes são somadas no dano base. O golpe continua sendo híbrido e passa uma única vez pela defesa e mitigação.</p>
                </div>
              )}
              {(attackDamage.damage_kind === "physical" || attackDamage.damage_kind === "hybrid") && (
                <label className="space-y-1 text-xs font-medium">
                  Tipo de dano físico
                  <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={attackDamage.physical_damage_type_id ?? ""}
                    onChange={(event) => setAttackDamage((current) => ({ ...current, physical_damage_type_id: event.target.value || null }))}>
                    <option value="">Selecionar tipo físico</option>
                    {physicalDamageTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
                  </select>
                </label>
              )}
              {(attackDamage.damage_kind === "magical" || attackDamage.damage_kind === "hybrid") && (
                <>
                  <label className="space-y-1 text-xs font-medium">
                    Tipo de dano mágico
                    <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={attackDamage.damage_type_id ?? ""}
                      onChange={(event) => setAttackDamage((current) => ({ ...current, damage_type_id: event.target.value || null }))}>
                      <option value="">Selecionar tipo mágico</option>
                      {magicalDamageTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs font-medium">
                    Grau da magia
                    <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={attackDamage.magic_level}
                      onChange={(event) => setAttackDamage((current) => ({ ...current, magic_level: event.target.value as "baixa" | "media" | "alta" }))}>
                      <option value="baixa">Baixa</option>
                      <option value="media">Média</option>
                      <option value="alta">Alta</option>
                    </select>
                  </label>
                </>
              )}
            </div>
            <AbilityAttackOnHitHealingEditor value={attackDamage} onChange={setAttackDamage} />
            <AbilityAttackExecutionEditor value={attackDamage} onChange={setAttackDamage}/>
            <div className="rounded-md border border-gold/25 p-3">
              <DefenseIgnoreInputs
                title="Ignorar defesa garantido pelo ataque"
                value={attackDamage.defense_ignore}
                onChange={(defense_ignore) => setAttackDamage((current) => ({ ...current, defense_ignore }))}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                O percentual ignora parte da Defesa Física ou Mágica efetiva; depois é descontado o valor fixo.
                A defesa nunca fica negativa. Configurações de chance e de cada alvo são somadas a estas.
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              Exemplo: Força 100, atributo em 100% e dano fixo adicional 20 = 120 de dano base antes da defesa. No combate, o mestre poderá somar dano extra para cada alvo.
            </p>
            <div className="space-y-3 border-t border-border/70 pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="text-sm font-semibold text-gold">Efeitos por chance de acerto</h4>
                  <p className="mt-1 text-xs text-muted-foreground">Crie categorias com efeitos e DoTs. No popup, o mestre decide separadamente quais categorias acertaram cada alvo.</p>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={() => setAttackEffectGroups((current) => [
                  ...current,
                  { id: crypto.randomUUID(), name: "Efeitos", chance: 50, effects: [], dots: [], defense_ignore: { ...ZERO_DEFENSE_IGNORE } },
                ])}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Adicionar categoria
                </Button>
              </div>
              {attackEffectGroups.length === 0 && (
                <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">Nenhuma categoria de efeitos configurada.</p>
              )}
              {attackEffectGroups.map((group) => (
                <section key={group.id} className="space-y-3 rounded-md border border-border p-3">
                  <div className="grid gap-3 sm:grid-cols-[1fr_140px_auto] sm:items-end">
                    <label className="space-y-1 text-xs font-medium">
                      Nome da categoria
                      <Input value={group.name} onChange={(event) => setAttackEffectGroups((current) => current.map((entry) =>
                        entry.id === group.id ? { ...entry, name: event.target.value } : entry
                      ))} placeholder="Ex.: Efeitos do veneno" />
                    </label>
                    <label className="space-y-1 text-xs font-medium">
                      Chance de acerto (%)
                      <Input type="number" min={0} max={100} value={group.chance}
                        onChange={(event) => setAttackEffectGroups((current) => current.map((entry) =>
                          entry.id === group.id ? { ...entry, chance: Math.max(0, Math.min(100, Math.round(Number(event.target.value) || 0))) } : entry
                        ))} />
                    </label>
                    <Button type="button" size="sm" variant="destructive" onClick={() => setAttackEffectGroups((current) => current.filter((entry) => entry.id !== group.id))}>
                      <Trash2 className="mr-1 h-3.5 w-3.5" /> Remover
                    </Button>
                  </div>
                  <div className="rounded-md border border-gold/25 p-3">
                    <DefenseIgnoreInputs
                      title="Ignorar defesa se esta categoria acertar"
                      value={group.defense_ignore}
                      onChange={(defense_ignore) => setAttackEffectGroups((current) =>
                        current.map((entry) => entry.id === group.id ? { ...entry, defense_ignore } : entry))}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      Só se aplica aos alvos marcados como acertados nesta categoria.
                      Pode ser configurado mesmo sem DoTs ou outros efeitos.
                    </p>
                  </div>
                  <AbilityEffectsEditor
                    effects={group.effects}
                    onChange={(next) => setAttackEffectGroups((current) => current.map((entry) => entry.id === group.id ? { ...entry, effects: next } : entry))}
                    permanent={false}
                    title="Efeitos da categoria"
                    description="Estes efeitos só são aplicados no alvo quando o mestre marcar esta categoria como acertada no popup do ataque."
                    defs={defs}
                  />
                  <AbilityDotEffectsEditor
                    dots={group.dots}
                    onChange={(dots) => setAttackEffectGroups((current) => current.map((entry) => entry.id === group.id ? { ...entry, dots } : entry))}
                    defs={defs}
                    physicalTypes={physicalDamageTypes}
                    magicalTypes={magicalDamageTypes}
                    title="DoTs da categoria"
                    description="Estes DoTs só entram se o mestre marcar esta categoria como acertada para o alvo no popup."
                  />
                </section>
              ))}
            </div>
          </div>
        )}
      </section>
      <AbilityDotEffectsEditor
        dots={dotEffects}
        onChange={setDotEffects}
        defs={defs}
        physicalTypes={physicalDamageTypes}
        magicalTypes={magicalDamageTypes}
        title="DoTs garantidos (fora do ataque)"
        description="Ao usar Ativar, o DoT é aplicado ao alvo escolhido sem rolagem de acerto. Se usar Atacar, ele é aplicado a todos os alvos selecionados, independentemente de terem sido marcados como acertados."
      />

    </div>
  );
}
