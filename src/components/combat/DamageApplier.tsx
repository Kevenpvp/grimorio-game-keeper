import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HeartPulse, Shield, Sparkles, Swords, Zap, Plus, Trash2, CheckCircle2, Dumbbell, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import { DefenseIgnoreInputs } from "@/components/abilities/DefenseIgnoreInputs";
import { applyAbilityTargetDamage, isValidAbilityTargetAdjustment } from "@/lib/ability-attack-damage";
import { defenseIgnoreText, ZERO_DEFENSE_IGNORE, type DefenseIgnore } from "@/lib/defense-ignore";
import { passiveStatusModifiers, statusEffectModifiers, useCharacterAbilities, useCharacterActiveEffects, type AbilityEffectDefinition, useDotTemplates } from "@/lib/abilities";
import { clampNonDefenseAttribute, computeValue, conditionAdjustedValue, physicalAttributePoints, useCharacter, useCharacterTraitMods, useClasses, useDefs, useRaces, useVirtues } from "@/lib/sheets";
import type { Json } from "@/integrations/supabase/types";
import { parseWeaponDamage, weaponDamageSummary, type WeaponDamageConfig } from "@/lib/inventory";

type DamageKind = "physical" | "magical" | "hybrid" | "true";
type MagicLevel = "baixa" | "media" | "alta";
type DamageType = { id: string; name: string; category: "physical" | "magical" };

