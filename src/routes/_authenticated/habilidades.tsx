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
import { parseAbilityEffects, parseAbilityAttackDamage, parseAbilityAttackEffectGroups, parseAbilityDotEffects, useAbilities, useDamageTypes, useDotTemplates, type Ability, type AbilityEffectDefinition, type AbilityAttackDamageConfig, type AbilityAttackDamageKind, type AbilityAttackEffectGroup, type AbilityDotEffect } from "@/lib/abilities";
import {
  CUSTOM_ABILITY_SCRIPTS,
  DEMONIO_INTERNO_DEFAULT_ATTRIBUTES,
  customAttributeKey,
  parseCustomAbilityAttributes,
  type CustomAbilityAttribute,
} from "@/lib/custom-ability-scripts";
import { useDefs, useMe } from "@/lib/sheets";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import { ContinuousRulesEditor } from "@/components/abilities/ContinuousRulesEditor";
import { SustainedCostsEditor, parseSustainedCosts, validateSustainedCosts, type SustainedCost } from "@/components/abilities/SustainedCostsEditor";
import { parseContinuousRules, type ContinuousRule } from "@/lib/continuous-effects";
import { AbilityDotEffectsEditor } from "@/components/abilities/SheetAbilityAttackEditor";
import { AbilityAttackExecutionEditor } from "@/components/abilities/AbilityAttackExecutionEditor";
import { findRegisteredDotTemplate, registerAbilityDotTemplates } from "@/lib/ability-dot-templates";
import { DefenseIgnoreInputs } from "@/components/abilities/DefenseIgnoreInputs";
import { ZERO_DEFENSE_IGNORE, defenseIgnoreText } from "@/lib/defense-ignore";
import { SummonGrantsEditor } from "@/components/summons/Summons";
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
      name: "Nova habilidade", description: "", is_passive: false, can_activate: true, is_magical: true, self_target_only: false, cooldown_turns: 1, duration_turns: 0, mana_cost: 0, effects: [], passive_effects: [], end_effects: [], dot_effects: [], attack_effect_groups: [], custom_script_key: null, custom_attributes: [],
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
      <div className="grimorio-section-header flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-gold"><WandSparkles className="h-6 w-6" /> Habilidades</h1>
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
  const [customAttributes, setCustomAttributes] = useState<CustomAbilityAttribute[]>(() => parseCustomAbilityAttributes(ability.custom_attributes));
  const [canActivate, setCanActivate] = useState(ability.can_activate);
  const [toggleMode, setToggleMode] = useState(ability.toggle_mode);
  const [sustainCosts, setSustainCosts] = useState<SustainedCost[]>(() => parseSustainedCosts((ability as Ability & { sustain_costs?: unknown }).sustain_costs));
  const [isMagical, setIsMagical] = useState(ability.is_magical);
  const [attackEnabled, setAttackEnabled] = useState(ability.attack_enabled);
  const [attackDamage, setAttackDamage] = useState<AbilityAttackDamageConfig>(() => parseAbilityAttackDamage(ability.attack_damage));
  const [dotEffects, setDotEffects] = useState<AbilityDotEffect[]>(() => parseAbilityDotEffects(ability.dot_effects));
  const [attackEffectGroups, setAttackEffectGroups] = useState<AbilityAttackEffectGroup[]>(() => parseAbilityAttackEffectGroups(ability.attack_effect_groups));
  const { data: damageTypes = [] } = useDamageTypes();
  const { data: dotTemplates = [] } = useDotTemplates();
  const physicalDamageTypes = damageTypes.filter((type) => type.category === "physical");
  const magicalDamageTypes = damageTypes.filter((type) => type.category === "magical");
  const [oncePerBattle, setOncePerBattle] = useState(Boolean((ability as Ability & { once_per_battle?: boolean }).once_per_battle));
  const [selfTargetOnly, setSelfTargetOnly] = useState(ability.self_target_only);
  const [cooldown, setCooldown] = useState(String(ability.cooldown_turns));
  const [duration, setDuration] = useState(String(ability.duration_turns ?? 0));
  const [manaCost, setManaCost] = useState(String(ability.mana_cost));
  const [attackManaCost, setAttackManaCost] = useState(
    ability.attack_mana_cost === null ? "" : String(ability.attack_mana_cost)
  );
  const [effects, setEffects] = useState<AbilityEffectDefinition[]>(() => parseAbilityEffects(ability.effects));
  const [continuousRules,setContinuousRules] = useState<ContinuousRule[]>(() => parseContinuousRules((ability as Ability & { continuous_rules?: unknown }).continuous_rules));
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
    setSustainCosts(parseSustainedCosts((ability as Ability & { sustain_costs?: unknown }).sustain_costs));
    setIsMagical(ability.is_magical);
    setAttackEnabled(ability.attack_enabled);
    setAttackDamage(parseAbilityAttackDamage(ability.attack_damage));
    setDotEffects(parseAbilityDotEffects(ability.dot_effects));
    setAttackEffectGroups(parseAbilityAttackEffectGroups(ability.attack_effect_groups));
    setOncePerBattle(Boolean((ability as Ability & { once_per_battle?: boolean }).once_per_battle));
    setSelfTargetOnly(ability.self_target_only);
    setCooldown(String(ability.cooldown_turns));
    setDuration(String(ability.duration_turns ?? 0));
    setManaCost(String(ability.mana_cost));
    setAttackManaCost(ability.attack_mana_cost === null ? "" : String(ability.attack_mana_cost));
    setEffects(parseAbilityEffects(ability.effects));
    setContinuousRules(parseContinuousRules((ability as Ability & { continuous_rules?: unknown }).continuous_rules));
    setPassiveEffects(parseAbilityEffects(ability.passive_effects));
    setEndEffects(parseAbilityEffects(ability.end_effects));
  }, [ability]);

  async function save() {
    const cool = canActivate ? Math.floor(Number(cooldown)) : 0;
    const activeDuration = canActivate && !toggleMode ? Math.floor(Number(duration)) : 0;
    const mana = Math.floor(Number(manaCost));
    const separateAttackMana = attackManaCost.trim() === "" ? null : Number(attackManaCost);
    if (!name.trim()) { toast.error("Informe o nome da habilidade"); return; }
    const sustainError = validateSustainedCosts(sustainCosts);
    if (canActivate && toggleMode && sustainError) { toast.error(sustainError); return; }
    if (!Number.isInteger(activeDuration) || activeDuration < 0 || activeDuration > 1000) { toast.error("Duração deve ser de 0 a 1000 turnos."); return; }
    if (!Number.isFinite(mana) || mana < 0) { toast.error("O custo de Mana não pode ser negativo"); return; }
    if (separateAttackMana !== null && (!Number.isInteger(separateAttackMana) || separateAttackMana < 0 || separateAttackMana > 1000000)) {
      toast.error("O custo de Mana de Atacar deve ser um número inteiro entre 0 e 1.000.000.");
      return;
    }
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
      !findRegisteredDotTemplate(dot, dotTemplates) ||
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
      continuous_rules: continuousRules as unknown as Json,
      can_activate: canActivate,
      toggle_mode: canActivate && toggleMode,
      sustain_costs: canActivate && toggleMode ? sustainCosts : [],
      is_magical: isMagical,
      attack_enabled: effectiveAttackEnabled,
      attack_damage: {
        ...attackDamage,
        attribute_percent: Math.max(0, Math.min(1000, Number(attackDamage.attribute_percent) || 0)),
        fixed_damage: Math.max(0, Math.min(1000000, Number(attackDamage.fixed_damage) || 0)),
        physical_damage_type_id: selectedPhysicalAttackTypeId,
        damage_type_id: selectedMagicalAttackTypeId,
      } as unknown as Json,
      dot_effects: registerAbilityDotTemplates(dotEffects, dotTemplates).map((dot) => ({
        ...dot,
        name: dot.name.trim(),
        damage_amount: Math.max(0, Math.min(1000000, Number(dot.damage_amount) || 0)),
        attribute_percent: Math.max(0, Math.min(1000, Number(dot.attribute_percent) || 0)),
        fixed_damage: Math.max(0, Math.min(1000000, Number(dot.fixed_damage) || 0)),
        duration: Math.max(1, Math.min(1000, Math.floor(Number(dot.duration) || 1))),
      })) as unknown as Json,
      attack_effect_groups: attackEffectGroups
        .filter((group) => group.name.trim() && (group.effects.length > 0 || group.dots.length > 0 || !!defenseIgnoreText(group.defense_ignore)))
        .map((group) => ({
          id: group.id,
          name: group.name.trim(),
          chance: Math.max(0, Math.min(100, Math.round(Number(group.chance) || 0))),
          effects: group.effects.map((effect) => ({ ...effect, duration: Math.max(1, effect.duration) })),
          defense_ignore: group.defense_ignore,
          dots: registerAbilityDotTemplates(group.dots, dotTemplates).map((dot) => ({
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
      duration_turns: activeDuration,
      mana_cost: canActivate ? mana : 0,
      attack_mana_cost: canActivate ? separateAttackMana : null,
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
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label>Nome da habilidade</Label>
          <Input className="w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome da habilidade" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <label className="flex min-h-10 min-w-0 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
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
          <label className="flex min-h-10 min-w-0 items-start gap-3 rounded-md border border-gold/40 px-3 py-2 text-sm sm:col-span-2 xl:col-span-2">
            <input className="mt-1 shrink-0" type="checkbox" checked={toggleMode} onChange={(e) => { setToggleMode(e.target.checked); if (e.target.checked) setAttackEnabled(false); }} />
            <span className="min-w-0"><strong className="block">Habilidade sustentada (ligar/desligar)</strong><span className="mt-1 block text-xs text-muted-foreground">Liga os efeitos ao ativar e mantém até desligar; ao desligar, começa a recarga e dispara efeitos de encerramento. Só funciona no combate e sem ataque/DoTs de ativação.</span></span>
          </label>
        )}
        {canActivate && toggleMode && (
          <div className="sm:col-span-2 xl:col-span-3">
            <SustainedCostsEditor value={sustainCosts} onChange={setSustainCosts} />
          </div>
        )}
        {canActivate && (
          <label className="flex min-h-10 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
            <input type="checkbox" checked={selfTargetOnly} onChange={(e) => setSelfTargetOnly(e.target.checked)} />
            Só pode ser usada no próprio personagem
          </label>
        )}
        </div>
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
            <AbilityAttackExecutionEditor value={attackDamage} onChange={setAttackDamage} disabled={busy}/>
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
        {canActivate && !toggleMode && <div className="space-y-1.5">
          <Label>Duração da habilidade (turnos, 0 = instantânea)</Label>
          <Input type="number" min="0" max="1000" value={duration} onChange={(e) => setDuration(e.target.value)} />
          <p className="text-xs text-muted-foreground">Se tiver duração, o cooldown só começa quando ela terminar. O contador diminui a cada avanço de turno.</p>
        </div>}
        {canActivate && <div className="space-y-1.5">
          <Label>Custo de Mana para Ativar (0 = não gasta)</Label>
          <Input type="number" min="0" value={manaCost} onChange={(e) => setManaCost(e.target.value)} />
        </div>}
        {canActivate && !toggleMode && !selfTargetOnly && attackEnabled && (
          <div className="space-y-1.5">
            <Label>Custo de Mana para Atacar (opcional)</Label>
            <Input type="number" min="0" max="1000000" step="1" value={attackManaCost}
              placeholder="Mesmo custo de Ativar"
              onChange={(event) => setAttackManaCost(event.target.value)} />
            <p className="text-xs text-muted-foreground">
              Em branco: usa {manaCost || "0"} Mana (mesmo custo de Ativar). Valor 0: Atacar não gasta Mana. 
              Este custo é cobrado uma vez por sequência de ataque, mesmo sem acertar ninguém.
            </p>
          </div>
        )}
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
      {canActivate && <ContinuousRulesEditor rules={continuousRules} onChange={setContinuousRules} defs={defs} disabled={busy}/>}
      {canActivate && <AbilityEffectsEditor
        allowActivationCustomization
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
      {canActivate && <SummonGrantsEditor abilityId={ability.id} master />}
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Button disabled={busy} onClick={() => void save()}>{busy ? "Salvando..." : isNew ? "Salvar nova habilidade" : "Salvar habilidade"}</Button>
        <Button disabled={busy} variant="destructive" onClick={() => void remove()}><Trash2 className="mr-1 h-4 w-4" /> Excluir</Button>
      </div>
    </section>
  );
}
