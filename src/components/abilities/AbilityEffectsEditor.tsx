import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AttributeDef } from "@/lib/sheets";
import { useDamageTypes, type AbilityEffectDefinition, type AbilityEffectType, type DamageScope, type DamageMagicLevel, type DamageReductionScope } from "@/lib/abilities";

const effectTypeLabels: Record<AbilityEffectType, string> = {
  status: "Buff/debuff de atributo",
  regeneration: "Modificador de regeneração (HP/Mana)",
  mana_regeneration: "Regeneração de Mana",
  mana_used: "Mana Usada",
  no_regen_hp: "Bloquear regeneração de HP",
  no_regen_mana: "Bloquear regeneração de Mana",
  magic_prohibition: "Proibição de magia (debuff)",
  stun: "Stun (visual)",
  damage_dealt: "Dano Causado",
  no_mana: "Sem Mana",
  damage_reduction: "Mitigação de Dano",
};

export function AbilityEffectsEditor({
  effects,
  onChange,
  permanent,
  isPassive,
  title = "Efeitos da habilidade",
  description,
  defs,
}: {
  effects: AbilityEffectDefinition[];
  onChange: (effects: AbilityEffectDefinition[]) => void;
  /** When true, values are permanent while the ability stays on the character. */
  permanent?: boolean;
  /** Backwards-compatible prop for older callers. */
  isPassive?: boolean;
  title?: string;
  description?: string;
  defs: AttributeDef[];
}) {
  const isPermanent = permanent ?? isPassive ?? false;
  const { data: damageTypes = [] } = useDamageTypes();

  function patch(index: number, values: Partial<AbilityEffectDefinition>) {
    onChange(effects.map((effect, i) => i === index ? { ...effect, ...values } : effect));
  }

  function firstStatusKey() {
    return defs.find((d) => d.key !== "hp" && d.key !== "mana")?.key ?? "hp";
  }

  function add() {
    onChange([...effects, {
      name: "Novo efeito",
      effect_type: "status",
      attribute_key: firstStatusKey(),
      polarity: "buff",
      value_mode: "fixed",
      amount: 10,
      duration: 2,
      damage_scope: "any",
      damage_reduction_scope: "physical",
      damage_reduction_type_id: null,
      damage_reduction_magic_level: "baixa",
    }]);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold">{title}</h4>
          <p className="text-xs text-muted-foreground">
            {description ?? (isPermanent
              ? "Estes efeitos ficam ativos enquanto a habilidade estiver na ficha."
              : "Estes efeitos são aplicados ao alvo quando a habilidade é ativada.")}
          </p>
        </div>
        <Button size="sm" type="button" variant="outline" onClick={add}><Plus className="mr-1 h-3.5 w-3.5" /> Adicionar efeito</Button>
      </div>
      {effects.length === 0 && <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">Nenhum efeito configurado.</p>}
      {effects.map((effect, index) => {
        const isMagicProhibition = effect.effect_type === "magic_prohibition";
        const isDamageDealt = effect.effect_type === "damage_dealt";
        const isNoMana = effect.effect_type === "no_mana";
        const isDamageReduction = effect.effect_type === "damage_reduction";
        const needsAttribute = effect.effect_type === "status" || effect.effect_type === "regeneration";
        const needsValue = needsAttribute || effect.effect_type === "mana_regeneration" || effect.effect_type === "mana_used" || effect.effect_type === "damage_dealt" || isDamageReduction;
        return (
          <div key={index} className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
            <div className="flex items-center gap-2">
              <Input aria-label={`Nome do efeito ${index + 1}`} value={effect.name} onChange={(e) => patch(index, { name: e.target.value })} placeholder="Nome do efeito" />
              <Button type="button" size="icon" variant="ghost" aria-label="Remover efeito" onClick={() => onChange(effects.filter((_, i) => i !== index))}><Minus className="h-4 w-4" /></Button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <select aria-label="Tipo do efeito" className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm" value={effect.effect_type}
                onChange={(e) => {
                  const type = e.target.value as AbilityEffectType;
                  patch(index, {
                    effect_type: type,
                    attribute_key: type === "mana_regeneration" ? "mana" : type === "regeneration" ? "hp" : type === "status" ? firstStatusKey() : null,
                    polarity: type === "magic_prohibition" || type === "no_mana" ? "debuff" : type === "damage_reduction" ? "buff" : effect.polarity,
                    damage_reduction_scope: type === "damage_reduction" ? "physical" : effect.damage_reduction_scope,
                    damage_reduction_type_id: type === "damage_reduction" ? (damageTypes[0]?.id ?? null) : null,
                    damage_reduction_magic_level: type === "damage_reduction" ? "baixa" : null,
                  });
                }}>
                {Object.entries(effectTypeLabels).filter(([value]) => !isPermanent || value !== "magic_prohibition").map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              {isDamageDealt && (
                <label className="space-y-1 text-xs font-medium">
                  Tipo de dano afetado
                  <select aria-label="Tipo de dano afetado pelo buff/debuff" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={effect.damage_scope ?? "any"}
                    onChange={(e) => patch(index, { damage_scope: e.target.value as DamageScope })}>
                    <option value="physical">Físico</option>
                    <option value="magical">Mágico</option>
                    <option value="any">Qualquer dano</option>
                  </select>
                </label>
              )}
              {isDamageReduction && (
                <>
                  <label className="space-y-1 text-xs font-medium">
                    Categoria de dano reduzido
                    <select aria-label="Categoria de dano reduzido" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={effect.damage_reduction_scope ?? "physical"}
                      onChange={(e) => {
                        const scope = e.target.value as DamageReductionScope;
                        patch(index, {
                          damage_reduction_scope: scope,
                          damage_reduction_type_id: scope === "magical" ? (effect.damage_reduction_type_id ?? damageTypes[0]?.id ?? null) : null,
                          damage_reduction_magic_level: scope === "magical" ? (effect.damage_reduction_magic_level ?? "baixa") : null,
                          polarity: "buff",
                        });
                      }}>
                      <option value="physical">Físico</option>
                      <option value="magical">Mágico</option>
                    </select>
                  </label>
                  {effect.damage_reduction_scope === "magical" && (
                    <>
                      <label className="space-y-1 text-xs font-medium">
                        Tipo mágico
                        <select aria-label="Tipo mágico que será reduzido" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                          value={effect.damage_reduction_type_id ?? ""}
                          onChange={(e) => patch(index, { damage_reduction_type_id: e.target.value || null, polarity: "buff" })}>
                          <option value="" disabled>{damageTypes.length ? "Selecione um tipo" : "Nenhum tipo mágico cadastrado"}</option>
                          {damageTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
                        </select>
                      </label>
                      <label className="space-y-1 text-xs font-medium">
                        Grau da magia
                        <select aria-label="Grau mágico que será reduzido" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                          value={effect.damage_reduction_magic_level ?? "baixa"}
                          onChange={(e) => patch(index, { damage_reduction_magic_level: e.target.value as DamageMagicLevel, polarity: "buff" })}>
                          <option value="baixa">Baixa</option>
                          <option value="media">Média</option>
                          <option value="alta">Alta</option>
                        </select>
                      </label>
                    </>
                  )}
                  <p className="self-end text-xs text-muted-foreground sm:col-span-2">Reduz o dano recebido depois da defesa correspondente. O valor fixo é aplicado primeiro e depois a porcentagem. Em dano híbrido, a redução atua apenas na metade compatível.</p>
                </>
              )}
              {needsAttribute && (
                <select aria-label="Atributo afetado" className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm" value={effect.attribute_key ?? (effect.effect_type === "regeneration" ? "hp" : "strength")}
                  onChange={(e) => patch(index, { attribute_key: e.target.value })}>
                  {(effect.effect_type === "regeneration" ? [{ key: "hp", label: "HP" }, { key: "mana", label: "Mana" }] : defs.map((d) => ({ key: d.key, label: d.label })))
                    .map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                </select>
              )}
              {needsValue && (
                <>
                  {!isDamageReduction && (
                    <select aria-label="Buff ou debuff" className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm" value={effect.polarity}
                    onChange={(e) => patch(index, { polarity: e.target.value as "buff" | "debuff" })}>
                    <option value="buff">Buff</option><option value="debuff">Debuff</option>
                    </select>
                  )}
                  <select aria-label="Modo do valor" className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm" value={effect.value_mode}
                    onChange={(e) => patch(index, { value_mode: e.target.value as "percent" | "fixed" })}>
                    <option value="fixed">Valor fixo</option><option value="percent">Porcentagem</option>
                  </select>
                  <label className="space-y-1 text-xs font-medium">
                    Valor ({effect.value_mode === "percent" ? "%" : effect.effect_type === "damage_dealt" ? "dano fixo" : effect.effect_type === "mana_regeneration" || effect.effect_type === "mana_used" ? "Mana" : effect.effect_type === "damage_reduction" ? "dano reduzido" : "pontos"})
                    <Input type="number" min="0" value={effect.amount} onChange={(e) => patch(index, { amount: Math.max(0, Number(e.target.value) || 0) })} />
                  </label>
                </>
              )}
              {!isPermanent && (
                <label className="space-y-1 text-xs font-medium">
                  Duração do efeito (turnos)
                  <Input type="number" min="1" value={effect.duration} onChange={(e) => patch(index, { duration: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
                </label>
              )}
              {isPermanent && <p className="self-end text-xs text-muted-foreground">Efeito permanente enquanto a habilidade estiver atribuída.</p>}
              {isMagicProhibition && <p className="self-end text-xs text-amber-500 sm:col-span-2">Debuff: impede a ativação de habilidades mágicas ou que consomem Mana enquanto durar.</p>}
              {isNoMana && <p className="self-end text-xs text-amber-500 sm:col-span-2">Debuff: zera a Mana atual e máxima enquanto durar e bloqueia habilidades mágicas ou que gastem Mana. Não é possível mudar sua polaridade.</p>}
              {effect.effect_type === "mana_regeneration" && <p className="self-end text-xs text-muted-foreground">Afeta regeneração de Mana por turno e recuperação manual, mas não o preenchimento completo.</p>}
              {effect.effect_type === "mana_used" && <p className="self-end text-xs text-muted-foreground">Buff reduz Mana gasta; debuff aumenta o custo das habilidades.</p>}
              {effect.effect_type === "damage_dealt" && <p className="self-end text-xs text-muted-foreground">Modifica o dano correspondente ao tipo selecionado antes das defesas. Em dano híbrido, efeitos físicos e mágicos ajustam sua metade correspondente; “Qualquer dano” também afeta dano verdadeiro.</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