export type DamageTarget = { id: string; name: string };
type DamageSource = { id: string; name: string };
type ManualDotDraft = { templateId: string; damageMode: "fixed" | "percent"; amount: string; duration: string };
export function DamageApplier({ target, battleId = null, sources = [], defaultSourceCharacterId = null, onDamageApplied }: {
  target: DamageTarget;
  battleId?: string | null;
  sources?: DamageSource[];
  defaultSourceCharacterId?: string | null;
  onDamageApplied?: (result: { targetId: string; totalDamage: number; hpBefore: number; hpAfter: number }) => void;
}) {
  const qc = useQueryClient();
  const [damageMode, setDamageMode] = useState<"repeat" | "list">("repeat");
  const [damageKind, setDamageKind] = useState<DamageKind>("physical");
  const [damageValue, setDamageValue] = useState("20");
  const [repeatCount, setRepeatCount] = useState("1");
  const [damageList, setDamageList] = useState("50, 35, 45, 86, 20, 10, 50");
  const [damageTypeId, setDamageTypeId] = useState("");
  const [physicalDamageTypeId, setPhysicalDamageTypeId] = useState("");
  const [magicLevel, setMagicLevel] = useState<MagicLevel>("baixa");
  const [sourceCharacterId, setSourceCharacterId] = useState(defaultSourceCharacterId ?? "");
  const [weaponInventoryItemId, setWeaponInventoryItemId] = useState("");
  const [outsideTargetMode, setOutsideTargetMode] = useState<"none" | "hit" | "miss">("none");
  const [criticalDamage, setCriticalDamage] = useState(false);
  const [lastDamageOutcome, setLastDamageOutcome] = useState<{
    criticalRequested: boolean;
    criticalConfirmed: boolean;
    damage: number;
    hpBefore: number;
    hpAfter: number;
    hits: number[];
    criticalRawHits: number[];
  } | null>(null);
  const [extraDamageFixed, setExtraDamageFixed] = useState("0");
  const [extraDamagePercent, setExtraDamagePercent] = useState("0");
  const [defenseIgnore, setDefenseIgnore] = useState<DefenseIgnore>({ ...ZERO_DEFENSE_IGNORE });
  const [applyingDamage, setApplyingDamage] = useState(false);
  const [effects, setEffects] = useState<AbilityEffectDefinition[]>([]);
  const [dots, setDots] = useState<ManualDotDraft[]>([]);
  const [selectedDotTemplateId, setSelectedDotTemplateId] = useState("");
  const [applyingEffectsOnly, setApplyingEffectsOnly] = useState(false);
  const { data: defs = [] } = useDefs();
  const { data: dotTemplates = [], isLoading: loadingDotTemplates } = useDotTemplates();
  // Use the same attribute building blocks as the character sheet and combat
  // cards. The selected attacker, not the target, provides these quick values.
  const sourceId = sourceCharacterId || undefined;
  const { data: equippedWeapons = [], isLoading: loadingWeapons } = useQuery<Array<{
    id: string; name: string; weapon_damage: WeaponDamageConfig; ammo_current: number | null;
  }>>({
    queryKey: ["equipped-weapons-for-damage", sourceId],
    enabled: !!sourceId,
    refetchInterval: 15000,
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("character_inventory")
        .select("id,ammo_current,item_templates(name,item_type,weapon_damage)")
        .eq("character_id", sourceId!).eq("equipped", true);
      if (error) throw error;
      return (data ?? []).flatMap((entry: { id: string; ammo_current: number | null; item_templates: unknown }) => {
        const template = entry.item_templates as unknown as {
          name: string; item_type: string; weapon_damage: unknown;
        } | null;
        return template?.item_type === "weapon"
          ? [{ id: entry.id, name: template.name, weapon_damage: parseWeaponDamage(template.weapon_damage), ammo_current: entry.ammo_current }]
          : [];
      });
    },
  });
  const selectedWeapon = equippedWeapons.find((item) => item.id === weaponInventoryItemId) ?? null;
  const plannedHits = damageMode === "repeat" ? Number(repeatCount) : damageList.split(/[,;\s]+/).filter(Boolean).length;
  const availableAmmo = selectedWeapon?.weapon_damage.uses_ammo ? Math.max(0, selectedWeapon.ammo_current ?? 0) : null;
  const ammoInsufficient = availableAmmo !== null && (!Number.isInteger(plannedHits) || plannedHits > availableAmmo);
  const { data: sourceSheet, isPending: sourceSheetLoading, error: sourceSheetError } = useCharacter(sourceId);
  const source = sourceSheet?.character;
  const sourceAttributes = sourceSheet?.attrs ?? [];
  const sourceTraits = useCharacterTraitMods(
    source?.race_id, source?.virtue_id, source?.class_id, source?.class_custom_modifiers,
  );
  const racesQuery = useRaces();
  const virtuesQuery = useVirtues();
  const classesQuery = useClasses();
  const { data: sourceAbilities, isPending: sourceAbilitiesLoading, error: sourceAbilitiesError } = useCharacterAbilities(sourceId);
  const { data: sourceEffects, isPending: sourceEffectsLoading, error: sourceEffectsError } = useCharacterActiveEffects(sourceId);
  // Never show a misleading base attribute while a trait's modifiers are still loading.
  const sourceTraitsLoading = Boolean(source && (
    (source.race_id && racesQuery.isPending) ||
    (source.virtue_id && virtuesQuery.isPending) ||
    (source.class_id && classesQuery.isPending)
  ));
  const sourceStatsLoading = Boolean(sourceId) && (sourceSheetLoading || sourceAbilitiesLoading || sourceEffectsLoading || sourceTraitsLoading);
  const sourceStatsError = sourceSheetError ?? sourceAbilitiesError ?? sourceEffectsError ??
    (source?.race_id ? racesQuery.error : null) ??
    (source?.virtue_id ? virtuesQuery.error : null) ??
    (source?.class_id ? classesQuery.error : null);

  function effectiveSourceStat(key: "strength" | "mag_dmg"): number | null {
    if (!sourceId || !source || !sourceSheet || sourceStatsLoading || sourceStatsError) return null;
    const def = defs.find((item) => item.key === key);
    if (!def || !sourceAttributes.some((item) => item.attribute_key === key)) return null;
    const attr = sourceAttributes.find((item) => item.attribute_key === key);
    const traitPoints = sourceTraits.mods[key] ?? 0;
    const base = def.accepts_points
      ? computeValue(def, (attr?.points ?? 0) + traitPoints + physicalAttributePoints(source, key)) + Number(attr?.bonus ?? 0)
      : Number(attr?.max_value ?? 0) + traitPoints + Number(attr?.bonus ?? 0);
    const active = statusEffectModifiers(sourceEffects, key);
    const passive = passiveStatusModifiers(sourceAbilities)[key] ?? { fixed: 0, percent: 0 };
    const adjusted = Math.floor((base + active.fixed + passive.fixed) * (1 + (active.percent + passive.percent) / 100));
    const effective = conditionAdjustedValue(source, key, clampNonDefenseAttribute(key, adjusted));
    return Number.isFinite(effective) ? effective : null;
  }

  const sourceStrength = effectiveSourceStat("strength");
  const sourceMagicDamage = effectiveSourceStat("mag_dmg");
  function fillDamageFromStat(key: "strength" | "mag_dmg") {
    const value = key === "strength" ? sourceStrength : sourceMagicDamage;
    if (value === null) {
      toast.error("Não foi possível carregar o atributo de quem está causando o dano.");
      return;
    }
    if (value < 0 || value > 1_000_000) {
      toast.error("O atributo está fora do intervalo permitido para dano bruto (0 a 1000000).");
      return;
    }
    setDamageMode("repeat");
    setDamageValue(String(value));
    toast.success((key === "strength" ? "Força" : "Dano Mágico") + " de " + (source.name ?? "atacante") + " preenchido: " + value + ".");
  }
  useEffect(() => {
    if (defaultSourceCharacterId) {
      setSourceCharacterId(defaultSourceCharacterId);
      setWeaponInventoryItemId("");
    }
  }, [defaultSourceCharacterId]);
  useEffect(() => {
    if (!dotTemplates.some((template) => template.id === selectedDotTemplateId)) {
      setSelectedDotTemplateId(dotTemplates[0]?.id ?? "");
    }
  }, [dotTemplates, selectedDotTemplateId]);

  const { data: damageTypes = [], isLoading: loadingTypes, error: typesError } = useQuery({
    queryKey: ["damage-types"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("damage_types").select("id,name,category").order("name");
      if (error) throw error;
      return data as DamageType[];
    },
  });

  const magicalDamageTypes = damageTypes.filter((type) => type.category === "magical");
  const physicalDamageTypes = damageTypes.filter((type) => type.category === "physical");
  const effectiveDamageKind = selectedWeapon?.weapon_damage.damage_kind ?? damageKind;
  const needsMagic = effectiveDamageKind === "magical" || effectiveDamageKind === "hybrid";
  const needsPhysical = effectiveDamageKind === "physical" || effectiveDamageKind === "hybrid";
  const selectedPhysicalDamageTypeId = physicalDamageTypes.some((type) => type.id === physicalDamageTypeId)
    ? physicalDamageTypeId
    : physicalDamageTypes[0]?.id ?? "";
  const selectedMagicDamageTypeId = magicalDamageTypes.some((type) => type.id === damageTypeId)
    ? damageTypeId
    : magicalDamageTypes[0]?.id ?? "";
  const damageKindName = {
    physical: "Físico",
    magical: "Mágico",
    hybrid: "Híbrido",
    true: "Verdadeiro",
  }[damageKind];

  function payloadDots(): Array<Record<string, unknown>> {
    return dots.flatMap((dot) => {
      const template = dotTemplates.find((item) => item.id === dot.templateId);
      if (!template) return [];
      const amount = Number(dot.amount);
      const duration = Math.floor(Number(dot.duration));
      const max = dot.damageMode === "percent" ? 1000 : 1000000;
      if (!Number.isFinite(amount) || amount <= 0 || amount > max || (dot.damageMode === "fixed" && !Number.isInteger(amount))) {
        throw new Error("Informe um valor válido para o DoT " + template.name + ".");
      }
      if (!Number.isInteger(duration) || duration < 1 || duration > 1000) throw new Error("A duração do DoT " + template.name + " precisa ficar entre 1 e 1000 turnos.");
      return [{
        id: template.id, template_id: template.id, name: template.name, damage_kind: template.damage_kind,
        physical_damage_type_id: template.physical_damage_type_id, damage_type_id: template.damage_type_id,
        magic_level: template.magic_level, damage_mode: dot.damageMode, damage_amount: amount, duration,
      }];
    });
  }

  async function applyConfiguredEffects(sourceOverride?: string | null) {
    if (!effects.length && !dots.length) {
      toast.error("Adicione pelo menos um efeito ou DoT primeiro.");
      return false;
    }
    let dotPayload: Array<Record<string, unknown>>;
    try { dotPayload = payloadDots(); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); return false; }
    const sourceId = (sourceOverride ?? sourceCharacterId) || null;
    const { data, error } = await supabase.rpc("apply_manual_character_effects", {
      _character_id: target.id,
      ...(battleId ? { _battle_id: battleId } : {}),
      ...(sourceId ? { _source_character_id: sourceId } : {}),
      _effects: effects as unknown as Json,
      _dots: dotPayload as unknown as Json,
      _permanent: false,
    });
    if (error) throw error;
    const count = Number(data ?? 0);
    if (count < 1) {
      toast.info("Nenhum efeito foi aplicado. Confira as imunidades a DoTs e os alvos.");
    } else {
      toast.success(String(count) + " efeito(s)/DoT(s) temporário(s) aplicado(s) em " + target.name + ".");
    }
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["battle-effects"] }),
      qc.invalidateQueries({ queryKey: ["character-active-effects"] }),
      ...(sourceId ? [qc.invalidateQueries({ queryKey: ["character", sourceId] })] : []),
      qc.invalidateQueries({ queryKey: ["battles"] }),
      qc.invalidateQueries({ queryKey: ["character", target.id] }),
      qc.invalidateQueries({ queryKey: ["characters"] }),
      qc.invalidateQueries({ queryKey: ["my-character"] }),
      qc.invalidateQueries({ queryKey: ["manual-sheet-effects", target.id] }),
    ]);
    return true;
  }

  async function applyEffectsOnly() {
    setApplyingEffectsOnly(true);
    try { await applyConfiguredEffects(); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setApplyingEffectsOnly(false); }
  }

  async function applyDamage(sourceOverride?: string | null) {
    let values: number[];
    if (damageMode === "repeat") {
      const amount = Number(damageValue);
      const count = Number(repeatCount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1000000 ||
          !Number.isInteger(count) || count < 1 || count > 200) {
        setCriticalDamage(false);
        toast.error("Informe um dano válido e uma quantidade de 1 a 200 golpes");
        return;
      }
      values = Array.from({ length: count }, () => amount);
    } else {
      const parts = damageList.split(/[,;\s]+/).filter(Boolean);
      values = parts.map(Number);
      if (values.length < 1 || values.length > 200 ||
          values.some((n) => !Number.isFinite(n) || n < 0 || n > 1000000)) {
        setCriticalDamage(false);
        toast.error("Informe de 1 a 200 danos válidos, separados por vírgula");
        return;
      }
    }
    if (selectedWeapon?.weapon_damage.uses_ammo && values.length > (selectedWeapon.ammo_current ?? 0)) {
      toast.error("Munição insuficiente: " + (selectedWeapon.ammo_current ?? 0) + " disponível(is), " + values.length + " necessária(s).");
      setCriticalDamage(false);
      return;
    }
    if (outsideTargetMode !== "none") {
      const attackerId = (sourceOverride ?? sourceCharacterId) || null;
      if (!battleId || !attackerId) {
        toast.error("Para registrar um ataque fora do sistema, selecione uma batalha e o atacante.");
        return;
      }
      setApplyingDamage(true);
      setLastDamageOutcome(null);
      try {
        const { data, error } = await (supabase as any).rpc("register_unregistered_attack", {
          _battle_id: battleId,
          _attacker_id: attackerId,
          _weapon_inventory_item_id: selectedWeapon?.id ?? null,
          _character_ability_id: null,
          _hit_confirmed: outsideTargetMode === "hit",
          _hit_count: values.length,
        });
        if (error) throw error;
        const result = data as {
          ammo_used?: number;
          ammo_after?: number | null;
          peste_reset?: number;
          peste_healing?: { last_heal_percent?: number; next_heal_percent?: number };
        } | null;
        toast.success(outsideTargetMode === "hit"
          ? `Acerto externo registrado: ${values.length} golpe(s). Nenhum inimigo do site recebeu dano.${result?.peste_healing ? ` Cura da Peste: ${result.peste_healing.last_heal_percent}% no atacante; próximo ${result.peste_healing.next_heal_percent}%.` : ""}`
          : `Ataque sem acerto registrado: ${values.length} golpe(s). Nenhum HP de inimigo foi alterado.`,
          { duration: 8000 });
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["character-abilities", attackerId] }),
          qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
          qc.invalidateQueries({ queryKey: ["character", attackerId] }),
          qc.invalidateQueries({ queryKey: ["equipped-weapons-for-damage", attackerId] }),
          qc.invalidateQueries({ queryKey: ["inventory", attackerId] }),
          qc.invalidateQueries({ queryKey: ["battles"] }),
        ]);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Não foi possível registrar o ataque sem alvo.");
      } finally {
        setApplyingDamage(false);
      }
      return;
    }
    const adjustmentFixed = Number(extraDamageFixed);
    const adjustmentPercent = Number(extraDamagePercent);
    if (!isValidAbilityTargetAdjustment(adjustmentFixed, adjustmentPercent)) {
      toast.error("Ajuste fixo deve ser inteiro entre -1.000.000 e +1.000.000; percentual entre -100% e +1000%.");
      return;
    }
    // Each hit uses its own raw value, even in list mode. Damage bonuses from
    // the source and armor/mitigation are still calculated on the server.
    values = values.map((value) => applyAbilityTargetDamage(value, adjustmentFixed, adjustmentPercent));

    if (!selectedWeapon && needsMagic && !selectedMagicDamageTypeId) {
      setCriticalDamage(false);
      toast.error("Selecione um tipo de dano mágico");
      return;
    }
    if (!selectedWeapon && needsPhysical && physicalDamageTypes.length > 0 && !selectedPhysicalDamageTypeId) {
      setCriticalDamage(false);
      toast.error("Selecione um tipo de dano físico");
      return;
    }
    if (!selectedWeapon && loadingTypes && (needsMagic || needsPhysical)) {
      setCriticalDamage(false);
      toast.error("Aguarde o carregamento dos tipos de dano");
      return;
    }

    const criticalDamageForThisHit = criticalDamage;
    setLastDamageOutcome(null);
    const effectiveSourceCharacterId = (sourceOverride ?? sourceCharacterId) || null;
    setApplyingDamage(true);
    try {
      const { data: runtimeResponse, error } = await supabase.functions.invoke("ability-runtime", {
        body: {
          action: "apply_damage",
          battle_id: battleId,
          _battle_id: battleId,
          _character_id: target.id,
          _damage_kind: effectiveDamageKind,
          _weapon_inventory_item_id: selectedWeapon?.id ?? null,
          _damage_type_id: needsMagic ? (selectedWeapon?.weapon_damage.damage_type_id ?? selectedMagicDamageTypeId) : null,
          _physical_damage_type_id: needsPhysical ? (selectedWeapon?.weapon_damage.physical_damage_type_id ?? (physicalDamageTypes.length > 0 ? selectedPhysicalDamageTypeId : null)) : null,
          _damage_values: values,
          _magic_level: needsMagic ? (selectedWeapon?.weapon_damage.magic_level ?? magicLevel) : null,
          _source_character_id: effectiveSourceCharacterId,
          _critical_damage: criticalDamageForThisHit,
          _defense_ignore: effectiveDamageKind === "true" ? ZERO_DEFENSE_IGNORE : defenseIgnore,
        },
      });
      if (error) {
        let message = error.message;
        const errorContext = (error as { context?: unknown }).context;
        if (errorContext instanceof Response) {
          try {
            const responseBody = await errorContext.clone().json() as { error?: unknown; message?: unknown };
            const serverMessage = typeof responseBody.error === "string"
              ? responseBody.error
              : typeof responseBody.message === "string" ? responseBody.message : null;
            if (serverMessage) message = serverMessage;
          } catch {
            // Keep the SDK message if the error response has no JSON body.
          }
        }
        toast.error(message, { duration: 10000 });
        return;
      }

      const result = (runtimeResponse as { damage_result?: {
        weapon_name?: string;
        weapon_bonus_mode?: "fixed" | "percent";
        weapon_bonus_amount?: number;
        weapon_raw_damage_by_hit?: number[];
        ammo_before?: number;
        ammo_after?: number;
        ammo_max?: number;
        ammo_used?: number;
        florin_bleed?: { applied: boolean; damage: number; mode: string; duration: number };
        peste_reset?: number;
        peste_healing?: {
          applied: boolean;
          hits: number;
          first_heal_percent: number;
          last_heal_percent: number;
          next_heal_percent: number;
          stacks: number;
          attacker_hp_before: number;
          attacker_hp_after: number;
          target_hp_before: number;
          target_hp_after: number;
        };
        hits: number;
        physical_defense: number;
        magical_defense: number;
        total_damage: number;
        hp_before: number;
        hp_after: number;
        final_damage_by_hit?: number[];
        custom_script_hooks?: { processed: number; errors: string[] };
        damage_fixed_modifier?: number;
        damage_percent_modifier?: number;
        damage_source_character_id?: string | null;
        damage_any_fixed_modifier?: number;
        damage_any_percent_modifier?: number;
        damage_physical_fixed_modifier?: number;
        damage_physical_percent_modifier?: number;
        damage_magical_fixed_modifier?: number;
        damage_magical_percent_modifier?: number;
        physical_reduction_fixed?: number;
        physical_reduction_percent?: number;
        magical_reduction_fixed?: number;
        magical_reduction_percent?: number;
        critical_damage?: boolean;
        critical_before_defense?: boolean;
        critical_raw_damage_by_hit?: number[];
      } } | null)?.damage_result;
      if (!result) {
        toast.error("O servidor não retornou o resultado do dano.");
        return;
      }
      let defenseText: string;
      if (effectiveDamageKind === "true") defenseText = "defesas ignoradas";
      else if (effectiveDamageKind === "physical") defenseText = `Defesa física: ${result.physical_defense}`;
      else if (effectiveDamageKind === "magical") defenseText = `Defesa mágica: ${result.magical_defense}; magia ${magicLevel}`;
      else defenseText = `Defesa física: ${result.physical_defense}; Defesa mágica: ${result.magical_defense}; magia ${magicLevel}`;

      const magicTypeName = magicalDamageTypes.find((type) => type.id === selectedMagicDamageTypeId)?.name ?? "mágico";
      const physicalTypeName = physicalDamageTypes.find((type) => type.id === selectedPhysicalDamageTypeId)?.name ?? "físico";
      const damageDescription = effectiveDamageKind === "hybrid"
        ? `dano híbrido (físico: ${physicalTypeName}; mágico: ${magicTypeName})`
        : effectiveDamageKind === "magical"
          ? `dano mágico (${magicTypeName})`
          : effectiveDamageKind === "true"
            ? "dano verdadeiro"
            : physicalDamageTypes.length > 0
              ? `dano físico (${physicalTypeName})`
              : "dano físico";
      const sourceName = sources.find((source) => source.id === effectiveSourceCharacterId)?.name;
      const hitSummary = result.final_damage_by_hit?.length
        ? " Dano final por golpe: " + result.final_damage_by_hit.join(", ") + "."
        : "";
      const fixedModifier = Number(result.damage_fixed_modifier ?? 0);
      const percentModifier = Number(result.damage_percent_modifier ?? 0);
      const signed = (value: number) => `${value >= 0 ? "+" : ""}${value}`;
      const anyFixed = Number(result.damage_any_fixed_modifier ?? 0);
      const anyPercent = Number(result.damage_any_percent_modifier ?? 0);
      const physicalFixed = Number(result.damage_physical_fixed_modifier ?? 0);
      const physicalPercent = Number(result.damage_physical_percent_modifier ?? 0);
      const magicalFixed = Number(result.damage_magical_fixed_modifier ?? 0);
      const magicalPercent = Number(result.damage_magical_percent_modifier ?? 0);
      const sourceSummary = !effectiveSourceCharacterId
        ? ""
        : effectiveDamageKind === "hybrid"
          ? ` Origem: ${sourceName ?? "personagem selecionado"}; metade física: ${signed(anyFixed + physicalFixed)} fixos, ${signed(anyPercent + physicalPercent)}%; metade mágica: ${signed(anyFixed + magicalFixed)} fixos, ${signed(anyPercent + magicalPercent)}%.`
          : ` Origem: ${sourceName ?? "personagem selecionado"}; modificadores de dano: ${signed(fixedModifier)} fixos, ${signed(percentModifier)}%.`;
      const physicalReductionFixed = Number(result.physical_reduction_fixed ?? 0);
      const physicalReductionPercent = Number(result.physical_reduction_percent ?? 0);
      const magicalReductionFixed = Number(result.magical_reduction_fixed ?? 0);
      const magicalReductionPercent = Number(result.magical_reduction_percent ?? 0);
      const reductionPart = (label: string, fixed: number, percent: number) =>
        fixed === 0 && percent === 0 ? "" : ` ${label}: -${fixed} fixos, -${percent}%.`;
      const reductionSummary = effectiveDamageKind === "physical"
        ? reductionPart("Mitigação física recebida", physicalReductionFixed, physicalReductionPercent)
        : effectiveDamageKind === "magical"
          ? reductionPart(`Mitigação mágica recebida para ${magicTypeName} / grau ${magicLevel}`, magicalReductionFixed, magicalReductionPercent)
          : effectiveDamageKind === "hybrid"
            ? reductionPart("Mitigação da metade física", physicalReductionFixed, physicalReductionPercent)
              + reductionPart(`Mitigação da metade mágica (${magicTypeName}, grau ${magicLevel})`, magicalReductionFixed, magicalReductionPercent)
            : "";
      const criticalConfirmed = result.critical_damage === true && result.critical_before_defense === true;
      setLastDamageOutcome({
        criticalRequested: criticalDamageForThisHit,
        criticalConfirmed,
        damage: Number(result.total_damage ?? 0),
        hpBefore: Number(result.hp_before ?? 0),
        hpAfter: Number(result.hp_after ?? 0),
        hits: result.final_damage_by_hit ?? [],
        criticalRawHits: result.critical_raw_damage_by_hit ?? [],
      });
      if (criticalDamageForThisHit && !criticalConfirmed) {
        toast.error("O servidor não confirmou a aplicação do crítico ×2; confira o dano final.", { duration: 10000 });
      }
      const criticalSummary = criticalConfirmed ? "⚔️ DANO CRÍTICO ×2 aplicado. " : "";
      const manualDamageSummary = adjustmentFixed || adjustmentPercent
        ? ` Ajuste por golpe: ${adjustmentFixed >= 0 ? "+" : ""}${adjustmentFixed} fixo, ${adjustmentPercent >= 0 ? "+" : ""}${adjustmentPercent}%.` : "";
      const penetrationSummary = effectiveDamageKind !== "true" && defenseIgnoreText(defenseIgnore)
        ? ` Defesa ignorada: ${defenseIgnoreText(defenseIgnore)}.` : "";
      const florinSummary = result.florin_bleed?.applied
        ? ` 🌹 Lágrimas das pétalas: Sangramento de ${result.florin_bleed.damage}${result.florin_bleed.mode === "percent" ? "% do HP máximo" : " HP"} por turno durante ${result.florin_bleed.duration} turnos aplicado; preparação consumida.`
        : "";
      const pesteResetSummary = Number(result.peste_reset ?? 0) > 0
        ? " ☣️ Cura da Peste: acúmulos reiniciados para 0/99 (próximo golpe: 1%) por atacar sem as luvas."
        : "";
      const pesteSummary = result.peste_healing?.applied
        ? ` ☣️ Cura da Peste: ${result.peste_healing.hits} golpe(s) com cura Normal · Baixa; ${result.peste_healing.first_heal_percent}% → ${result.peste_healing.last_heal_percent}% do HP máximo em ambos. HP do usuário: ${result.peste_healing.attacker_hp_before} → ${result.peste_healing.attacker_hp_after}; HP do alvo após a cura: ${result.peste_healing.target_hp_after}. Acúmulos: ${result.peste_healing.stacks}/99; próximo golpe: ${result.peste_healing.next_heal_percent}%.`
        : "";
      const weaponSummary = result.weapon_name
        ? ` Arma: ${result.weapon_name} · +${Number(result.weapon_bonus_amount ?? 0)}${result.weapon_bonus_mode === "percent" ? "%" : " fixos"} por golpe (antes da defesa).`
        : "";
      const ammoSummary = result.ammo_after !== undefined
        ? " Munição: " + result.ammo_before + " → " + result.ammo_after + "/" + result.ammo_max + " (" + result.ammo_used + " consumida(s))."
        : "";
      toast.success(
        `${criticalSummary}${target.name}: ${result.hits} golpe(s) de ${damageDescription}; ${defenseText}; ${result.total_damage} de dano total. HP: ${result.hp_before} → ${result.hp_after}.${manualDamageSummary}${penetrationSummary}${sourceSummary}${reductionSummary}${weaponSummary}${ammoSummary}${florinSummary}${pesteSummary}${pesteResetSummary}${hitSummary}`,
        { duration: 8000 },
      );
      onDamageApplied?.({ targetId: target.id, totalDamage: result.total_damage, hpBefore: result.hp_before, hpAfter: result.hp_after });
      const hookErrors = result.custom_script_hooks?.errors ?? [];
      if (hookErrors.length > 0) {
        toast.error("Dano aplicado, mas houve falha em script customizado: " + hookErrors[0], { duration: 8000 });
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["battles"] }),
        qc.invalidateQueries({ queryKey: ["florin-petals", battleId] }),
        qc.invalidateQueries({ queryKey: ["character", target.id] }),
        qc.invalidateQueries({ queryKey: ["characters"] }),
        qc.invalidateQueries({ queryKey: ["my-character"] }),
        // Damage can change Demônio Interno heat on both the target (received_dano)
        // and the source (causou_dano), so refresh both the stored state and live HP cost.
        qc.invalidateQueries({ queryKey: ["character-abilities", target.id] }),
        ...(effectiveSourceCharacterId
          ? [qc.invalidateQueries({ queryKey: ["character-abilities", effectiveSourceCharacterId] })]
          : []),
        qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
        // Vulnerabilidade and custom scripts (Sedento's Invencibilidade)
        // can insert effects as part of resolving this damage.
        qc.invalidateQueries({ queryKey: ["battle-effects"] }),
        qc.invalidateQueries({ queryKey: ["character-active-effects", target.id] }),
        qc.invalidateQueries({ queryKey: ["demonio-interno-hp"] }),
        ...(effectiveSourceCharacterId ? [
          qc.invalidateQueries({ queryKey: ["equipped-weapons-for-damage", effectiveSourceCharacterId] }),
          qc.invalidateQueries({ queryKey: ["inventory", effectiveSourceCharacterId] }),
        ] : []),
      ]);
      if (effects.length > 0 || dots.length > 0) {
        try { await applyConfiguredEffects(effectiveSourceCharacterId); }
        catch (error) { toast.error("Dano aplicado, mas falhou ao aplicar efeitos/DoTs: " + (error instanceof Error ? error.message : String(error)), { duration: 10000 }); }
      }
    } finally {
      setApplyingDamage(false);
      setCriticalDamage(false);
    }
  }

  function addDot() {
    if (!selectedDotTemplateId) { toast.error("Cadastre e selecione um modelo de DoT primeiro."); return; }
    setDots((current) => [...current, { templateId: selectedDotTemplateId, damageMode: "fixed", amount: "10", duration: "3" }]);
  }

  return (
    <section className="panel space-y-3 p-4">
      <h3 className="flex items-center gap-2 text-lg text-gold">
        <HeartPulse className="h-5 w-5" /> Aplicar dano em {target.name}
      </h3>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Quem está causando o dano?</label>
        <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={sourceCharacterId}
          onChange={(e) => { setSourceCharacterId(e.target.value); setWeaponInventoryItemId(""); }}>
          <option value="">Nenhum atacante (sem modificadores de dano)</option>
          {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
        </select>
        <p className="text-xs text-muted-foreground">Ao selecionar um personagem, os buffs/debuffs de Dano Causado dele serão aplicados antes da Defesa e da Defesa Mágica.</p>
      </div>
      <div className="space-y-2 rounded-xl border border-gold/25 bg-gold/5 p-3">
        <label htmlFor={`weapon-for-damage-${target.id}`} className="block text-xs font-semibold text-gold">
          Arma utilizada no ataque (opcional)
        </label>
        <select id={`weapon-for-damage-${target.id}`}
          className="min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={selectedWeapon?.id ?? ""}
          disabled={!sourceId || applyingDamage}
          onChange={(event) => {
            const weapon = equippedWeapons.find((item) => item.id === event.target.value);
            setWeaponInventoryItemId(weapon?.id ?? "");
            if (weapon) {
              setDamageKind(weapon.weapon_damage.damage_kind);
              setDamageTypeId(weapon.weapon_damage.damage_type_id ?? "");
              setPhysicalDamageTypeId(weapon.weapon_damage.physical_damage_type_id ?? "");
              setMagicLevel(weapon.weapon_damage.magic_level);
            }
          }}>
          <option value="">{!sourceId ? "Selecione quem está atacando primeiro" : loadingWeapons ? "Carregando armas…" : "Sem arma — dano manual normal"}</option>
          {equippedWeapons.map((weapon) => (
            <option key={weapon.id} value={weapon.id}>{weapon.name} · {weaponDamageSummary(weapon.weapon_damage)}{weapon.weapon_damage.uses_ammo ? " · " + (weapon.ammo_current ?? 0) + "/" + weapon.weapon_damage.ammo_max + ((weapon.ammo_current ?? 0) === 0 ? " (sem munição)" : "") : ""}</option>
          ))}
        </select>
        {selectedWeapon && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {weaponDamageSummary(selectedWeapon.weapon_damage)}. O sistema acrescenta o bônus a cada golpe,
            aplica a categoria e os tipos cadastrados na arma e calcula defesa, mitigação e críticos normalmente.
          </p>
        )}
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <label className="block text-xs font-semibold text-amber-200" htmlFor={`external-attack-${target.id}`}>Ataque contra inimigo fora do sistema</label>
          <select id={`external-attack-${target.id}`} value={outsideTargetMode} disabled={applyingDamage}
            className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
            onChange={event => setOutsideTargetMode(event.target.value as "none" | "hit" | "miss")}>
            <option value="none">Dano normal no alvo cadastrado ({target.name})</option>
            <option value="hit">Acertou alguém fora do sistema</option>
            <option value="miss">Não acertou ninguém</option>
          </select>
          {outsideTargetMode !== "none" && (
            <p className="text-xs text-amber-200">
              Usa a arma selecionada, consome munição quando houver e registra o resultado. Não reduz HP de personagens cadastrados. Acertos com Luvas da Peste podem gerar cura e stacks apenas no atacante.
            </p>
          )}
        </div>
        {selectedWeapon?.weapon_damage.uses_ammo && (
          <div role="status" className={"rounded-lg border px-3 py-2 text-sm " + (ammoInsufficient ? "border-red-500/40 bg-red-500/10 text-red-300" : "border-amber-500/25 bg-amber-500/5 text-amber-200")}>
            <span className="font-semibold">Munição: {availableAmmo}/{selectedWeapon.weapon_damage.ammo_max}</span>
            <span className="ml-2 text-xs"> · {plannedHits} golpe(s) previstos, 1 munição por golpe</span>
            {ammoInsufficient && <p className="mt-1 text-xs font-semibold">Munição insuficiente. Recarregue a arma no inventário ou reduza os golpes.</p>}
          </div>
        )}
        {sourceId && !loadingWeapons && equippedWeapons.length === 0 && (
          <p className="text-xs text-muted-foreground">Este atacante não possui armas equipadas no inventário.</p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Categoria do dano</label>
          <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={effectiveDamageKind} disabled={!!selectedWeapon}
            onChange={(e) => setDamageKind(e.target.value as DamageKind)}>
            <option value="physical">Físico — usa Defesa</option>
            <option value="magical">Mágico — usa Defesa Mágica</option>
            <option value="hybrid">Híbrido — usa as duas defesas</option>
            <option value="true">Verdadeiro — ignora as defesas</option>
          </select>
        </div>
        {needsPhysical && physicalDamageTypes.length > 0 && (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Tipo físico</label>
            <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={selectedWeapon?.weapon_damage.physical_damage_type_id ?? selectedPhysicalDamageTypeId}
              disabled={!!selectedWeapon}
              onChange={(e) => setPhysicalDamageTypeId(e.target.value)}>
              <option value="">Selecione o tipo físico</option>
              {physicalDamageTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
            </select>
          </div>
        )}
        {needsMagic && (
          <>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Tipo mágico</label>
              <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={selectedWeapon?.weapon_damage.damage_type_id ?? damageTypeId} disabled={!!selectedWeapon} onChange={(e) => setDamageTypeId(e.target.value)}>
                <option value="">Selecione o tipo</option>
                {damageTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
              </select>
              {loadingTypes && <p className="text-xs text-muted-foreground">Carregando tipos…</p>}
              {typesError && <p className="text-xs text-destructive">Não foi possível carregar os tipos de dano.</p>}
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Nível da magia</label>
              <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={selectedWeapon?.weapon_damage.magic_level ?? magicLevel} disabled={!!selectedWeapon} onChange={(e) => setMagicLevel(e.target.value as MagicLevel)}>
                <option value="baixa">Baixa</option>
                <option value="media">Média</option>
                <option value="alta">Alta</option>
              </select>
            </div>
          </>
        )}
      </div>
      {effectiveDamageKind === "hybrid" && (
        <p className="text-xs text-muted-foreground">
          O dano bruto é dividido igualmente: metade física reduzida pela Defesa e metade mágica reduzida pela Defesa Mágica.
          Se o valor for ímpar, o ponto extra vai para a parte mágica.
        </p>
      )}
      {effectiveDamageKind === "true" && (
        <p className="text-xs text-muted-foreground">Dano verdadeiro ignora Defesa e Defesa Mágica.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={damageMode === "repeat" ? "default" : "outline"} onClick={() => setDamageMode("repeat")}>Repetir um valor</Button>
        <Button size="sm" variant={damageMode === "list" ? "default" : "outline"} onClick={() => setDamageMode("list")}>Lista de danos</Button>
      </div>
      {damageMode === "repeat" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor={`damage-amount-${target.id}`} className="text-xs text-muted-foreground">Dano bruto por golpe</label>
            <Input id={`damage-amount-${target.id}`} type="number" min="0" max="1000000" value={damageValue} onChange={(e) => setDamageValue(e.target.value)} />
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Preencher dano com atributo do atacante">
              <Button type="button" size="sm" variant="outline" className="min-h-11 min-w-0 px-2 text-xs sm:text-sm"
                disabled={applyingDamage || !sourceId || sourceStrength === null} onClick={() => fillDamageFromStat("strength")}
                title="Substituir o dano bruto pela Força atual do atacante selecionado">
                <Dumbbell className="mr-1 h-4 w-4 shrink-0" /> <span className="truncate">Força{sourceStrength === null ? "" : ` · ${sourceStrength}`}</span>
              </Button>
              <Button type="button" size="sm" variant="outline" className="min-h-11 min-w-0 px-2 text-xs sm:text-sm"
                disabled={applyingDamage || !sourceId || sourceMagicDamage === null} onClick={() => fillDamageFromStat("mag_dmg")}
                title="Substituir o dano bruto pelo Dano Mágico atual do atacante selecionado">
                <WandSparkles className="mr-1 h-4 w-4 shrink-0" /> <span className="truncate">Mágico{sourceMagicDamage === null ? "" : ` · ${sourceMagicDamage}`}</span>
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground" aria-live="polite">
              {!sourceId ? "Selecione quem está causando o dano para usar os atributos." :
                sourceStatsLoading ? "Carregando Força e Dano Mágico do atacante..." :
                sourceStatsError ? "Não foi possível consultar os atributos deste atacante." :
                "Toque em um atributo para preencher o dano, sem causar o ataque."}
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Quantidade de golpes (1–200)</label>
            <Input type="number" min="1" max="200" value={repeatCount} onChange={(e) => setRepeatCount(e.target.value)} />
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Danos brutos separados por vírgula</label>
          <Input value={damageList} onChange={(e) => setDamageList(e.target.value)} placeholder="50, 35, 45, 86, 20, 10, 50" />
        </div>
      )}
      <div className="space-y-3 rounded-md border border-gold/30 p-3">
        <h4 className="text-sm font-semibold text-gold">Modificadores de dano em {target.name}</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-medium">
            Aumentar ou reduzir o dano (valor fixo +/-)
            <Input type="number" min={-1000000} max={1000000} step={1}
              disabled={applyingDamage} value={extraDamageFixed}
              onChange={(event) => setExtraDamageFixed(event.target.value)} />
          </label>
          <label className="space-y-1 text-xs font-medium">
            Aumentar ou reduzir o dano (% +/-)
            <Input type="number" min={-100} max={1000} step={1}
              disabled={applyingDamage} value={extraDamagePercent}
              onChange={(event) => setExtraDamagePercent(event.target.value)} />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Aplica o ajuste fixo e depois o percentual em cada golpe, antes de calcular defesa, buffs e redução de dano.
          Por exemplo: 50 + 10 fixos - 50% = 30 de dano bruto por golpe.
        </p>
        {damageKind !== "true" ? (
          <div className="border-t border-border/60 pt-3">
            <DefenseIgnoreInputs
              title="Ignorar Defesa Física ou Defesa Mágica neste alvo"
              value={defenseIgnore}
              onChange={setDefenseIgnore}
              disabled={applyingDamage}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              A porcentagem reduz primeiro a defesa efetiva, depois o valor fixo; o mínimo é zero.
              Defesa ignorada não remove outros efeitos de mitigação.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Dano verdadeiro já ignora ambas as defesas.</p>
        )}
      </div>
      <label className="flex cursor-pointer items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={criticalDamage}
          disabled={applyingDamage}
          onChange={(e) => setCriticalDamage(e.target.checked)}
        />
        <span>
          <span className="block font-semibold text-amber-500">Dano Crítico — ×2 do dano bruto</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Multiplica cada golpe por 2 antes de calcular a Defesa e a Mitigação. Exemplo: 40 × 2 − 78 de Defesa = 2 de dano.
            Limite: 500000 de dano bruto por golpe no crítico. A opção desmarca após a aplicação.
          </span>
        </span>
      </label>
      <details className="rounded-md border border-border">
        <summary className="cursor-pointer select-none px-3 py-3 text-sm font-semibold hover:text-gold">
          Efeitos e DoTs neste alvo ({effects.length + dots.length})
        </summary>
        <div className="space-y-4 border-t border-border p-3">
          <AbilityEffectsEditor
            effects={effects}
            onChange={setEffects}
            defs={defs}
            title="Efeitos para aplicar junto com o dano"
            description={battleId ? "Os efeitos e DoTs são temporários durante o combate e seguem a duração configurada." : "Os efeitos e DoTs aplicados por esta área são sempre temporários. Para efeitos permanentes, use a seção separada Efeitos permanentes da ficha."}
            allowHealing={false}
          />
          <div className="space-y-3 rounded-md border border-border p-3">
            <div>
              <h4 className="text-sm font-semibold">DoTs para aplicar no alvo</h4>
              <p className="mt-1 text-xs text-muted-foreground">Os DoTs usam os modelos cadastrados na página Dano por Turno. É possível mudar o valor e a duração de cada aplicação.</p>
            </div>
            {loadingDotTemplates ? <p className="text-xs text-muted-foreground">Carregando modelos de DoT…</p> : dotTemplates.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhum modelo cadastrado ainda. Crie um na página Dano por Turno.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <select className="h-9 min-w-48 flex-1 rounded-md border border-input bg-background px-2 text-sm" value={selectedDotTemplateId}
                  onChange={(event) => setSelectedDotTemplateId(event.target.value)}>
                  {dotTemplates.map((template) => <option key={template.id} value={template.id}>{template.name} — {template.damage_kind === "physical" ? "Físico" : "Mágico"}</option>)}
                </select>
                <Button type="button" size="sm" variant="outline" onClick={addDot}><Plus className="mr-1 h-3.5 w-3.5" /> Adicionar DoT</Button>
              </div>
            )}
            {dots.map((dot, index) => {
              const template = dotTemplates.find((item) => item.id === dot.templateId);
              return (
                <div key={index} className="grid gap-2 rounded-md border border-border/70 p-2 sm:grid-cols-[minmax(0,1fr)_125px_105px_105px_auto] sm:items-end">
                  <label className="space-y-1 text-xs font-medium">
                    Modelo
                    <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={dot.templateId}
                      onChange={(event) => setDots((current) => current.map((item, i) => i === index ? { ...item, templateId: event.target.value } : item))}>
                      {dotTemplates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                    <span className="block text-muted-foreground">{template?.damage_kind === "physical" ? "Físico" : "Mágico"}{template?.magic_level ? " · magia " + template.magic_level : ""}</span>
                  </label>
                  <label className="space-y-1 text-xs font-medium">Cálculo
                    <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={dot.damageMode}
                      onChange={(event) => setDots((current) => current.map((item, i) => i === index ? { ...item, damageMode: event.target.value as "fixed" | "percent" } : item))}>
                      <option value="fixed">Dano fixo</option><option value="percent">% do HP</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-xs font-medium">Valor
                    <Input type="number" min={1} max={dot.damageMode === "percent" ? 1000 : 1000000} value={dot.amount}
                      onChange={(event) => setDots((current) => current.map((item, i) => i === index ? { ...item, amount: event.target.value } : item))} />
                  </label>
                  <label className="space-y-1 text-xs font-medium">Duração (turnos)
                    <Input type="number" min={1} max={1000} value={dot.duration}
                      onChange={(event) => setDots((current) => current.map((item, i) => i === index ? { ...item, duration: event.target.value } : item))} />
                  </label>
                  <Button type="button" variant="ghost" size="icon" aria-label="Remover DoT da aplicação" onClick={() => setDots((current) => current.filter((_, i) => i !== index))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={applyingEffectsOnly || applyingDamage || (!effects.length && !dots.length)}
              onClick={() => void applyEffectsOnly()}>
              <CheckCircle2 className="mr-1 h-4 w-4" /> {applyingEffectsOnly ? "Aplicando…" : "Aplicar somente efeitos/DoTs em " + target.name}
            </Button>
          </div>
        </div>
      </details>
      <Button disabled={applyingDamage || applyingEffectsOnly || ammoInsufficient || (outsideTargetMode !== "none" && (!battleId || !sourceId))
        || (outsideTargetMode === "none" && needsMagic && (!selectedMagicDamageTypeId || magicalDamageTypes.length === 0))
        || (outsideTargetMode === "none" && needsPhysical && physicalDamageTypes.length > 0 && !selectedPhysicalDamageTypeId)
        || (outsideTargetMode === "none" && loadingTypes && (needsMagic || needsPhysical))}
        onClick={() => void applyDamage()}>
        {damageKind === "physical" ? <Shield className="mr-1 h-4 w-4" /> :
          damageKind === "magical" ? <Sparkles className="mr-1 h-4 w-4" /> :
          damageKind === "hybrid" ? <Swords className="mr-1 h-4 w-4" /> : <Zap className="mr-1 h-4 w-4" />}
        {applyingDamage ? "Aplicando…" : outsideTargetMode !== "none" ? "Registrar ataque sem alvo cadastrado" : `Confirmar dano em ${target.name}`}
      </Button>
      {lastDamageOutcome && (
        <div role="status" className={`space-y-1.5 rounded-lg border p-3 text-sm ${lastDamageOutcome.criticalRequested ? "border-amber-500/50 bg-amber-500/10" : "border-border bg-muted/20"}`}>
          <div className="font-semibold">
            {lastDamageOutcome.criticalRequested
              ? lastDamageOutcome.criticalConfirmed ? "⚔️ Crítico ×2 confirmado pelo servidor" : "Atenção: crítico não confirmado pelo servidor"
              : "Resultado do último dano"}
          </div>
          <p className="text-xs text-muted-foreground">Dano final: <strong className="text-foreground">{lastDamageOutcome.damage}</strong>
            {" · "}HP: {lastDamageOutcome.hpBefore} → {lastDamageOutcome.hpAfter}</p>
          {lastDamageOutcome.criticalRawHits.length > 0 && <p className="break-words text-xs text-muted-foreground">
            Dano bruto com crítico, antes da defesa: {lastDamageOutcome.criticalRawHits.join(", ")}
          </p>}
          {lastDamageOutcome.hits.length > 0 && <p className="break-words text-xs text-muted-foreground">
            Dano por golpe depois da defesa e mitigação: {lastDamageOutcome.hits.join(", ")}
          </p>}
          {lastDamageOutcome.criticalRequested && <p className="text-xs text-muted-foreground">
            O ×2 é aplicado ao dano bruto, antes da defesa e da mitigação. A vida nunca desce abaixo de zero; por isso a perda visível de HP pode ser menor que o dano calculado.
          </p>}
        </div>
      )}
    </section>
  );
}
