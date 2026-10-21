import { useId } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AttributeDef } from "@/lib/sheets";
import { useDamageTypes, type AbilityEffectDefinition, type AbilityEffectType, type DamageScope, type DamageReductionScope, type DamageMagicLevel } from "@/lib/abilities";

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
  healing: "Cura / cura por rodada",
};

export function AbilityEffectsEditor({
  effects,
  onChange,
  permanent,
  isPassive,
  title = "Efeitos da habilidade",
  description,
  defs,
  allowHealing = true,
  allowPeriodicHealing = true,
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
  allowHealing?: boolean;
  allowPeriodicHealing?: boolean;
}) {
  const isPermanent = permanent ?? isPassive ?? false;
  const { data: damageTypes = [] } = useDamageTypes();
  const effectEditorId = useId();

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
      damage_reduction_magic_level: null,
      damage_reduction_type_ids: damageTypes[0] ? [damageTypes[0].id] : [],
      damage_reduction_magic_levels: ["baixa"],
      target_scope: "target",
      apply_both_on_activation: false,
      healing_timing: "instant",
      healing_hp_enabled: false,
      healing_hp_mode: "fixed",
      healing_hp_amount: 10,
      healing_mana_enabled: false,
      healing_mana_mode: "fixed",
      healing_mana_amount: 10,
      healing_body_enabled: false,
      healing_body_mode: "fixed",
      healing_body_amount: 10,
      healing_sanity_enabled: false,
      healing_sanity_mode: "fixed",
      healing_sanity_amount: 10,
      healing_remove_debuffs: false,
      healing_debuff_blacklist: [],
      healing_debuff_name_blacklist: [],
      healing_reduce_debuff_turns_fixed: 0,
      healing_reduce_debuff_turns_percent: 0,
      healing_damage_type_id: damageTypes[0]?.id ?? null,
      healing_magic_level: "baixa",
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
        const isHealing = effect.effect_type === "healing";
        const selectedReductionTypeIds = effect.damage_reduction_type_ids ?? (effect.damage_reduction_type_id ? [effect.damage_reduction_type_id] : []);
        const selectedReductionMagicLevels = effect.damage_reduction_magic_levels ?? (effect.damage_reduction_magic_level ? [effect.damage_reduction_magic_level] : []);
        const needsAttribute = effect.effect_type === "status" || effect.effect_type === "regeneration";
        const needsValue = needsAttribute || effect.effect_type === "mana_regeneration" || effect.effect_type === "mana_used" || effect.effect_type === "damage_dealt" || isDamageReduction;
        function patchHealingOption(
          resourceKey: "hp" | "mana" | "body" | "sanity",
          field: "enabled" | "mode" | "amount",
          value: boolean | string | number,
        ) {
          const keys = {
            hp: { enabled: "healing_hp_enabled", mode: "healing_hp_mode", amount: "healing_hp_amount" },
            mana: { enabled: "healing_mana_enabled", mode: "healing_mana_mode", amount: "healing_mana_amount" },
            body: { enabled: "healing_body_enabled", mode: "healing_body_mode", amount: "healing_body_amount" },
            sanity: { enabled: "healing_sanity_enabled", mode: "healing_sanity_mode", amount: "healing_sanity_amount" },
          } as const;
          patch(index, { [keys[resourceKey][field]]: value } as Partial<AbilityEffectDefinition>);
        }
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
                    target_scope: effect.target_scope ?? "target",
                    healing_timing: type === "healing" ? "instant" : effect.healing_timing ?? "instant",
                    healing_hp_enabled: type === "healing" ? (effect.healing_hp_enabled ?? false) : effect.healing_hp_enabled,
                    healing_mana_enabled: type === "healing" ? (effect.healing_mana_enabled ?? false) : effect.healing_mana_enabled,
                    healing_body_enabled: type === "healing" ? (effect.healing_body_enabled ?? false) : effect.healing_body_enabled,
                    healing_sanity_enabled: type === "healing" ? (effect.healing_sanity_enabled ?? false) : effect.healing_sanity_enabled,
                    healing_damage_type_id: type === "healing" ? (effect.healing_damage_type_id ?? damageTypes[0]?.id ?? null) : effect.healing_damage_type_id,
                    healing_magic_level: type === "healing" ? (effect.healing_magic_level ?? "baixa") : effect.healing_magic_level,
                    attribute_key: type === "mana_regeneration" ? "mana" : type === "regeneration" ? "hp" : type === "status" ? firstStatusKey() : null,
                    polarity: type === "magic_prohibition" || type === "no_mana" ? "debuff" : type === "damage_reduction" ? "buff" : effect.polarity,
                    damage_reduction_scope: type === "damage_reduction" ? "physical" : effect.damage_reduction_scope,
                    damage_reduction_type_id: null,
                    damage_reduction_magic_level: null,
                    damage_reduction_type_ids: type === "damage_reduction" ? (damageTypes[0] ? [damageTypes[0].id] : []) : null,
                    damage_reduction_magic_levels: type === "damage_reduction" ? ["baixa"] : null,
                  });
                }}>
                {Object.entries(effectTypeLabels)
                  .filter(([value]) => (!isPermanent || value !== "magic_prohibition") && (allowHealing || value !== "healing"))
                  .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              {!isPermanent && (
                <label className="space-y-1 text-xs font-medium">
                  Aplicar efeito em
                  <select aria-label="Aplicar efeito em" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={effect.target_scope ?? "target"}
                    onChange={(e) => patch(index, { target_scope: e.target.value as "caster" | "target" | "both" })}>
                    <option value="caster">Caster (quem usa)</option>
                    <option value="target">Alvo</option>
                    <option value="both">Ambos (vale para Caster ou Alvo)</option>
                  </select>
                </label>
              )}
              {!isPermanent && (
                <label className="flex items-center gap-2 text-xs font-medium sm:col-span-2">
                  <input type="checkbox" checked={effect.apply_both_on_activation ?? false}
                    onChange={(e) => patch(index, { apply_both_on_activation: e.target.checked })} />
                  Aplicar em ambos ao ativar (Caster e Alvo)
                </label>
              )}
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
                          damage_reduction_type_id: null,
                          damage_reduction_magic_level: null,
                          damage_reduction_type_ids: scope === "magical"
                            ? (effect.damage_reduction_scope === "magical"
                              ? (effect.damage_reduction_type_ids ?? (effect.damage_reduction_type_id ? [effect.damage_reduction_type_id] : []))
                              : damageTypes[0] ? [damageTypes[0].id] : [])
                            : null,
                          damage_reduction_magic_levels: scope === "magical"
                            ? (effect.damage_reduction_scope === "magical"
                              ? (effect.damage_reduction_magic_levels ?? (effect.damage_reduction_magic_level ? [effect.damage_reduction_magic_level] : []))
                              : ["baixa"])
                            : null,
                          polarity: "buff",
                        });
                      }}>
                      <option value="physical">Físico</option>
                      <option value="magical">Mágico</option>
                    </select>
                  </label>
                  {effect.damage_reduction_scope === "magical" && (
                    <>
                      <fieldset className="space-y-2 text-xs sm:col-span-2">
                        <legend className="font-medium">Tipo mágico</legend>
                        <label className="flex items-center gap-2 rounded-md border border-border px-2 py-2">
                          <input type="radio" name={`${effectEditorId}-mitigacao-tipos-${index}`} checked={selectedReductionTypeIds.length === 0}
                            onChange={() => patch(index, { damage_reduction_type_ids: [], damage_reduction_type_id: null, polarity: "buff" })} />
                          Todos os tipos
                        </label>
                        <p className="text-muted-foreground">{selectedReductionTypeIds.length === 0 ? "A redução afeta todos os tipos mágicos cadastrados." : `${selectedReductionTypeIds.length} tipo(s) selecionado(s).`}</p>
                        {damageTypes.length === 0
                          ? <p className="text-amber-500">Nenhum tipo mágico cadastrado.</p>
                          : <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                              {damageTypes.map((type) => (
                                <label key={type.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-2">
                                  <input type="checkbox" checked={selectedReductionTypeIds.includes(type.id)}
                                    onChange={(e) => {
                                      const next = e.target.checked
                                        ? [...selectedReductionTypeIds, type.id]
                                        : selectedReductionTypeIds.filter((id) => id !== type.id);
                                      patch(index, { damage_reduction_type_ids: next, damage_reduction_type_id: null, polarity: "buff" });
                                    }} />
                                  {type.name}
                                </label>
                              ))}
                            </div>}
                      </fieldset>
                      <fieldset className="space-y-2 text-xs sm:col-span-2">
                        <legend className="font-medium">Grau da magia</legend>
                        <label className="flex items-center gap-2 rounded-md border border-border px-2 py-2">
                          <input type="radio" name={`${effectEditorId}-mitigacao-graus-${index}`} checked={selectedReductionMagicLevels.length === 0}
                            onChange={() => patch(index, { damage_reduction_magic_levels: [], damage_reduction_magic_level: null, polarity: "buff" })} />
                          Todos os graus
                        </label>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                          {([["baixa", "Baixa"], ["media", "Média"], ["alta", "Alta"]] as const).map(([level, label]) => (
                            <label key={level} className="flex items-center gap-2 rounded-md border border-border px-2 py-2">
                              <input type="checkbox" checked={selectedReductionMagicLevels.includes(level)}
                                onChange={(e) => {
                                  const next = e.target.checked
                                    ? [...selectedReductionMagicLevels, level]
                                    : selectedReductionMagicLevels.filter((selected) => selected !== level);
                                  patch(index, { damage_reduction_magic_levels: next, damage_reduction_magic_level: null, polarity: "buff" });
                                }} />
                              {label}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    </>
                  )}
                  <p className="self-end text-xs text-muted-foreground sm:col-span-2">Reduz o dano recebido depois da defesa correspondente. O valor fixo é aplicado primeiro e depois a porcentagem. Em dano híbrido, a redução atua apenas na metade compatível.</p>
                </>
              )}
              {isHealing && allowHealing && (
                <fieldset className="space-y-3 rounded-md border border-border p-3 sm:col-span-2">
                  <legend className="px-1 text-sm font-semibold text-gold">Configuração da cura</legend>
                  <label className="block space-y-1 text-xs font-medium">
                    Aplicação da cura
                    <select aria-label="Modo de aplicação da cura" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={effect.healing_timing ?? "instant"}
                      disabled={!allowPeriodicHealing}
                      onChange={(e) => patch(index, { healing_timing: e.target.value as "instant" | "per_turn" })}>
                      <option value="instant">Cura instantânea ao ativar</option>
                      {allowPeriodicHealing && <option value="per_turn">Buff: curar a cada turno</option>}
                    </select>
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {([
                      { key: "hp", label: "HP", enabled: effect.healing_hp_enabled ?? false, mode: effect.healing_hp_mode ?? "fixed", amount: effect.healing_hp_amount ?? 0 },
                      { key: "mana", label: "Mana", enabled: effect.healing_mana_enabled ?? false, mode: effect.healing_mana_mode ?? "fixed", amount: effect.healing_mana_amount ?? 0 },
                      { key: "body", label: "Corpo", enabled: effect.healing_body_enabled ?? false, mode: effect.healing_body_mode ?? "fixed", amount: effect.healing_body_amount ?? 0 },
                      { key: "sanity", label: "Sanidade", enabled: effect.healing_sanity_enabled ?? false, mode: effect.healing_sanity_mode ?? "fixed", amount: effect.healing_sanity_amount ?? 0 },
                    ] as const).map((resource) => (
                      <div key={resource.key} className="space-y-2 rounded-md border border-border p-3">
                        <label className="flex items-center gap-2 text-sm font-medium">
                          <input type="checkbox" checked={resource.enabled}
                            onChange={(e) => patchHealingOption(resource.key, "enabled", e.target.checked)} />
                          Curar {resource.label}
                        </label>
                        {resource.enabled && (
                          <div className="grid grid-cols-2 gap-2">
                            <label className="space-y-1 text-xs">
                              Modo
                              <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                                value={resource.mode}
                                onChange={(e) => patchHealingOption(resource.key, "mode", e.target.value)}>
                                <option value="fixed">{resource.key === "body" || resource.key === "sanity" ? "Pontos percentuais" : "Fixo"}</option>
                                <option value="percent">{resource.key === "body" || resource.key === "sanity" ? "% do que falta" : "% do máximo"}</option>
                              </select>
                            </label>
                            <label className="space-y-1 text-xs">
                              Valor ({resource.mode === "percent" ? "%" : resource.key === "body" || resource.key === "sanity" ? "pontos %" : "fixo"})
                              <Input type="number" min="0" max={resource.mode === "percent" ? 100 : undefined}
                                value={resource.amount}
                                onChange={(e) => patchHealingOption(resource.key, "amount", Math.max(0, Number(e.target.value) || 0))} />
                            </label>
                          </div>
                        )}
                        {(resource.key === "body" || resource.key === "sanity") && resource.enabled && (
                          <p className="text-[11px] text-muted-foreground">
                            Fixo adiciona pontos percentuais; porcentagem recupera essa fração do que falta até 100%.
                          </p>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="space-y-2 rounded-md border border-border p-3">
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <input type="checkbox" checked={effect.healing_remove_debuffs ?? false}
                        onChange={(e) => patch(index, { healing_remove_debuffs: e.target.checked })} />
                      Remover debuffs do personagem escolhido
                    </label>
                    <label className="block space-y-1 text-xs">
                      Reduzir duração de debuffs — turnos fixos
                      <Input type="number" min="0" step="1"
                        value={effect.healing_reduce_debuff_turns_fixed ?? 0}
                        onChange={(e) => patch(index, { healing_reduce_debuff_turns_fixed: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                    </label>
                    <label className="block space-y-1 text-xs">
                      Reduzir duração de debuffs — porcentagem
                      <Input type="number" min="0" max="100"
                        value={effect.healing_reduce_debuff_turns_percent ?? 0}
                        onChange={(e) => patch(index, { healing_reduce_debuff_turns_percent: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
                    </label>
                    {((effect.healing_remove_debuffs ?? false) || (effect.healing_reduce_debuff_turns_fixed ?? 0) > 0 || (effect.healing_reduce_debuff_turns_percent ?? 0) > 0) && (
                      <fieldset className="space-y-2">
                        <legend className="text-xs font-medium">Lista negra — debuffs que não podem ser removidos nem reduzidos</legend>
                        {([
                          ["status", "Buff/debuff de atributo"],
                          ["regeneration", "Modificador de regeneração"],
                          ["mana_used", "Modificador de Mana usada"],
                          ["no_regen_hp", "Bloqueio de regeneração de HP"],
                          ["no_regen_mana", "Bloqueio de regeneração de Mana"],
                          ["magic_prohibition", "Proibição de magia"],
                          ["no_mana", "Sem Mana"],
                          ["stun", "Stun"],
                          ["damage_dealt", "Modificador de dano causado"],
                        ] as const).map(([type, label]) => (
                          <label key={type} className="flex items-center gap-2 text-xs">
                            <input type="checkbox" checked={(effect.healing_debuff_blacklist ?? []).includes(type)}
                              onChange={(e) => {
                                const current = effect.healing_debuff_blacklist ?? [];
                                const next = e.target.checked ? [...current, type] : current.filter((item) => item !== type);
                                patch(index, { healing_debuff_blacklist: next });
                              }} />
                            {label}
                          </label>
                        ))}
                      </fieldset>
                    )}
                    <label className="block space-y-1 text-xs">
                      Nomes específicos na lista negra (separados por vírgula)
                      <Input
                        value={(effect.healing_debuff_name_blacklist ?? []).join(", ")}
                        placeholder="Ex.: Envenenado, Lentidão, Paralisia"
                        onChange={(e) => patch(index, {
                          healing_debuff_name_blacklist: [...new Set(e.target.value.split(",").map((name) => name.trim()).filter(Boolean))],
                        })}
                      />
                      <span className="text-[11px] text-muted-foreground">
                        O nome é comparado com o nome do efeito, mesmo quando o sistema adiciona o nome da habilidade na frente.
                      </span>
                    </label>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="space-y-1 text-xs font-medium">
                      Tipo mágico da cura (metadado para regras futuras)
                      <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                        value={effect.healing_damage_type_id ?? ""}
                        onChange={(e) => patch(index, { healing_damage_type_id: e.target.value || null })}>
                        <option value="">Não definido</option>
                        {damageTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
                      </select>
                    </label>
                    <label className="space-y-1 text-xs font-medium">
                      Grau da magia
                      <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                        value={effect.healing_magic_level ?? "baixa"}
                        onChange={(e) => patch(index, { healing_magic_level: e.target.value as DamageMagicLevel })}>
                        <option value="baixa">Baixa</option>
                        <option value="media">Média</option>
                        <option value="alta">Alta</option>
                      </select>
                    </label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    HP/Mana em porcentagem usam o máximo atual. Em Corpo/Sanidade, o modo porcentagem restaura parte do que falta até 100%.
                    {effect.healing_timing === "per_turn" ? " A restauração configurada acontece a cada avanço de turno enquanto o buff estiver ativo; a remoção/redução de debuffs é aplicada uma vez ao ativar." : ""}
                  </p>
                </fieldset>
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
              {!isPermanent && (!isHealing || (effect.healing_timing ?? "instant") === "per_turn") && (
                <label className="space-y-1 text-xs font-medium">
                  {isHealing ? "Duração do buff de cura (turnos)" : "Duração do efeito (turnos)"}
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
