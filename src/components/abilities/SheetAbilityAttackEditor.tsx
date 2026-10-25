import type { Dispatch, SetStateAction } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import { DefenseIgnoreInputs } from "@/components/abilities/DefenseIgnoreInputs";
import { ZERO_DEFENSE_IGNORE } from "@/lib/defense-ignore";
import { useDamageTypes, type AbilityDotEffect, type AbilityAttackEffectGroup, type AbilityAttackDamageConfig, type AbilityAttackDamageKind } from "@/lib/abilities";
import type { useDefs } from "@/lib/sheets";

/** Shared catalog-grade attack configuration editor for character-exclusive abilities. */

type DotDamageTypeOption = { id: string; name: string };
type DotAttributeOption = { key: string; label: string };

function createAbilityDot(physicalTypes: DotDamageTypeOption[], magicalTypes: DotDamageTypeOption[]): AbilityDotEffect {
  return {
    id: crypto.randomUUID(),
    name: "Novo DoT",
    damage_kind: "physical",
    physical_damage_type_id: physicalTypes[0]?.id ?? null,
    damage_type_id: magicalTypes[0]?.id ?? null,
    magic_level: null,
    damage_mode: "fixed",
    damage_amount: 10,
    attribute_key: null,
    attribute_percent: 100,
    fixed_damage: 0,
    duration: 3,
  };
}

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
  function update(dotId: string, patch: Partial<AbilityDotEffect>) {
    onChange(dots.map((dot) => dot.id === dotId ? { ...dot, ...patch } : dot));
  }

  return (
    <section className="space-y-3 rounded-md border border-orange-500/25 bg-orange-500/[0.03] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold text-gold">{title}</h4>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange([...dots, createAbilityDot(physicalTypes, magicalTypes)])}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Adicionar DoT
        </Button>
      </div>
      {!dots.length && <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">Nenhum DoT configurado.</p>}
      {dots.map((dot) => (
        <article key={dot.id} className="space-y-3 rounded-md border border-border bg-background/50 p-3">
          <div className="flex items-start gap-2">
            <label className="min-w-0 flex-1 space-y-1 text-xs font-medium">
              Nome do DoT
              <Input maxLength={120} value={dot.name} onChange={(event) => update(dot.id, { name: event.target.value })} placeholder="Veneno, queimadura, sangramento..." />
            </label>
            <Button type="button" size="icon" variant="ghost" className="mt-5 shrink-0 text-destructive" aria-label={"Remover DoT " + dot.name} onClick={() => onChange(dots.filter((entry) => entry.id !== dot.id))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs font-medium">
              Categoria de dano
              <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={dot.damage_kind}
                onChange={(event) => {
                  const kind = event.target.value as "physical" | "magical";
                  update(dot.id, {
                    damage_kind: kind,
                    physical_damage_type_id: kind === "physical" ? (physicalTypes.find((type) => type.id === dot.physical_damage_type_id)?.id ?? physicalTypes[0]?.id ?? null) : null,
                    damage_type_id: kind === "magical" ? (magicalTypes.find((type) => type.id === dot.damage_type_id)?.id ?? magicalTypes[0]?.id ?? null) : null,
                    magic_level: kind === "magical" ? (dot.magic_level ?? "baixa") : null,
                  });
                }}>
                <option value="physical">Físico</option>
                <option value="magical">Mágico</option>
              </select>
            </label>
            <label className="space-y-1 text-xs font-medium">
              Cálculo do dano por turno
              <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={dot.damage_mode}
                onChange={(event) => update(dot.id, { damage_mode: event.target.value as AbilityDotEffect["damage_mode"] })}>
                <option value="fixed">Dano fixo</option>
                <option value="percent">% do HP máximo do alvo</option>
                <option value="attribute">Baseado em um atributo do lançador</option>
              </select>
            </label>
            {dot.damage_kind === "physical" ? (
              <label className="space-y-1 text-xs font-medium">
                Tipo de dano físico
                <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={dot.physical_damage_type_id ?? ""}
                  onChange={(event) => update(dot.id, { physical_damage_type_id: event.target.value || null })}>
                  <option value="">Selecione um tipo físico</option>
                  {physicalTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
                </select>
              </label>
            ) : (
              <>
                <label className="space-y-1 text-xs font-medium">
                  Tipo de dano mágico
                  <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={dot.damage_type_id ?? ""}
                    onChange={(event) => update(dot.id, { damage_type_id: event.target.value || null })}>
                    <option value="">Selecione um tipo mágico</option>
                    {magicalTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
                  </select>
                </label>
                <label className="space-y-1 text-xs font-medium">
                  Grau da magia
                  <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={dot.magic_level ?? "baixa"}
                    onChange={(event) => update(dot.id, { magic_level: event.target.value as "baixa" | "media" | "alta" })}>
                    <option value="baixa">Baixa</option>
                    <option value="media">Média</option>
                    <option value="alta">Alta</option>
                  </select>
                </label>
              </>
            )}
            {dot.damage_mode !== "attribute" ? (
              <label className="space-y-1 text-xs font-medium">
                {dot.damage_mode === "percent" ? "Percentual por turno (%)" : "Dano bruto por turno"}
                <Input type="number" min={dot.damage_mode === "percent" ? 0.1 : 1} max={dot.damage_mode === "percent" ? 1000 : 1000000}
                  step={dot.damage_mode === "percent" ? "any" : "1"} value={dot.damage_amount}
                  onChange={(event) => update(dot.id, { damage_amount: Number(event.target.value) || 0 })} />
              </label>
            ) : (
              <>
                <label className="space-y-1 text-xs font-medium">
                  Atributo do lançador
                  <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={dot.attribute_key ?? ""}
                    onChange={(event) => update(dot.id, { attribute_key: event.target.value || null })}>
                    <option value="">Selecione um atributo</option>
                    {defs.filter((def) => !["hp", "mana"].includes(def.key)).map((def) => <option key={def.key} value={def.key}>{def.label}</option>)}
                  </select>
                </label>
                <label className="space-y-1 text-xs font-medium">
                  Percentual do atributo (%)
                  <Input type="number" min={0} max={1000} step="any" value={dot.attribute_percent}
                    onChange={(event) => update(dot.id, { attribute_percent: Math.max(0, Math.min(1000, Number(event.target.value) || 0)) })} />
                </label>
                <label className="space-y-1 text-xs font-medium">
                  Dano fixo adicional
                  <Input type="number" min={0} max={1000000} step="1" value={dot.fixed_damage}
                    onChange={(event) => update(dot.id, { fixed_damage: Math.max(0, Math.min(1000000, Number(event.target.value) || 0)) })} />
                </label>
              </>
            )}
            <label className="space-y-1 text-xs font-medium">
              Duração (turnos do alvo)
              <Input type="number" min={1} max={1000} step={1} value={dot.duration}
                onChange={(event) => update(dot.id, { duration: Math.max(1, Math.min(1000, Math.floor(Number(event.target.value) || 1))) })} />
            </label>
          </div>
          {dot.damage_mode === "attribute" && (
            <p className="text-xs text-muted-foreground">
              O valor efetivo do atributo é multiplicado pelo percentual e somado ao dano fixo. O dano é calculado quando a habilidade é usada e esse valor fica salvo para cada tick do DoT.
            </p>
          )}
          {dot.damage_mode === "percent" && <p className="text-xs text-muted-foreground">O percentual é calculado sobre o HP máximo do alvo a cada turno.</p>}
        </article>
      ))}
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
                  onChange={(event) => setAttackDamage((current) => ({ ...current, attribute_key: event.target.value || null }))}
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
