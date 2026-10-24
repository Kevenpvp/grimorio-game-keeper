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
import { parseAbilityEffects, parseAbilityAttackDamage, parseAbilityAttackEffectGroups, parseAbilityDotEffects, useAbilities, useDamageTypes, type Ability, type AbilityEffectDefinition, type AbilityAttackDamageConfig, type AbilityAttackDamageKind, type AbilityAttackEffectGroup, type AbilityDotEffect } from "@/lib/abilities";
import {
  CUSTOM_ABILITY_SCRIPTS,
  DEMONIO_INTERNO_DEFAULT_ATTRIBUTES,
  customAttributeKey,
  parseCustomAbilityAttributes,
  type CustomAbilityAttribute,
} from "@/lib/custom-ability-scripts";
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
      name: "Nova habilidade", description: "", is_passive: false, can_activate: true, is_magical: true, self_target_only: false, cooldown_turns: 1, mana_cost: 0, effects: [], passive_effects: [], end_effects: [], dot_effects: [], attack_effect_groups: [], custom_script_key: null, custom_attributes: [],
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

function AbilityDotEffectsEditor({
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

function AbilityEditor({ ability, defs, isNew, onSaved }: { ability: Ability; defs: NonNullable<ReturnType<typeof useDefs>["data"]>; isNew: boolean; onSaved: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(ability.name);
  const [description, setDescription] = useState(ability.description ?? "");
  const [customScriptKey, setCustomScriptKey] = useState(ability.custom_script_key ?? "");
  const [customAttributes, setCustomAttributes] = useState<CustomAbilityAttribute[]>(() => parseCustomAbilityAttributes(ability.custom_attributes));
  const [canActivate, setCanActivate] = useState(ability.can_activate);
  const [toggleMode, setToggleMode] = useState(ability.toggle_mode);
  const [isMagical, setIsMagical] = useState(ability.is_magical);
  const [attackEnabled, setAttackEnabled] = useState(ability.attack_enabled);
  const [attackDamage, setAttackDamage] = useState<AbilityAttackDamageConfig>(() => parseAbilityAttackDamage(ability.attack_damage));
  const [dotEffects, setDotEffects] = useState<AbilityDotEffect[]>(() => parseAbilityDotEffects(ability.dot_effects));
  const [attackEffectGroups, setAttackEffectGroups] = useState<AbilityAttackEffectGroup[]>(() => parseAbilityAttackEffectGroups(ability.attack_effect_groups));
  const { data: damageTypes = [] } = useDamageTypes();
  const physicalDamageTypes = damageTypes.filter((type) => type.category === "physical");
  const magicalDamageTypes = damageTypes.filter((type) => type.category === "magical");
  const [oncePerBattle, setOncePerBattle] = useState(Boolean((ability as Ability & { once_per_battle?: boolean }).once_per_battle));
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
    setCustomAttributes(parseCustomAbilityAttributes(ability.custom_attributes));
    setCanActivate(ability.can_activate);
    setToggleMode(ability.toggle_mode);
    setIsMagical(ability.is_magical);
    setAttackEnabled(ability.attack_enabled);
    setAttackDamage(parseAbilityAttackDamage(ability.attack_damage));
    setDotEffects(parseAbilityDotEffects(ability.dot_effects));
    setAttackEffectGroups(parseAbilityAttackEffectGroups(ability.attack_effect_groups));
    setOncePerBattle(Boolean((ability as Ability & { once_per_battle?: boolean }).once_per_battle));
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
    if (canActivate && (!Number.isFinite(cool) || cool < 0)) {
      toast.error("Uma habilidade ativável precisa ter cooldown de 0 ou mais turnos. Marque como não ativável se não puder ser usada.");
      return;
    }
    const effectiveAttackEnabled = canActivate && !selfTargetOnly && !toggleMode && attackEnabled;
    if (toggleMode && (!canActivate || (dotEffects.length > 0))) {
      toast.error("Habilidade sustentada deve ser ativável e não pode ter DoTs de ativação. Use efeitos ao ativar para seus buffs e debuffs.");
      return;
    }
    const needsPhysicalAttackType = attackDamage.damage_kind === "physical" || attackDamage.damage_kind === "hybrid";
    const needsMagicalAttackType = attackDamage.damage_kind === "magical" || attackDamage.damage_kind === "hybrid";
    const selectedPhysicalAttackTypeId = physicalDamageTypes.find((type) => type.id === attackDamage.physical_damage_type_id)?.id
      ?? physicalDamageTypes[0]?.id
      ?? null;
    const selectedMagicalAttackTypeId = magicalDamageTypes.find((type) => type.id === attackDamage.damage_type_id)?.id
      ?? magicalDamageTypes[0]?.id
      ?? null;
    if (effectiveAttackEnabled && needsPhysicalAttackType && !selectedPhysicalAttackTypeId) {
      toast.error("Cadastre ou selecione pelo menos um tipo de dano físico antes de habilitar Atacar.");
      return;
    }
    if (effectiveAttackEnabled && needsMagicalAttackType && !selectedMagicalAttackTypeId) {
      toast.error("Cadastre ou selecione pelo menos um tipo de dano mágico antes de habilitar Atacar.");
      return;
    }
    const canTriggerEndEffects = effects.some((effect) =>
      effect.effect_type !== "healing" || effect.healing_timing === "per_turn"
    );
    if (canActivate && endEffects.length > 0 && !canTriggerEndEffects) {
      toast.error("Efeitos de encerramento precisam de pelo menos um efeito ativo com duração. Uma cura instantânea sozinha não tem duração para encerrar.");
      return;
    }
    const customAttributeKeys = customAttributes.map((attribute) => attribute.key.trim());
    if (customAttributes.some((attribute) =>
      !attribute.name.trim() ||
      !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(attribute.key) ||
      (attribute.type === "number" && !Number.isFinite(Number(attribute.value)))
    ) || new Set(customAttributeKeys).size !== customAttributeKeys.length) {
      toast.error("Revise os atributos extras: cada um precisa de nome, chave API única e valor válido.");
      return;
    }
    const allConfiguredDots = [...dotEffects, ...attackEffectGroups.flatMap((group) => group.dots)];
    if (allConfiguredDots.some((dot) =>
      !dot.name.trim() ||
      !Number.isFinite(dot.duration) || dot.duration < 1 || dot.duration > 1000 ||
      (dot.damage_kind === "physical" && !physicalDamageTypes.some((type) => type.id === dot.physical_damage_type_id)) ||
      (dot.damage_kind === "magical" && (!magicalDamageTypes.some((type) => type.id === dot.damage_type_id) || !["baixa", "media", "alta"].includes(dot.magic_level ?? ""))) ||
      (dot.damage_mode === "attribute" && (!dot.attribute_key || !defs.some((def) => def.key === dot.attribute_key) || !Number.isFinite(dot.attribute_percent) || dot.attribute_percent < 0 || dot.attribute_percent > 1000 || !Number.isFinite(dot.fixed_damage) || dot.fixed_damage < 0 || dot.fixed_damage > 1000000)) ||
      (dot.damage_mode === "percent" && (!Number.isFinite(dot.damage_amount) || dot.damage_amount <= 0 || dot.damage_amount > 1000)) ||
      (dot.damage_mode === "fixed" && (!Number.isInteger(dot.damage_amount) || dot.damage_amount < 1 || dot.damage_amount > 1000000))
    )) {
      toast.error("Revise os DoTs: nome, tipo de dano, cálculo, atributo e duração precisam ser válidos.");
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
      !(effect.healing_reduce_debuff_turns_percent && effect.healing_reduce_debuff_turns_percent > 0) &&
      !(effect.healing_relieve_debuff_percent && effect.healing_relieve_debuff_percent > 0)
    );
    if (hasInvalidHealing) {
      toast.error("Configure pelo menos uma ação em cada efeito de cura.");
      return;
    }
    const hasInvalidDotResistance = allConfiguredEffects.some((effect) =>
      effect.effect_type === "dot_resistance" && (
        !["all", "physical", "magical", "specific"].includes(effect.dot_resistance_scope ?? "all") ||
        !["damage", "duration"].includes(effect.dot_resistance_mode ?? "damage") ||
        !["fixed", "percent"].includes(effect.dot_resistance_value_mode ?? "percent") ||
        !Number.isFinite(Number(effect.dot_resistance_amount ?? effect.amount)) ||
        Number(effect.dot_resistance_amount ?? effect.amount) < 0 ||
        ((effect.dot_resistance_value_mode ?? "percent") === "percent" && Number(effect.dot_resistance_amount ?? effect.amount) > 100) ||
        ((effect.dot_resistance_value_mode ?? "percent") === "fixed" && Number(effect.dot_resistance_amount ?? effect.amount) > 1000000) ||
        ((effect.dot_resistance_scope ?? "all") === "specific" && !(effect.dot_resistance_template_ids ?? []).length)
      )
    );
    if (hasInvalidDotResistance) {
      toast.error("Revise a Resistência a DoTs: selecione os DoTs e configure um valor entre 0 e o limite permitido.");
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
    const db = supabase as any;
    const { error } = await db.from("abilities").update({
      name: name.trim(),
      description: description.trim() || null,
      custom_script_key: customScriptKey || null,
      custom_attributes: customAttributes as unknown as Json,
      can_activate: canActivate,
      toggle_mode: canActivate && toggleMode,
      is_magical: isMagical,
      attack_enabled: effectiveAttackEnabled,
      attack_damage: {
        ...attackDamage,
        attribute_percent: Math.max(0, Math.min(1000, Number(attackDamage.attribute_percent) || 0)),
        fixed_damage: Math.max(0, Math.min(1000000, Number(attackDamage.fixed_damage) || 0)),
        physical_damage_type_id: selectedPhysicalAttackTypeId,
        damage_type_id: selectedMagicalAttackTypeId,
      } as unknown as Json,
      dot_effects: dotEffects.map((dot) => ({
        ...dot,
        name: dot.name.trim(),
        damage_amount: Math.max(0, Math.min(1000000, Number(dot.damage_amount) || 0)),
        attribute_percent: Math.max(0, Math.min(1000, Number(dot.attribute_percent) || 0)),
        fixed_damage: Math.max(0, Math.min(1000000, Number(dot.fixed_damage) || 0)),
        duration: Math.max(1, Math.min(1000, Math.floor(Number(dot.duration) || 1))),
      })) as unknown as Json,
      attack_effect_groups: attackEffectGroups
        .filter((group) => group.name.trim() && (group.effects.length > 0 || group.dots.length > 0))
        .map((group) => ({
          id: group.id,
          name: group.name.trim(),
          chance: Math.max(0, Math.min(100, Math.round(Number(group.chance) || 0))),
          effects: group.effects.map((effect) => ({ ...effect, duration: Math.max(1, effect.duration) })),
          dots: group.dots.map((dot) => ({
            ...dot,
            name: dot.name.trim(),
            damage_amount: Math.max(0, Math.min(1000000, Number(dot.damage_amount) || 0)),
            attribute_percent: Math.max(0, Math.min(1000, Number(dot.attribute_percent) || 0)),
            fixed_damage: Math.max(0, Math.min(1000000, Number(dot.fixed_damage) || 0)),
            duration: Math.max(1, Math.min(1000, Math.floor(Number(dot.duration) || 1))),
          })),
        })) as unknown as Json,
      once_per_battle: canActivate && oncePerBattle,
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
    const { error: syncError } = await db.from("character_abilities")
      .update({ once_per_battle: canActivate && oncePerBattle })
      .eq("ability_id", ability.id);
    if (syncError) {
      toast.error(`Habilidade salva, mas não foi possível sincronizar o limite de uso nas fichas: ${syncError.message}`);
      await qc.invalidateQueries({ queryKey: ["abilities"] });
      await qc.invalidateQueries({ queryKey: ["character-abilities"] });
      onSaved();
      return;
    }
    toast.success("Habilidade salva");
    await qc.invalidateQueries({ queryKey: ["abilities"] });
    await qc.invalidateQueries({ queryKey: ["character-abilities"] });
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
            setCooldown(notActivatable ? "0" : (Number(cooldown) >= 0 ? cooldown : "0"));
            if (notActivatable) setManaCost("0");
          }} />
          Habilidade não ativável
        </label>
        <label className="flex min-h-10 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
          <input type="checkbox" checked={isMagical} onChange={(e) => setIsMagical(e.target.checked)} />
          Habilidade Mágica
        </label>
        {canActivate && (
          <label className="flex min-h-10 items-center gap-2 rounded-md border border-gold/40 px-3 py-2 text-sm">
            <input type="checkbox" checked={toggleMode} onChange={(e) => { setToggleMode(e.target.checked); if (e.target.checked) setAttackEnabled(false); }} />
            <span><strong>Habilidade sustentada (ligar/desligar)</strong><span className="block text-xs text-muted-foreground">Liga os efeitos ao ativar e mantém até desligar; ao desligar, começa a recarga e dispara efeitos de encerramento. Só funciona no combate e sem ataque/DoTs de ativação.</span></span>
          </label>
        )}
        {canActivate && (
          <label className="flex min-h-10 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
            <input type="checkbox" checked={selfTargetOnly} onChange={(e) => setSelfTargetOnly(e.target.checked)} />
            Só pode ser usada no próprio personagem
          </label>
        )}
      </div>
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
            <p className="text-xs text-muted-foreground">
              Exemplo: Força 100, atributo em 100% e dano fixo adicional 20 = 120 de dano base antes da defesa. No combate, o mestre poderá somar dano extra para cada alvo.
            </p>
            <div className="space-y-3 border-t border-border/70 pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="text-sm font-semibold text-gold">Efeitos por chance de acerto</h4>
                  <p className="mt-1 text-xs text-muted-foreground">Crie categorias como 50% de acerto. No popup, o mestre decide separadamente para cada alvo se os efeitos daquela categoria acertaram.</p>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={() => setAttackEffectGroups((current) => [
                  ...current,
                  { id: crypto.randomUUID(), name: "Efeitos", chance: 50, effects: [], dots: [] },
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
                  <AbilityEffectsEditor
                    effects={group.effects}
                    onChange={(next) => setAttackEffectGroups((current) => current.map((entry) => entry.id === group.id ? { ...entry, effects: next } : entry))}
                    permanent={false}
                    title={`Efeitos — ${group.chance}% de acerto`}
                    description="Estes efeitos só são aplicados no alvo quando o mestre marcar esta categoria como acertada no popup do ataque."
                    defs={defs}
                  />
                  <AbilityDotEffectsEditor
                    dots={group.dots}
                    onChange={(dots) => setAttackEffectGroups((current) => current.map((entry) => entry.id === group.id ? { ...entry, dots } : entry))}
                    defs={defs}
                    physicalTypes={physicalDamageTypes}
                    magicalTypes={magicalDamageTypes}
                    title={"DoTs — " + group.chance + "% de acerto"}
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
      <div className="space-y-1.5">
        <Label>Descrição</Label>
        <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="O que a habilidade faz..." />
      </div>
      <div className="space-y-1.5 rounded-md border border-border p-3">
        <Label>Script JavaScript personalizado</Label>
        <select
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={customScriptKey}
          onChange={(e) => {
            const key = e.target.value;
            setCustomScriptKey(key);
            if (key === "demonio_interno" && customAttributes.length === 0) {
              setCustomAttributes(DEMONIO_INTERNO_DEFAULT_ATTRIBUTES.map((attribute) => ({ ...attribute })));
            }
          }}
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
      <div className="space-y-3 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Label>Atributos extras da habilidade</Label>
            <p className="text-xs text-muted-foreground">Valores de configuração acessíveis no script por <code>contexto.atributos.chave</code>. Aceita número, texto e booleano.</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => setCustomAttributes((current) => [...current, {
            key: customAttributeKey("", current.length),
            name: "",
            type: "number",
            value: 0,
          }])}>
            <Plus className="mr-1 h-4 w-4" /> Adicionar atributo
          </Button>
        </div>
        {customAttributes.length === 0 && <p className="text-xs text-muted-foreground">Nenhum atributo extra configurado.</p>}
        {customAttributes.map((attribute, index) => (
          <div key={index} className="grid gap-2 rounded-md border border-border/70 p-3 sm:grid-cols-[minmax(0,1fr)_130px_minmax(0,1fr)_auto] sm:items-end">
            <div className="space-y-1">
              <Label>Nome do atributo</Label>
              <Input value={attribute.name} placeholder="Porcentagem máxima de dano refletido" onChange={(e) => {
                const name = e.target.value;
                setCustomAttributes((current) => current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, name } : item
                ));
              }} />
              <div className="mt-2 space-y-1">
                <Label>Chave da API</Label>
                <Input
                  value={attribute.key}
                  placeholder="minha_chave"
                  onChange={(e) => {
                    const key = e.target.value.replace(/[^a-zA-Z0-9_]/g, "");
                    setCustomAttributes((current) => current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, key } : item
                    ));
                  }}
                />
                <p className="text-[11px] text-muted-foreground">Use esta chave no script em <code>contexto.atributos.{attribute.key || "chave"}</code>.</p>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Tipo</Label>
              <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={attribute.type} onChange={(e) => {
                const type = e.target.value as CustomAbilityAttribute["type"];
                const value = type === "number" ? 0 : type === "boolean" ? false : "";
                setCustomAttributes((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, type, value } : item));
              }}>
                <option value="number">Número</option>
                <option value="string">Texto (string)</option>
                <option value="boolean">Booleano</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>Valor padrão</Label>
              {attribute.type === "boolean" ? (
                <label className="flex h-9 items-center gap-2 rounded-md border border-input px-3 text-sm">
                  <input type="checkbox" checked={attribute.value === true} onChange={(e) => setCustomAttributes((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value: e.target.checked } : item))} />
                  {attribute.value === true ? "Verdadeiro" : "Falso"}
                </label>
              ) : (
                <Input type={attribute.type === "number" ? "number" : "text"} value={String(attribute.value)} onChange={(e) => setCustomAttributes((current) => current.map((item, itemIndex) => {
                  if (itemIndex !== index) return item;
                  return { ...item, value: attribute.type === "number" ? (e.target.value === "" ? 0 : Number(e.target.value)) : e.target.value };
                }))} />
              )}
              {attribute.type === "number" && (
                <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={attribute.scale_with_race !== false && attribute.malefico !== true}
                    disabled={attribute.malefico === true}
                    onChange={(event) => setCustomAttributes((current) => current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, scale_with_race: event.target.checked } : item
                    ))}
                  />
                  <span>
                    Multiplicar com a mecânica racial
                    <span className="mt-0.5 block text-[11px]">Desmarque para valores que representam custos ou penalidades, e não benefícios.</span>
                  </span>
                </label>
              )}
              {attribute.type === "number" && (
                <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" className="mt-0.5" checked={attribute.malefico === true}
                    onChange={(event) => setCustomAttributes((current) => current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, malefico: event.target.checked, scale_with_race: event.target.checked ? false : item.malefico === true ? true : item.scale_with_race } : item
                    ))} />
                  <span>
                    Maléfico
                    <span className="mt-0.5 block text-[11px]">Atributo negativo: a mecânica de duplicar efeitos da virtude ignora este valor.</span>
                  </span>
                </label>
              )}
            </div>
            <Button type="button" variant="ghost" size="icon" aria-label={`Remover atributo ${attribute.name || index + 1}`} onClick={() => setCustomAttributes((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {canActivate && <div className="space-y-1.5"><Label>Cooldown (turnos)</Label><Input type="number" min="0" value={cooldown} onChange={(e) => setCooldown(e.target.value)} /></div>}
        {canActivate && <div className="space-y-1.5">
          <Label>Custo de Mana (0 = não gasta)</Label>
          <Input type="number" min="0" value={manaCost} onChange={(e) => setManaCost(e.target.value)} />
        </div>}
        {canActivate && <div className="sm:col-span-2 rounded-md border border-border p-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={oncePerBattle} onChange={(e) => setOncePerBattle(e.target.checked)} />
            <span>
              <span className="font-medium">Só pode ser usada 1 vez por combate</span>
              <span className="mt-1 block text-xs text-muted-foreground">O uso fica registrado por personagem e por combate. Ao salvar, essa regra também é atualizada nas fichas que já possuem esta habilidade.</span>
            </span>
          </label>
        </div>}
        {!canActivate && <p className="text-xs text-muted-foreground">Esta habilidade não pode ser ativada. Seus efeitos passivos permanecem aplicados enquanto estiver na ficha.</p>}
      </div>
      {canActivate && <AbilityEffectsEditor
        effects={effects}
        onChange={setEffects}
        permanent={false}
        title="Efeitos ao ativar"
        description={toggleMode ? "Enquanto estiver ligada no combate, os efeitos permanecerão ativos sem perder turnos. Desligar remove os efeitos desta ativação." : "Aplicados ao alvo escolhido quando a habilidade for ativada."}
        defs={defs}
      />}
      {canActivate && <AbilityEffectsEditor
        effects={endEffects}
        onChange={setEndEffects}
        permanent={false}
        title="Efeitos quando a habilidade acaba"
        description={toggleMode ? "São aplicados quando a habilidade sustentada for desligada e seus efeitos ativos forem removidos." : "Aplicados ao destino configurado quando todos os efeitos desta ativação terminarem."}
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
