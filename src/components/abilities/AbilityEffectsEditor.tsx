import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AttributeDef } from "@/lib/sheets";
import type { AbilityEffectDefinition, AbilityEffectType } from "@/lib/abilities";

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
        const needsAttribute = effect.effect_type === "status" || effect.effect_type === "regeneration";
        const needsValue = needsAttribute || effect.effect_type === "mana_regeneration" || effect.effect_type === "mana_used" || effect.effect_type === "damage_dealt";
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
                    polarity: type === "magic_prohibition" ? "debuff" : effect.polarity,
                  });
                }}>
                {Object.entries(effectTypeLabels).filter(([value]) => !isPermanent || value !== "magic_prohibition").map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              {needsAttribute && (
                <select aria-label="Atributo afetado" className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm" value={effect.attribute_key ?? (effect.effect_type === "regeneration" ? "hp" : "strength")}
                  onChange={(e) => patch(index, { attribute_key: e.target.value })}>
                  {(effect.effect_type === "regeneration" ? [{ key: "hp", label: "HP" }, { key: "mana", label: "Mana" }] : defs.map((d) => ({ key: d.key, label: d.label })))
                    .map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                </select>
              )}
              {needsValue && (
                <>
                  <select aria-label="Buff ou debuff" className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm" value={effect.polarity}
                    onChange={(e) => patch(index, { polarity: e.target.value as "buff" | "debuff" })}>
                    <option value="buff">Buff</option><option value="debuff">Debuff</option>
                  </select>
                  <select aria-label="Modo do valor" className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm" value={effect.value_mode}
                    onChange={(e) => patch(index, { value_mode: e.target.value as "percent" | "fixed" })}>
                    <option value="fixed">Valor fixo</option><option value="percent">Porcentagem</option>
                  </select>
                  <label className="space-y-1 text-xs font-medium">
                    Valor ({effect.value_mode === "percent" ? "%" : effect.effect_type === "damage_dealt" ? "dano fixo" : effect.effect_type === "mana_regeneration" || effect.effect_type === "mana_used" ? "Mana" : "pontos"})
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
              {isMagicProhibition && <p className="self-end text-xs text-amber-500 sm:col-span-2">Debuff: impede a ativação de habilidades que consomem Mana enquanto durar. Não é possível mudar sua polaridade.</p>}
              {effect.effect_type === "mana_regeneration" && <p className="self-end text-xs text-muted-foreground">Afeta regeneração de Mana por turno e recuperação manual, mas não o preenchimento completo.</p>}
              {effect.effect_type === "mana_used" && <p className="self-end text-xs text-muted-foreground">Buff reduz Mana gasta; debuff aumenta o custo das habilidades.</p>}
              {effect.effect_type === "damage_dealt" && <p className="self-end text-xs text-muted-foreground">Modifica o dano de cada golpe causado pelo personagem, antes das defesas do alvo.</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
