import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, Clock3, Copy, Crosshair, Flame, Footprints, HeartPulse, Minus, Plus, Sparkles, Swords, Trash2, WandSparkles, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { dispatchCustomAbilityScriptEvents } from "@/lib/ability-script-runtime";
import { useDefs, useMe, useRaces, useClasses } from "@/lib/sheets";
import { parseAbilityEffects, parseAbilityAttackDamage, useAbilities, useCharacterAbilities, useCharacterActiveEffects, useDamageTypes, type Ability, type AbilityEffectDefinition, type CharacterAbility, type AbilityAttackDamageConfig } from "@/lib/abilities";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import type { Json } from "@/integrations/supabase/types";
import { parseCustomAbilityAttributes, type CustomAbilityAttribute } from "@/lib/custom-ability-scripts";

type TargetOption = { id: string; name: string };

function customNumberAttribute(attributes: unknown, key: string, fallback: number): number {
  if (!Array.isArray(attributes)) return fallback;
  const row = attributes.find((item) =>
    !!item && typeof item === "object" && (item as Record<string, unknown>).key === key
  ) as Record<string, unknown> | undefined;
  if (!row) return fallback;
  const value = Number(row.value);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;
}

function numericStateValue(state: unknown, key: string): number {
  if (!state || typeof state !== "object" || Array.isArray(state)) return 0;
  const value = Number((state as Record<string, unknown>)[key] ?? 0);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}


function effectiveCustomAbilityAttributes(value: unknown, multiplier: number): CustomAbilityAttribute[] {
  return parseCustomAbilityAttributes(value).map((attribute) =>
    attribute.type === "number" && attribute.scale_with_race !== false
      ? { ...attribute, value: Number(attribute.value) * multiplier }
      : attribute
  );
}

function mergeCustomAbilityAttributeValues(definitions: unknown, overrides: unknown): CustomAbilityAttribute[] {
  const base = parseCustomAbilityAttributes(definitions);
  const saved = parseCustomAbilityAttributes(overrides);
  return base.map((attribute) => {
    const existing = saved.find((item) => item.key === attribute.key);
    return existing ? { ...attribute, value: existing.value } : { ...attribute };
  });
}

function CharacterAbilityCustomAttributesEditor({
  ability, definitions, multiplier,
}: {
  ability: CharacterAbility;
  definitions: unknown;
  multiplier: number;
}) {
  const qc = useQueryClient();
  const row = ability as CharacterAbility & { custom_attributes?: unknown };
  const source = Array.isArray(row.custom_attributes) ? row.custom_attributes : definitions;
  const [attributes, setAttributes] = useState<CustomAbilityAttribute[]>(() =>
    mergeCustomAbilityAttributeValues(definitions, source)
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAttributes(mergeCustomAbilityAttributeValues(definitions, source));
  }, [ability.id, definitions, source]);

  function changeValue(index: number, value: number | string | boolean) {
    setAttributes((current) => current.map((attribute, i) => i === index ? { ...attribute, value } : attribute));
  }

  async function save() {
    setSaving(true);
    const db = supabase as any;
    const { error } = await db.rpc("update_character_ability_custom_attributes", {
      _character_ability_id: ability.id,
      _custom_attributes: attributes,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message || "Não foi possível salvar os atributos personalizados");
      return;
    }
    toast.success("Atributos personalizados da habilidade salvos nesta ficha");
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["character-abilities", ability.character_id] }),
      qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
    ]);
  }

  if (!attributes.length) return null;
  return (
    <div className="mt-3 space-y-3 rounded-md border border-gold/30 bg-gold/5 p-3">
      <div>
        <div className="text-xs font-semibold text-gold">Atributos personalizados desta ficha</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Esses valores são exclusivos do personagem e não alteram a habilidade no catálogo.
          {ability.granted_by_virtue_id && multiplier > 1
            ? ` A raça ou classe aplica ${multiplier}× aos valores numéricos durante os cálculos.`
            : ""}
        </p>
      </div>
      <div className="space-y-3">
        {attributes.map((attribute, index) => (
          <div key={attribute.key} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(140px,220px)] sm:items-center">
            <div className="min-w-0">
              <div className="text-sm font-medium">{attribute.name}</div>
              <div className="text-[11px] text-muted-foreground">Chave: <code>{attribute.key}</code></div>
            </div>
            {attribute.type === "number" ? (
              <div className="space-y-1">
                <Input
                  type="number"
                  step="any"
                  min={-1000000}
                  max={1000000}
                  value={String(attribute.value)}
                  onChange={(event) => changeValue(index, Number(event.target.value) || 0)}
                  disabled={saving}
                  aria-label={attribute.name}
                />
                {ability.granted_by_virtue_id && multiplier > 1 && attribute.scale_with_race !== false && (
                  <div className="text-[11px] text-muted-foreground">
                    Valor efetivo: {Number(attribute.value) * multiplier} ({attribute.value} × {multiplier})
                  </div>
                )}
              </div>
            ) : attribute.type === "boolean" ? (
              <label className="flex h-9 items-center gap-2 rounded-md border border-input px-3 text-sm">
                <input type="checkbox" checked={attribute.value === true}
                  onChange={(event) => changeValue(index, event.target.checked)} disabled={saving} />
                {attribute.value ? "Ativado" : "Desativado"}
              </label>
            ) : (
              <Input value={String(attribute.value)} onChange={(event) => changeValue(index, event.target.value)}
                disabled={saving} aria-label={attribute.name} maxLength={2000} />
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          <Check className="mr-1 h-3.5 w-3.5" /> {saving ? "Salvando..." : "Salvar atributos"}
        </Button>
      </div>
    </div>
  );
}

export function effectSummary(effect: AbilityEffectDefinition, defs: NonNullable<ReturnType<typeof useDefs>["data"]>, damageTypes: NonNullable<ReturnType<typeof useDamageTypes>["data"]>, races: NonNullable<ReturnType<typeof useRaces>["data"]>) {
  const amount = effect.value_mode === "percent" ? `${effect.amount}%` : effect.effect_type === "damage_dealt" ? String(effect.amount) : (effect.effect_type === "mana_regeneration" || effect.effect_type === "mana_used") ? `${effect.amount} Mana` : `${effect.amount} pontos`;
  const polarity = effect.polarity === "buff" ? "+" : "−";
  if (effect.effect_type === "status") return `${effect.name}: ${polarity}${amount} em ${defs.find((d) => d.key === effect.attribute_key)?.label ?? effect.attribute_key}`;
  if (effect.effect_type === "regeneration") return `${effect.name}: regeneração ${polarity}${amount} de ${effect.attribute_key === "mana" ? "Mana" : "HP"}`;
  if (effect.effect_type === "mana_regeneration") return `${effect.name}: regeneração de Mana ${polarity}${amount}`;
  if (effect.effect_type === "mana_used") return `${effect.name}: Mana usada ${effect.polarity === "buff" ? "−" : "+"}${amount}`;
  if (effect.effect_type === "damage_dealt") {
    const scope = effect.damage_scope === "physical" ? "dano físico" : effect.damage_scope === "magical" ? "dano mágico" : "qualquer dano";
    return `${effect.name}: ${polarity}${amount} de dano causado (${scope})`;
  }
  if (effect.effect_type === "healing") {
    const parts: string[] = [];
    const restoreAmount = (enabled: boolean | undefined, mode: "fixed" | "percent" | undefined, amount: number | undefined, name: string, percentBasis: string) => {
      if (!enabled) return;
      parts.push(`${name} +${amount ?? 0}${mode === "percent" ? `% ${percentBasis}` : name === "Corpo" || name === "Sanidade" ? " pontos percentuais" : " fixos"}`);
    };
    restoreAmount(effect.healing_hp_enabled, effect.healing_hp_mode, effect.healing_hp_amount, "HP", "do máximo");
    restoreAmount(effect.healing_mana_enabled, effect.healing_mana_mode, effect.healing_mana_amount, "Mana", "do máximo");
    restoreAmount(effect.healing_body_enabled, effect.healing_body_mode, effect.healing_body_amount, "Corpo", "do que falta");
    restoreAmount(effect.healing_sanity_enabled, effect.healing_sanity_mode, effect.healing_sanity_amount, "Sanidade", "do que falta");
    if (effect.healing_remove_debuffs) parts.push("remove debuffs permitidos");
    const blockedNames = (effect.healing_debuff_name_blacklist ?? []).filter((name) => name.trim());
    if (blockedNames.length > 0) parts.push(`preserva: ${blockedNames.join(", ")}`);
    if ((effect.healing_reduce_debuff_turns_fixed ?? 0) > 0) parts.push(`reduz debuffs em ${effect.healing_reduce_debuff_turns_fixed} turno(s)`);
    if ((effect.healing_reduce_debuff_turns_percent ?? 0) > 0) parts.push(`reduz duração em ${effect.healing_reduce_debuff_turns_percent}%`);
    const damageName = damageTypes.find((type) => type.id === effect.healing_damage_type_id)?.name;
    const magic = damageName ? ` · tipo mágico: ${damageName}, grau ${effect.healing_magic_level ?? "não definido"}` : "";
    const timing = effect.healing_timing === "per_turn"
      ? effect.until_combat_end ? "cura por rodada até o fim do combate" : `cura por rodada (${effect.duration} turnos)`
      : "cura instantânea";
    return `${effect.name}: ${timing}; ${parts.join(", ") || "sem opções configuradas"}${magic}`;
  }
  if (effect.effect_type === "damage_received") {
    const amountText = effect.value_mode === "percent" ? `${effect.amount}%` : `${effect.amount} fixos`;
    const scope = effect.damage_received_scope ?? "any";
    if (scope === "magical") {
      const selectedTypeIds = effect.damage_received_type_ids ?? [];
      const selectedLevels = effect.damage_received_magic_levels ?? [];
      const typeNames = selectedTypeIds.length === 0
        ? "todos os tipos"
        : selectedTypeIds.map((id) => damageTypes.find((type) => type.id === id)?.name ?? "tipo removido").join(", ");
      const levels = selectedLevels.length === 0
        ? "qualquer nível"
        : selectedLevels.map((level) => level === "baixa" ? "baixo" : level === "media" ? "médio" : "alto").join(", ");
      return `${effect.name}: aumenta dano mágico recebido (${typeNames}; nível ${levels}) em ${amountText}`;
    }
    if (scope === "race") {
      const raceName = races.find((race) => race.id === effect.damage_received_race_id)?.name ?? "raça não selecionada";
      return `${effect.name}: recebe ${amountText} a mais de qualquer dano causado pela raça ${raceName}`;
    }
    return `${effect.name}: aumenta dano ${scope === "physical" ? "físico" : "de qualquer tipo"} recebido em ${amountText}`;
  }
  if (effect.effect_type === "damage_reduction") {
    const selectedTypeIds = effect.damage_reduction_type_ids ?? (effect.damage_reduction_type_id ? [effect.damage_reduction_type_id] : []);
    const selectedLevels = effect.damage_reduction_magic_levels ?? (effect.damage_reduction_magic_level ? [effect.damage_reduction_magic_level] : []);
    const typeNames = selectedTypeIds.length === 0
      ? "todos os tipos"
      : selectedTypeIds.map((id) => damageTypes.find((type) => type.id === id)?.name ?? "tipo removido").join(", ");
    const levelNames = selectedLevels.length === 0
      ? "todos os graus"
      : selectedLevels.map((level) => level === "baixa" ? "baixa" : level === "media" ? "média" : "alta").join(", ");
    const scope = effect.damage_reduction_scope === "magical" ? `mágico (${typeNames}; grau(s) ${levelNames})` : "físico";
    const amountText = effect.value_mode === "percent" ? `${effect.amount}%` : `${effect.amount} fixos`;
    return `${effect.name}: mitiga dano recebido ${scope} em ${amountText}`;
  }
  if (effect.effect_type === "no_regen_hp") return `${effect.name}: bloqueia regeneração de HP`;
  if (effect.effect_type === "no_regen_mana") return `${effect.name}: bloqueia regeneração de Mana`;
  if (effect.effect_type === "magic_prohibition") return `${effect.name}: impede habilidades que consomem Mana`;
  if (effect.effect_type === "no_mana") return `${effect.name}: Sem Mana — zera a Mana e bloqueia habilidades mágicas ou que consomem Mana`;
  if (effect.effect_type === "invincible") return `${effect.name}: não recebe nenhum dano enquanto estiver ativo`;
  if (effect.effect_type === "healing_blocked") return `${effect.name}: bloqueia curas de habilidades enquanto estiver ativo`;
  if (effect.effect_type === "magic_healing_reversal") {
    const selectedTypeIds = effect.magic_healing_type_ids ?? [];
    const selectedLevels = effect.magic_healing_magic_levels ?? [];
    const types = selectedTypeIds.length === 0
      ? "todos os tipos mágicos"
      : selectedTypeIds.map((id) => damageTypes.find((type) => type.id === id)?.name ?? "tipo removido").join(", ");
    const levels = selectedLevels.length === 0
      ? "qualquer nível"
      : selectedLevels.map((level) => level === "baixa" ? "baixo" : level === "media" ? "médio" : "alto").join(", ");
    const mode = effect.magic_healing_reversal_damage_mode ?? "healing_amount";
    const damage = mode === "custom"
      ? `dano customizado de ${effect.magic_healing_reversal_custom_damage ?? 0}`
      : mode === "both"
        ? `valor da cura + ${effect.magic_healing_reversal_custom_damage ?? 0} de dano customizado`
        : "dano igual ao valor da cura";
    return `${effect.name}: reverte curas mágicas de ${types} (${levels}) em dano — ${damage}`;
  }
  return `${effect.name}: Stun (visual)`;
}

export function CharacterAbilitiesPanel({
  characterId, characterName, mode, canUse, battleId, targets = [], getAttributeValue, showActiveEffects = true, allowCustomAttributeEdit = false,
}: {
  characterId: string;
  characterName: string;
  mode: "sheet" | "combat";
  canUse: boolean;
  battleId?: string;
  targets?: TargetOption[];
  getAttributeValue?: (characterId: string, attributeKey: string) => number;
  /** Hide the active runtime effects list when viewing another character in combat. */
  showActiveEffects?: boolean;
  /** Let the owner personalize the script attributes for abilities on their own sheet. */
  allowCustomAttributeEdit?: boolean;
}) {
  const qc = useQueryClient();
  const { data: loadout, isLoading } = useCharacterAbilities(characterId);
  const { data: activeEffects = [] } = useCharacterActiveEffects(characterId, showActiveEffects);
  const { data: defs } = useDefs();
  const { data: damageTypes = [] } = useDamageTypes();
  const { data: races = [] } = useRaces();
  const { data: classes = [] } = useClasses();
  const { data: abilityCatalog = [] } = useAbilities();
  const db = supabase as any;
  const { data: characterTraitIds = { raceId: null, classId: null } } = useQuery<{ raceId: string | null; classId: string | null }>({
    queryKey: ["character-traits-for-custom-ability-attributes", characterId],
    queryFn: async () => {
      const { data, error } = await db.from("characters").select("race_id,class_id").eq("id", characterId).maybeSingle();
      if (error) throw error;
      return { raceId: (data?.race_id as string | null | undefined) ?? null, classId: (data?.class_id as string | null | undefined) ?? null };
    },
  });
  const selectedRace = races.find((race) => race.id === characterTraitIds.raceId);
  const selectedClass = classes.find((classTrait) => classTrait.id === characterTraitIds.classId);
  const mechanicsOf = (trait: { special_mechanics?: unknown } | undefined) => {
    const value = trait?.special_mechanics;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  };
  const multiplierForAbility = (ability: CharacterAbility | undefined) => {
    const abilityTraitId = ability?.granted_by_virtue_id;
    if (!abilityTraitId) return 1;
    const raceMechanics = mechanicsOf(selectedRace);
    const classMechanics = mechanicsOf(selectedClass);
    const blacklistContains = (mechanics: Record<string, unknown>) =>
      Array.isArray(mechanics.virtue_effect_blacklist) && mechanics.virtue_effect_blacklist.includes(abilityTraitId);
    const scale = (mechanics: Record<string, unknown>) => {
      if (mechanics.duplicate_virtue_effects !== true || blacklistContains(mechanics)) return 1;
      return Math.max(1, Math.min(10, Number(mechanics.virtue_effect_multiplier) || 2));
    };
    return Math.min(100, scale(raceMechanics) * scale(classMechanics));
  };
  const { data: usedOnceAbilityIds = [] } = useQuery<string[]>({
    queryKey: ["battle-ability-uses", battleId, characterId],
    enabled: mode === "combat" && !!battleId,
    queryFn: async () => {
      const { data, error } = await db.from("character_ability_battle_uses")
        .select("character_ability_id").eq("battle_id", battleId!).eq("character_id", characterId);
      if (error) throw error;
      return (data ?? []).map((row: { character_ability_id: string }) => row.character_ability_id);
    },
  });
  const demonioAssignment = (loadout ?? []).find((assigned) => {
    const catalogEntry = abilityCatalog.find((candidate) => candidate.id === assigned.ability_id);
    return catalogEntry?.custom_script_key === "demonio_interno"
      || catalogEntry?.name === "Demônio Interno"
      || assigned.name === "Demônio Interno";
  });
  const demonioCatalogEntry = abilityCatalog.find((candidate) => candidate.id === demonioAssignment?.ability_id);
  const demonioAssignedCustomAttributes = (demonioAssignment as (CharacterAbility & { custom_attributes?: unknown }) | undefined)?.custom_attributes;
  const demonioCustomAttributes = effectiveCustomAbilityAttributes(
    Array.isArray(demonioAssignedCustomAttributes) ? demonioAssignedCustomAttributes : demonioCatalogEntry?.custom_attributes,
    multiplierForAbility(demonioAssignment),
  );
  const demonioHeat = numericStateValue(demonioAssignment?.custom_state, "dano_superaquecimento");
  const demonioReflectPercent = customNumberAttribute(
    demonioCustomAttributes,
    "porcentagem_maxima_dano_refletido",
    50,
  );
  const demonioHpCostPercent = customNumberAttribute(
    demonioCustomAttributes,
    "percentual_hp_perdido_por_refletir",
    10,
  );
  const { data: demonioHp, isError: demonioHpError } = useQuery({
    queryKey: ["demonio-interno-hp", characterId],
    enabled: !!demonioAssignment,
    queryFn: async () => {
      const [attributeResult, maximumResult] = await Promise.all([
        supabase.from("character_attributes").select("current_value")
          .eq("character_id", characterId).eq("attribute_key", "hp").maybeSingle(),
        supabase.rpc("calculate_character_resource_max", {
          _character_id: characterId,
          _attribute_key: "hp",
        }),
      ]);
      if (attributeResult.error) throw attributeResult.error;
      if (maximumResult.error) throw maximumResult.error;
      return {
        current: Number(attributeResult.data?.current_value ?? 0),
        maximum: Math.max(0, Number(maximumResult.data ?? 0)),
      };
    },
    staleTime: 0,
  });
  const demonioBonusDamage = Math.floor(demonioHeat * demonioReflectPercent / 100);
  const demonioHpCost = demonioHp
    ? Math.ceil(demonioHp.maximum * demonioHpCostPercent / 100)
    : null;
  const [targetId, setTargetId] = useState(characterId);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [extraManaCosts, setExtraManaCosts] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(true);
  const [attackDialogAbilityId, setAttackDialogAbilityId] = useState<string | null>(null);
  const [attackTargetIds, setAttackTargetIds] = useState<string[]>([]);
  const [attackHits, setAttackHits] = useState<Record<string, boolean>>({});
  const [attackExtraDamage, setAttackExtraDamage] = useState<Record<string, string>>({});
  const [attackBusy, setAttackBusy] = useState(false);
  const [attackResolved, setAttackResolved] = useState(false);
  const [attackResults, setAttackResults] = useState<Record<string, string>>({});
  const eligibleAttackTargets = targets.filter((target) => target.id !== characterId);
  const attackAbility = loadout?.find((ability) => ability.id === attackDialogAbilityId);
  const attackCatalogEntry = abilityCatalog.find((catalogAbility) => catalogAbility.id === attackAbility?.ability_id);
  const attackConfig = attackCatalogEntry?.attack_enabled ? parseAbilityAttackDamage(attackCatalogEntry.attack_damage) : null;
  const currentAttackTargets = eligibleAttackTargets.filter((target) => attackTargetIds.includes(target.id));
  const statValue = (id: string, key: string) => Math.max(0, Number(getAttributeValue?.(id, key) ?? 0) || 0);
  const attackBaseDamage = attackConfig
    ? Math.min(1000000, Math.max(0, Math.round(
        (attackConfig.attribute_key ? statValue(characterId, attackConfig.attribute_key) * attackConfig.attribute_percent / 100 : 0)
        + attackConfig.fixed_damage
      )))
    : 0;
  const diceModifier = (mine: number, theirs: number) => Math.max(0, Math.floor((mine - theirs) / 10));
  const diceText = (modifier: number) => `1d20+${modifier}`;

  const hasSelectableTargetAbility = loadout?.some((ability) => ability.can_activate && !ability.self_target_only) ?? false;
  const targetOptions = useMemo(() => [
    { id: characterId, name: `${characterName} (si mesmo)` },
    ...targets.filter((target) => target.id !== characterId),
  ], [characterId, characterName, targets]);

  useEffect(() => {
    setTargetId(characterId);
  }, [characterId]);

  function openAttackDialog(ability: CharacterAbility) {
    if (!canUse || mode !== "combat" || !battleId || !ability.can_activate || ability.cooldown_remaining > 0 || ability.cooldown_turns <= 0) return;
    if ((ability as CharacterAbility & { once_per_battle?: boolean }).once_per_battle && usedOnceAbilityIds.includes(ability.id)) {
      toast.error("Esta habilidade já foi usada neste combate.");
      return;
    }
    const preferred = targetId !== characterId && eligibleAttackTargets.some((target) => target.id === targetId)
      ? [targetId]
      : eligibleAttackTargets.slice(0, 1).map((target) => target.id);
    setAttackDialogAbilityId(ability.id);
    setAttackTargetIds(preferred);
    setAttackHits({});
    setAttackExtraDamage({});
    setAttackResults({});
    setAttackResolved(false);
  }

  function copyAttackRoll(target: TargetOption) {
    const attackSpeed = statValue(characterId, "atk_speed");
    const targetSpeed = statValue(target.id, "speed");
    const attackMod = diceModifier(attackSpeed, targetSpeed);
    const dodgeMod = diceModifier(targetSpeed, attackSpeed);
    const text = [
      `**${characterName} — ${attackAbility?.name ?? "Ataque"} contra ${target.name}**`,
      `Lançamento: ${diceText(attackMod)} — (Velocidade de Ataque ${attackSpeed} − Velocidade ${targetSpeed}) ÷ 10, mínimo 0`,
      `Esquiva: ${diceText(dodgeMod)} — (Velocidade ${targetSpeed} − Velocidade de Ataque ${attackSpeed}) ÷ 10, mínimo 0`,
    ].join("\\n");
    void navigator.clipboard.writeText(text).then(() => toast.success("Dados de ataque e esquiva copiados")).catch(() => toast.error("Não foi possível copiar os dados"));
  }

  async function resolveAbilityAttack() {
    if (!attackAbility || !attackCatalogEntry || !attackConfig || !battleId || attackBusy || attackResolved) return;
    if (attackTargetIds.length === 0) {
      toast.error("Selecione pelo menos um alvo para este ataque.");
      return;
    }
    if ((attackConfig.damage_kind === "physical" || attackConfig.damage_kind === "hybrid")
      && !damageTypes.some((type) => type.id === attackConfig.physical_damage_type_id && type.category === "physical")) {
      toast.error("Configure um tipo de dano físico válido nesta habilidade.");
      return;
    }
    if ((attackConfig.damage_kind === "magical" || attackConfig.damage_kind === "hybrid")
      && !damageTypes.some((type) => type.id === attackConfig.damage_type_id && type.category === "magical")) {
      toast.error("Configure um tipo de dano mágico válido nesta habilidade.");
      return;
    }

    const hitTargets = currentAttackTargets.filter((target) => attackHits[target.id]);
    const extraMana = Math.max(0, Math.min(1000000, Math.floor(Number(extraManaCosts[attackAbility.id] ?? 0) || 0)));
    setAttackBusy(true);
    setAttackResults({});
    try {
      const { data: spentMana, error: activationError } = await db.rpc("activate_character_ability_attack", {
        _character_ability_id: attackAbility.id,
        _target_character_id: hitTargets[0]?.id ?? characterId,
        _battle_id: battleId,
        _extra_mana_cost: extraMana,
        _hit_target_ids: hitTargets.map((target) => target.id),
      });
      if (activationError) throw activationError;

      if ((attackAbility as CharacterAbility & { once_per_battle?: boolean }).once_per_battle) {
        await qc.invalidateQueries({ queryKey: ["battle-ability-uses", battleId, characterId] });
      }
      setExtraManaCosts((current) => ({ ...current, [attackAbility.id]: "0" }));
      void dispatchCustomAbilityScriptEvents(battleId);

      const results: Record<string, string> = {};
      for (const target of hitTargets) {
        const extraRaw = Number(attackExtraDamage[target.id] ?? 0);
        if (!Number.isFinite(extraRaw) || extraRaw < 0 || extraRaw > 1000000) {
          results[target.id] = "Erro: dano extra inválido.";
          continue;
        }
        const finalBaseDamage = Math.min(1000000, attackBaseDamage + Math.floor(extraRaw));
        const needsPhysical = attackConfig.damage_kind === "physical" || attackConfig.damage_kind === "hybrid";
        const needsMagic = attackConfig.damage_kind === "magical" || attackConfig.damage_kind === "hybrid";
        const { data: runtimeResponse, error: damageError } = await supabase.functions.invoke("ability-runtime", {
          body: {
            action: "apply_damage",
            battle_id: battleId,
            _battle_id: battleId,
            _character_id: target.id,
            _damage_kind: attackConfig.damage_kind,
            _damage_type_id: needsMagic ? attackConfig.damage_type_id : null,
            _physical_damage_type_id: needsPhysical ? attackConfig.physical_damage_type_id : null,
            _damage_values: [finalBaseDamage],
            _magic_level: needsMagic ? attackConfig.magic_level : null,
            _source_character_id: characterId,
            _critical_damage: false,
          },
        });
        if (damageError) {
          const context = (damageError as { context?: unknown }).context;
          let message = damageError.message;
          if (context instanceof Response) {
            try {
              const body = await context.clone().json() as { error?: unknown; message?: unknown };
              if (typeof body.error === "string") message = body.error;
              else if (typeof body.message === "string") message = body.message;
            } catch { /* Use the SDK message. */ }
          }
          results[target.id] = `Erro ao aplicar dano: ${message}`;
          continue;
        }
        const damageResult = (runtimeResponse as { damage_result?: { total_damage?: number; hp_before?: number; hp_after?: number; final_damage_by_hit?: number[] } } | null)?.damage_result;
        if (!damageResult) {
          results[target.id] = "Dano enviado, mas sem resultado retornado.";
          continue;
        }
        results[target.id] = `Dano base ${finalBaseDamage} → dano final ${Number(damageResult.total_damage ?? 0)}; HP ${Number(damageResult.hp_before ?? 0)} → ${Number(damageResult.hp_after ?? 0)}.`;
      }

      setAttackResults(results);
      setAttackResolved(true);
      toast.success(hitTargets.length
        ? `${attackAbility.name} resolvida em ${hitTargets.length} alvo(s).${typeof spentMana === "number" && spentMana > 0 ? ` Mana gasta: ${spentMana}.` : ""}`
        : `${attackAbility.name}: ataque sem acertos.${typeof spentMana === "number" && spentMana > 0 ? ` Mana gasta: ${spentMana}.` : ""}`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["character-abilities", characterId] }),
        qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
        qc.invalidateQueries({ queryKey: ["battle-effects"] }),
        qc.invalidateQueries({ queryKey: ["character-active-effects"] }),
        qc.invalidateQueries({ queryKey: ["battles"] }),
        qc.invalidateQueries({ queryKey: ["character", characterId] }),
        qc.invalidateQueries({ queryKey: ["battle-character-public-states"] }),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message);
    } finally {
      setAttackBusy(false);
    }
  }

  async function activate(ability: CharacterAbility) {
    if (!canUse || !ability.can_activate || ability.cooldown_turns <= 0 || ability.cooldown_remaining > 0 || busyId) return;
    if ((ability as CharacterAbility & { once_per_battle?: boolean }).once_per_battle && mode === "combat" && usedOnceAbilityIds.includes(ability.id)) {
      toast.error("Esta habilidade já foi usada neste combate.");
      return;
    }
    setBusyId(ability.id);
    const { data: spentMana, error } = await db.rpc("activate_character_ability", {
      _character_ability_id: ability.id,
      _target_character_id: ability.self_target_only ? characterId : (targetId || characterId),
      _battle_id: mode === "combat" ? battleId ?? null : null,
      _extra_mana_cost: mode === "combat" && ability.mana_cost > 0
        ? Math.max(0, Math.min(1000000, Math.floor(Number(extraManaCosts[ability.id] ?? 0) || 0)))
        : 0,
    });
    setBusyId(null);
    if (error) { toast.error(error.message); return; }
    if ((ability as CharacterAbility & { once_per_battle?: boolean }).once_per_battle && mode === "combat" && battleId) {
      await qc.invalidateQueries({ queryKey: ["battle-ability-uses", battleId, characterId] });
    }
    // O custo extra é enviado apenas nesta ativação; o valor salvo na ficha nunca muda.
    setExtraManaCosts((current) => ({ ...current, [ability.id]: "0" }));
    toast.success(`${ability.name} ativada!${typeof spentMana === "number" && spentMana > 0 ? ` Mana gasta: ${spentMana}.` : ""}`);
    void dispatchCustomAbilityScriptEvents(mode === "combat" ? battleId : null);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["character-abilities", characterId] }),
      qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
      qc.invalidateQueries({ queryKey: ["battle-effects"] }),
      qc.invalidateQueries({ queryKey: ["character-active-effects"] }),
      qc.invalidateQueries({ queryKey: ["battles"] }),
      qc.invalidateQueries({ queryKey: ["character", characterId] }),
      qc.invalidateQueries({ queryKey: ["battle-character-public-states"] }),
    ]);
  }

  if (isLoading) return null;
  if (!loadout?.length && (!showActiveEffects || activeEffects.length === 0)) return null;

  return (
    <section className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-gold">
          <WandSparkles className="h-4 w-4" /> Habilidades
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronUp className="mr-1 h-4 w-4" /> : <ChevronDown className="mr-1 h-4 w-4" />}
          {expanded ? "Minimizar" : "Maximizar"}
        </Button>
      </div>
      {expanded && (
        <div className="space-y-3">
          {mode === "combat" && canUse && hasSelectableTargetAbility && targetOptions.length > 1 && (
            <label className="block space-y-1 text-xs">
              <span className="font-medium text-muted-foreground">Alvo da próxima habilidade</span>
              <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                {targetOptions.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
              </select>
            </label>
          )}
          {showActiveEffects && activeEffects.length > 0 && (
            <div className="space-y-1.5 border-b border-border pb-3">
              <div className="text-xs font-semibold text-muted-foreground">Efeitos ativos no personagem</div>
              <div className="flex flex-wrap gap-1.5">
                {activeEffects.map((effect) => (
                  <span key={effect.id} className="rounded bg-muted px-2 py-1 text-xs">
                    {effect.name} · {(effect as typeof effect & { source_class_id?: string | null }).source_class_id ? "permanente (classe)" : effect.source_race_id ? "permanente (raça)" : effect.until_combat_end ? "até o fim do combate" : `${effect.duration} turno(s)`}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-2">
            {(loadout ?? []).map((ability) => (
              <article key={ability.id} className="rounded-md border border-border bg-muted/20 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{ability.name}</div>
                    {ability.description && <p className="mt-1 text-xs text-muted-foreground">{ability.description}</p>}
                    <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                      {ability.granted_by_virtue_id && (
                        <span className="rounded bg-gold/10 px-2 py-1 text-gold">Concedida por virtude</span>
                      )}
                      <span className={`rounded px-2 py-1 ${ability.is_magical ? "bg-violet-500/10 text-violet-300" : "bg-muted text-muted-foreground"}`}>
                        {ability.is_magical ? "Habilidade Mágica" : "Não mágica"}
                      </span>
                      {ability.can_activate && ability.self_target_only && <span className="rounded bg-muted px-2 py-1">Só em si mesmo</span>}
                      {Boolean((ability as CharacterAbility & { once_per_battle?: boolean }).once_per_battle) && (
                        <span className={`rounded px-2 py-1 ${mode === "combat" && usedOnceAbilityIds.includes(ability.id) ? "bg-muted text-muted-foreground" : "bg-amber-500/10 text-amber-400"}`}>
                          {mode === "combat" && usedOnceAbilityIds.includes(ability.id) ? "Já usada neste combate" : "1 uso por combate"}
                        </span>
                      )}
                  {!ability.can_activate ? (
                        <span className="rounded bg-gold/10 px-2 py-1 text-gold"><Sparkles className="mr-1 inline h-3 w-3" /> Não ativável</span>
                      ) : (
                        <span className={`rounded px-2 py-1 ${ability.cooldown_remaining > 0 ? "bg-muted text-muted-foreground" : "bg-emerald-500/10 text-emerald-500"}`}>
                          <Clock3 className="mr-1 inline h-3 w-3" /> {ability.cooldown_remaining > 0 ? `Cooldown: ${ability.cooldown_remaining} turno(s)` : "Pronta para usar"}
                        </span>
                      )}
                      {ability.can_activate && ability.mana_cost > 0 && <span className="rounded bg-muted px-2 py-1">Custo base: {ability.mana_cost} Mana</span>}
                      {ability.can_activate && !ability.mana_cost && <span className="rounded bg-muted px-2 py-1">Sem custo base de Mana</span>}
                    </div>
                  </div>
                  {canUse && ability.can_activate && (
                    <>
                      <Button size="sm" disabled={busyId !== null || attackBusy || ability.cooldown_turns <= 0 || ability.cooldown_remaining > 0 || (Boolean((ability as CharacterAbility & { once_per_battle?: boolean }).once_per_battle) && mode === "combat" && usedOnceAbilityIds.includes(ability.id))} onClick={() => void activate(ability)}>
                        <Zap className="mr-1 h-3.5 w-3.5" /> {busyId === ability.id ? "Ativando..." : "Ativar"}
                      </Button>
                      {mode === "combat" && battleId && abilityCatalog.some((catalogAbility) => catalogAbility.id === ability.ability_id && catalogAbility.attack_enabled) && (
                        <Button size="sm" variant="outline" disabled={busyId !== null || attackBusy || attackDialogAbilityId !== null || ability.cooldown_turns <= 0 || ability.cooldown_remaining > 0 || (Boolean((ability as CharacterAbility & { once_per_battle?: boolean }).once_per_battle) && usedOnceAbilityIds.includes(ability.id))} onClick={() => openAttackDialog(ability)}>
                          <Swords className="mr-1 h-3.5 w-3.5" /> Atacar
                        </Button>
                      )}
                    </>
                  )}
                </div>
                {mode === "combat" && battleId && (
                  <BattleAbilityOverrideEditor ability={ability} battleId={battleId} defs={defs ?? []} />
                )}
                {allowCustomAttributeEdit && ability.ability_id && (() => {
                  const catalogEntry = abilityCatalog.find((candidate) => candidate.id === ability.ability_id);
                  if (!catalogEntry || !parseCustomAbilityAttributes(catalogEntry.custom_attributes).length) return null;
                  return <CharacterAbilityCustomAttributesEditor
                    ability={ability}
                    definitions={catalogEntry.custom_attributes}
                    multiplier={multiplierForAbility(ability)}
                  />;
                })()}
                {mode === "combat" && ability.can_activate && ability.mana_cost > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-violet-500/30 p-2">
                    <Label className="text-xs">Mana extra nesta utilização</Label>
                    <Input
                      type="number"
                      min={0}
                      max={1000000}
                      className="h-8 w-28"
                      value={extraManaCosts[ability.id] ?? "0"}
                      onChange={(event) => setExtraManaCosts((current) => ({ ...current, [ability.id]: event.target.value }))}
                      disabled={busyId !== null}
                    />
                    <span className="text-xs text-muted-foreground">Total base + extra: {ability.mana_cost + Math.max(0, Math.min(1000000, Math.floor(Number(extraManaCosts[ability.id] ?? 0) || 0)))} Mana. Volta ao normal após usar.</span>
                  </div>
                )}
                {demonioAssignment?.id === ability.id && (
                  <div className="mt-3 space-y-2 rounded-md border border-orange-500/35 bg-orange-500/5 p-3 text-xs">
                    <div className="flex items-center gap-2 font-semibold text-orange-300">
                      <Flame className="h-4 w-4" />
                      Superaquecimento · estado atual
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded border border-border/70 p-2">
                        <div className="text-muted-foreground">Dano acumulado</div>
                        <div className="mt-1 text-lg font-bold tabular text-orange-200">{demonioHeat}</div>
                        <div className="text-muted-foreground">100% do dano final recebido é acumulado; não reduz o dano recebido.</div>
                      </div>
                      <div className="rounded border border-border/70 p-2">
                        <div className="text-muted-foreground">Próximo ataque físico</div>
                        <div className="mt-1 text-lg font-bold tabular text-orange-200">+{demonioBonusDamage} dano</div>
                        <div className="text-muted-foreground">{demonioReflectPercent}% do acumulado, como dano bônus após defesa e mitigação.</div>
                      </div>
                      <div className="col-span-2 rounded border border-border/70 p-2">
                        <div className="flex items-center gap-2 font-medium">
                          <HeartPulse className="h-3.5 w-3.5 text-red-400" />
                          Custo de HP por reflexão
                        </div>
                        <div className="mt-1 text-base font-bold tabular">
                          {demonioHpError
                            ? "Não foi possível calcular"
                            : demonioHpCost === null
                              ? "Calculando HP máximo…"
                              : demonioHeat > 0 && demonioBonusDamage > 0
                                ? `${demonioHpCost} HP`
                                : "0 HP neste momento"}
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            ({demonioHpCostPercent}% do HP máximo{demonioHp ? `: ${demonioHp.maximum} × ${demonioHpCostPercent}%` : ""})
                          </span>
                        </div>
                        {demonioHp && (
                          <div className="text-muted-foreground">
                            HP atual: {demonioHp.current}/{demonioHp.maximum}. O custo é arredondado para cima e só é pago quando houver dano refletido.
                          </div>
                        )}
                        {demonioHpError && (
                          <div className="text-muted-foreground">Confira a conexão ou atualize a página para recalcular o custo.</div>
                        )}
                      </div>
                    </div>
                    <div className="text-muted-foreground">
                      O superaquecimento só é gasto ao refletir dano no próximo golpe físico; ataques não físicos não usam a reserva nem cobram HP.
                    </div>
                  </div>
                )}
                {ability.can_activate && ability.effects.length > 0 && (
                  <div className="mt-2 space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
                    <div className="font-semibold">Efeitos ao ativar</div>
                    {ability.effects.map((effect, index) => <div key={index}>{effectSummary(effect, defs ?? [], damageTypes, races)} · Destino: {effect.target_scope === "caster" ? "Caster" : effect.target_scope === "both" ? "Ambos" : "Alvo"}{effect.effect_type === "healing" && effect.healing_timing !== "per_turn" ? "" : ` · ${effect.until_combat_end ? "até o fim do combate" : `${effect.duration} turno(s)`}`}</div>)}
                  </div>
                )}
                {ability.passive_effects.length > 0 && (
                  <div className="mt-2 space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
                    <div className="font-semibold text-gold">Efeitos passivos · permanentes</div>
                    {ability.passive_effects.map((effect, index) => <div key={index}>{effectSummary(effect, defs ?? [], damageTypes, races)}</div>)}
                  </div>
                )}
                {ability.end_effects.length > 0 && ability.can_activate && (
                  <div className="mt-2 space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
                    <div className="font-semibold text-gold">Efeitos quando a habilidade acaba</div>
                    {ability.end_effects.map((effect, index) => <div key={index}>{effectSummary(effect, defs ?? [], damageTypes, races)} · Destino: {effect.target_scope === "caster" ? "Caster" : effect.target_scope === "both" ? "Ambos" : "Alvo"}{effect.effect_type === "healing" && effect.healing_timing !== "per_turn" ? "" : ` · ${effect.until_combat_end ? "até o fim do combate" : `${effect.duration} turno(s)`}`}</div>)}
                  </div>
                )}
              </article>
            ))}
          </div>
        </div>
      )}
      
      <Dialog open={attackDialogAbilityId !== null} onOpenChange={(open) => {
        if (!open && !attackBusy) setAttackDialogAbilityId(null);
      }}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-gold">Ataque: {attackAbility?.name ?? "Habilidade"}</DialogTitle>
            <DialogDescription>
              {characterName} lança o ataque. O mestre marca quem foi atingido; somente esses alvos recebem dano e efeitos direcionados ao alvo.
            </DialogDescription>
          </DialogHeader>
          {!attackAbility || !attackConfig ? (
            <p className="text-sm text-muted-foreground">Não foi possível carregar a configuração de dano desta habilidade.</p>
          ) : (
            <div className="space-y-4">
              <section className="space-y-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-gold"><Crosshair className="h-4 w-4" /> Selecionar alvos</h3>
                {eligibleAttackTargets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Não há outros personagens nesta batalha.</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {eligibleAttackTargets.map((target) => {
                      const selected = attackTargetIds.includes(target.id);
                      return (
                        <label key={target.id} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${selected ? "border-gold bg-gold/5" : "border-border"}`}>
                          <input type="checkbox" checked={selected} disabled={attackResolved || attackBusy}
                            onChange={(event) => {
                              setAttackTargetIds((current) => event.target.checked
                                ? [...new Set([...current, target.id])]
                                : current.filter((id) => id !== target.id));
                              if (!event.target.checked) {
                                setAttackHits((current) => { const next = { ...current }; delete next[target.id]; return next; });
                                setAttackExtraDamage((current) => { const next = { ...current }; delete next[target.id]; return next; });
                              }
                            }} />
                          <span className="min-w-0 flex-1">{target.name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>
              {currentAttackTargets.length > 0 && (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-gold">Dados para lançar e esquivar</h3>
                  {currentAttackTargets.map((target) => {
                    const attackSpeed = statValue(characterId, "atk_speed");
                    const targetSpeed = statValue(target.id, "speed");
                    const attackMod = diceModifier(attackSpeed, targetSpeed);
                    const dodgeMod = diceModifier(targetSpeed, attackSpeed);
                    const extra = Math.max(0, Math.min(1000000, Math.floor(Number(attackExtraDamage[target.id] ?? 0) || 0)));
                    const damage = Math.min(1000000, attackBaseDamage + extra);
                    return (
                      <article key={target.id} className="space-y-3 rounded-md border border-border p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold">{target.name}</div>
                            <div className="mt-1 text-xs text-muted-foreground">Lançamento: ({attackSpeed} Velocidade de Ataque − {targetSpeed} Velocidade) ÷ 10, mínimo 0</div>
                            <div className="text-xs text-muted-foreground">Esquiva: ({targetSpeed} Velocidade − {attackSpeed} Velocidade de Ataque) ÷ 10, mínimo 0</div>
                          </div>
                          <Button size="sm" variant="outline" onClick={() => copyAttackRoll(target)} disabled={attackBusy}>
                            <Copy className="mr-1 h-3.5 w-3.5" /> Copiar dados
                          </Button>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <div className="rounded-md bg-muted/40 p-3">
                            <div className="text-xs text-muted-foreground">Dado de quem lança</div>
                            <div className="font-display text-2xl text-gold">{diceText(attackMod)}</div>
                          </div>
                          <div className="rounded-md bg-muted/40 p-3">
                            <div className="text-xs text-muted-foreground">Dado de esquiva</div>
                            <div className="font-display text-2xl text-gold">{diceText(dodgeMod)}</div>
                          </div>
                        </div>
                        <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                          <input type="checkbox" checked={attackHits[target.id] === true} disabled={attackResolved || attackBusy}
                            onChange={(event) => setAttackHits((current) => ({ ...current, [target.id]: event.target.checked }))} />
                          <span className="font-semibold">Acertou</span>
                          <span className="text-xs text-muted-foreground">— aplica dano e efeitos de alvo</span>
                        </label>
                        {attackHits[target.id] && (
                          <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
                            <label className="space-y-1 text-xs font-medium">
                              Dano extra deste alvo
                              <Input type="number" min={0} max={1000000} disabled={attackResolved || attackBusy}
                                value={attackExtraDamage[target.id] ?? "0"}
                                onChange={(event) => setAttackExtraDamage((current) => ({ ...current, [target.id]: event.target.value }))} />
                            </label>
                            <div className="rounded-md border border-gold/30 bg-gold/5 p-3">
                              <div className="text-xs text-muted-foreground">Dano base calculado</div>
                              <div className="text-lg font-bold text-gold">{damage}</div>
                              <div className="text-[11px] text-muted-foreground">
                                {attackConfig.attribute_key
                                  ? `${attackConfig.attribute_percent}% de ${defs?.find((def) => def.key === attackConfig.attribute_key)?.label ?? attackConfig.attribute_key} (${statValue(characterId, attackConfig.attribute_key)})`
                                  : "Sem atributo de origem"} + ${attackConfig.fixed_damage} fixos + ${extra} extra; antes de defesa/mitigação
                              </div>
                            </div>
                          </div>
                        )}
                        {attackResults[target.id] && <p className={`text-xs ${attackResults[target.id].startsWith("Erro") ? "text-destructive" : "text-emerald-500"}`}>{attackResults[target.id]}</p>}
                      </article>
                    );
                  })}
                </section>
              )}
              <div className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                Tipo configurado: {attackConfig.damage_kind === "physical" ? "Físico" : attackConfig.damage_kind === "magical" ? "Mágico" : attackConfig.damage_kind === "hybrid" ? "Híbrido" : "Verdadeiro"}
                {attackConfig.damage_kind === "physical" || attackConfig.damage_kind === "hybrid"
                  ? ` · Físico: ${damageTypes.find((type) => type.id === attackConfig.physical_damage_type_id)?.name ?? "tipo não configurado"}`
                  : ""}
                {attackConfig.damage_kind === "magical" || attackConfig.damage_kind === "hybrid"
                  ? ` · Mágico: ${damageTypes.find((type) => type.id === attackConfig.damage_type_id)?.name ?? "tipo não configurado"} · grau ${attackConfig.magic_level}`
                  : ""}
              </div>
              {attackResolved && !Object.values(attackResults).some((result) => result.startsWith("Erro")) && (
                <p className="text-sm text-emerald-500">Ataque resolvido. Você pode fechar esta janela pelo X quando terminar.</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAttackDialogAbilityId(null)} disabled={attackBusy}>Fechar</Button>
            <Button onClick={() => void resolveAbilityAttack()} disabled={attackBusy || attackResolved || !attackAbility || !attackConfig || attackTargetIds.length === 0 || !battleId}>
              <Swords className="mr-1 h-4 w-4" />
              {attackBusy ? "Resolvendo..." : currentAttackTargets.some((target) => attackHits[target.id]) ? "Causou dano" : "Finalizar ataque sem acertos"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function CharacterAbilitiesManager({ characterId, personalOnly = false }: { characterId: string; personalOnly?: boolean }) {
  const qc = useQueryClient();
  const { data: allAbilities = [], isLoading: catalogLoading } = useAbilities();
  const { data: assigned = [], isLoading: assignedLoading } = useCharacterAbilities(characterId);
  const { data: defs } = useDefs();
  const [expanded, setExpanded] = useState(true);
  const [customName, setCustomName] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [creatingCustom, setCreatingCustom] = useState(false);
  const db = supabase as any;
  const assignedIds = new Set(assigned.map((ability) => ability.ability_id).filter(Boolean));
  const managedAssigned = personalOnly
    ? assigned.filter((ability) => {
        const row = ability as CharacterAbility & { granted_by_transformation_id?: string | null };
        return !ability.ability_id && !ability.granted_by_virtue_id && !ability.granted_by_race_id && !row.granted_by_transformation_id;
      })
    : assigned;
  const available = personalOnly ? [] : allAbilities.filter((ability) => !assignedIds.has(ability.id));

  async function give(ability: Ability) {
    const { error } = await db.from("character_abilities").insert({
      character_id: characterId,
      ability_id: ability.id,
      name: ability.name,
      description: ability.description,
      can_activate: ability.can_activate,
      self_target_only: ability.self_target_only,
      is_magical: ability.is_magical,
      is_passive: !ability.can_activate,
      cooldown_turns: ability.can_activate ? ability.cooldown_turns : 0,
      cooldown_remaining: 0,
      mana_cost: ability.can_activate ? ability.mana_cost : 0,
      effects: ability.effects,
      passive_effects: ability.passive_effects,
      end_effects: ability.end_effects,
      once_per_battle: Boolean((ability as Ability & { once_per_battle?: boolean }).once_per_battle),
    });
    if (error) { toast.error(error.message); return; }
    toast.success(`${ability.name} adicionada à ficha`);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["character-abilities", characterId] }),
      qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
    ]);
  }

  async function createCustomAbility() {
    const cleanName = customName.trim();
    if (!cleanName) { toast.error("Informe o nome da habilidade exclusiva"); return; }
    setCreatingCustom(true);
    const { error } = await db.from("character_abilities").insert({
      character_id: characterId,
      ability_id: null,
      name: cleanName,
      description: customDescription.trim() || null,
      can_activate: true,
      self_target_only: false,
      is_magical: true,
      is_passive: false,
      cooldown_turns: 1,
      cooldown_remaining: 0,
      mana_cost: 0,
      effects: [],
      passive_effects: [],
      end_effects: [],
      once_per_battle: false,
    });
    setCreatingCustom(false);
    if (error) { toast.error(error.message); return; }
    setCustomName("");
    setCustomDescription("");
    toast.success("Habilidade exclusiva criada nesta ficha");
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["character-abilities", characterId] }),
      qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
    ]);
  }

  if (!defs) return null;
  return (
    <section className="panel space-y-4 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg text-gold"><WandSparkles className="h-5 w-5" /> {personalOnly ? "Habilidades exclusivas do personagem" : "Habilidades da ficha"}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{personalOnly ? "Crie e configure habilidades que pertencem somente a esta ficha." : "Adicione habilidades do catálogo. Depois, personalize custo, cooldown e efeitos para este personagem."}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="shrink-0"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronUp className="mr-1 h-4 w-4" /> : <ChevronDown className="mr-1 h-4 w-4" />}
          {expanded ? "Minimizar" : "Maximizar"}
        </Button>
      </div>
      {expanded && (
        <div className="space-y-4">
          <div className="space-y-2 rounded-md border border-gold/30 p-3">
            <Label>Habilidade exclusiva deste personagem</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="Nome da habilidade" />
              <Input value={customDescription} onChange={(event) => setCustomDescription(event.target.value)} placeholder="Descrição (opcional)" />
            </div>
            <Button size="sm" onClick={() => void createCustomAbility()} disabled={creatingCustom}>
              <Plus className="mr-1 h-3.5 w-3.5" /> {creatingCustom ? "Criando..." : "Criar habilidade exclusiva"}
            </Button>
            <p className="text-xs text-muted-foreground">Ela existe apenas nesta ficha e pode ser configurada abaixo, sem entrar no catálogo geral.</p>
          </div>
          {catalogLoading || assignedLoading ? <p className="text-sm text-muted-foreground">Carregando habilidades…</p> : !personalOnly && available.length > 0 ? (
            <div className="space-y-2">
              <Label>Adicionar do catálogo</Label>
              <div className="flex flex-wrap gap-2">
                {available.map((ability) => (
                  <Button key={ability.id} size="sm" variant="outline" onClick={() => void give(ability)}>
                    <Plus className="mr-1 h-3.5 w-3.5" /> {ability.name}
                  </Button>
                ))}
              </div>
            </div>
          ) : !personalOnly ? (
            <p className="text-xs text-muted-foreground">{allAbilities.length ? "Todas as habilidades do catálogo já foram atribuídas." : "O mestre ainda não cadastrou habilidades."}</p>
          ) : null}
          <div className="space-y-3">
            {managedAssigned.map((ability) => <AssignedAbilityEditor key={ability.id} ability={ability} defs={defs!} />)}
          </div>
        </div>
      )}
    </section>
  );
}

function AssignedAbilityEditor({ ability, defs }: { ability: CharacterAbility; defs: NonNullable<ReturnType<typeof useDefs>["data"]> }) {
  const qc = useQueryClient();
  const [name, setName] = useState(ability.name);
  const [description, setDescription] = useState(ability.description ?? "");
  const [canActivate, setCanActivate] = useState(ability.can_activate);
  const [oncePerBattle, setOncePerBattle] = useState(Boolean((ability as CharacterAbility & { once_per_battle?: boolean }).once_per_battle));
  const [isMagical, setIsMagical] = useState(ability.is_magical);
  const [selfTargetOnly, setSelfTargetOnly] = useState(ability.self_target_only);
  const [cooldown, setCooldown] = useState(String(ability.cooldown_turns));
  const [manaCost, setManaCost] = useState(String(ability.mana_cost));
  const [effects, setEffects] = useState<AbilityEffectDefinition[]>(ability.effects);
  const [passiveEffects, setPassiveEffects] = useState<AbilityEffectDefinition[]>(ability.passive_effects);
  const [endEffects, setEndEffects] = useState<AbilityEffectDefinition[]>(ability.end_effects);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    setName(ability.name);
    setDescription(ability.description ?? "");
    setCanActivate(ability.can_activate);
    setOncePerBattle(Boolean((ability as CharacterAbility & { once_per_battle?: boolean }).once_per_battle));
    setIsMagical(ability.is_magical);
    setSelfTargetOnly(ability.self_target_only);
    setCooldown(String(ability.cooldown_turns));
    setManaCost(String(ability.mana_cost));
    setEffects(parseAbilityEffects(ability.effects));
    setPassiveEffects(parseAbilityEffects(ability.passive_effects));
    setEndEffects(parseAbilityEffects(ability.end_effects));
  }, [ability]);

  async function save() {
    const cooldownTurns = canActivate ? Math.floor(Number(cooldown)) : 0;
    const cost = Math.floor(Number(manaCost));
    if (!name.trim()) { toast.error("Informe o nome"); return; }
    if (!Number.isFinite(cost) || cost < 0) { toast.error("Custo de Mana inválido"); return; }
    if (canActivate && (!Number.isFinite(cooldownTurns) || cooldownTurns < 1)) { toast.error("Habilidade ativável precisa ter cooldown de pelo menos 1 turno"); return; }
    const canTriggerEndEffects = effects.some((effect) =>
      effect.effect_type !== "healing" || effect.healing_timing === "per_turn"
    );
    if (canActivate && endEffects.length > 0 && !canTriggerEndEffects) {
      toast.error("Efeitos de encerramento precisam de pelo menos um efeito ativo com duração. Uma cura instantânea sozinha não tem duração para encerrar.");
      return;
    }
    const hasInvalidHealing = [...effects, ...endEffects].some((effect) =>
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
    setBusy(true);
    const db = supabase as any;
    const { error } = await db.from("character_abilities").update({
      name: name.trim(),
      once_per_battle: canActivate && oncePerBattle,
      description: description.trim() || null,
      can_activate: canActivate,
      is_magical: isMagical,
      self_target_only: canActivate && selfTargetOnly,
      is_passive: !canActivate,
      cooldown_turns: cooldownTurns,
      cooldown_remaining: canActivate ? Math.min(ability.cooldown_remaining, cooldownTurns) : 0,
      mana_cost: canActivate ? cost : 0,
      effects: effects.map((effect) => ({ ...effect, duration: Math.max(1, effect.duration) })) as unknown as Json,
      passive_effects: passiveEffects.map((effect) => ({ ...effect, duration: 1 })) as unknown as Json,
      end_effects: endEffects.map((effect) => ({ ...effect, duration: Math.max(1, effect.duration) })) as unknown as Json,
    }).eq("id", ability.id);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Habilidade desta ficha atualizada");
    await qc.invalidateQueries({ queryKey: ["character-abilities", ability.character_id] });
    await qc.invalidateQueries({ queryKey: ["character-abilities-battle"] });
    await qc.invalidateQueries({ queryKey: ["character-active-effects", ability.character_id] });
  }

  async function setCooldownRemaining(next: number) {
    const value = Math.max(0, Math.min(ability.cooldown_turns, Math.floor(next)));
    const previousValue = ability.cooldown_remaining;
    const { error } = await supabase.from("character_abilities").update({ cooldown_remaining: value }).eq("id", ability.id);
    if (error) { toast.error(error.message); return; }
    if (previousValue > 0 && value === 0) {
      // The database removes Coração Corrompido's bonus immediately and queues
      // habilidade_saiu_do_cooldown; dispatch it for manual cooldown edits too.
      void dispatchCustomAbilityScriptEvents();
    }
    await qc.invalidateQueries({ queryKey: ["character-abilities", ability.character_id] });
    await qc.invalidateQueries({ queryKey: ["character-abilities-battle"] });
    toast.success(value === 0 ? "Cooldown zerado" : `Cooldown: ${value} turno(s)`);
  }

  async function remove() {
    if (!confirm(`Remover "${ability.name}" desta ficha?`)) return;
    const { error } = await supabase.from("character_abilities").delete().eq("id", ability.id);
    if (error) { toast.error(error.message); return; }
    await qc.invalidateQueries({ queryKey: ["character-abilities", ability.character_id] });
    await qc.invalidateQueries({ queryKey: ["character-abilities-battle"] });
    await qc.invalidateQueries({ queryKey: ["character-active-effects", ability.character_id] });
    toast.success("Habilidade removida da ficha");
  }

  return (
    <article className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold">{ability.name}</div>
          <div className="text-xs text-muted-foreground">{ability.is_magical ? "Habilidade Mágica · " : "Não mágica · "}{ability.granted_by_virtue_id ? "Concedida por virtude · " : ""}{ability.can_activate ? `Cooldown atual: ${ability.cooldown_remaining}/${ability.cooldown_turns}` : "Não ativável · efeitos passivos permanentes"}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={expanded}
            aria-label={expanded ? `Minimizar ${ability.name}` : `Maximizar ${ability.name}`}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronUp className="mr-1 h-4 w-4" /> : <ChevronDown className="mr-1 h-4 w-4" />}
            {expanded ? "Minimizar" : "Maximizar"}
          </Button>
          <Button size="icon" variant="ghost" aria-label="Remover habilidade desta ficha" onClick={() => void remove()}><Trash2 className="h-4 w-4" /></Button>
        </div>
      </div>
      {expanded && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1"><Label>Nome nesta ficha</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <label className="flex min-h-10 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={!canActivate} onChange={(e) => {
            const notActivatable = e.target.checked;
            setCanActivate(!notActivatable);
            setCooldown(notActivatable ? "0" : (Number(cooldown) > 0 ? cooldown : "1"));
            if (notActivatable) setManaCost("0");
          }} />
          Habilidade não ativável nesta ficha
        </label>
        <label className="flex min-h-10 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={isMagical} onChange={(e) => setIsMagical(e.target.checked)} />
          Habilidade Mágica
        </label>
        {canActivate && (
          <label className="flex min-h-10 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={selfTargetOnly} onChange={(e) => setSelfTargetOnly(e.target.checked)} />
            Só pode ser usada no próprio personagem
          </label>
        )}
        {canActivate && (
          <label className="flex min-h-10 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={oncePerBattle} onChange={(e) => setOncePerBattle(e.target.checked)} />
            Só pode ser usada 1 vez por combate
          </label>
        )}
        {canActivate && <div className="space-y-1"><Label>Custo base de Mana</Label><Input type="number" min="0" value={manaCost} onChange={(e) => setManaCost(e.target.value)} /></div>}
        {!canActivate && <p className="text-xs text-muted-foreground">Não ativável: não gasta Mana nem possui cooldown; seus efeitos passivos continuam funcionando.</p>}
        {canActivate && <div className="space-y-1"><Label>Cooldown máximo (turnos)</Label><Input type="number" min="1" value={cooldown} onChange={(e) => setCooldown(e.target.value)} /></div>}
        <div className="space-y-1 sm:col-span-2"><Label>Descrição para este jogador</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      </div>
      {canActivate && <AbilityEffectsEditor
        effects={effects}
        onChange={setEffects}
        permanent={false}
        title="Efeitos ao ativar"
        description="Aplicados ao alvo escolhido quando esta habilidade for ativada."
        defs={defs}
      />}
      {canActivate && <AbilityEffectsEditor
        effects={endEffects}
        onChange={setEndEffects}
        permanent={false}
        title="Efeitos quando a habilidade acaba"
        description="Aplicados ao destino escolhido quando todos os efeitos desta ativação terminarem."
        defs={defs}
        allowPeriodicHealing={false}
      />}
      <AbilityEffectsEditor
        effects={passiveEffects}
        onChange={setPassiveEffects}
        permanent
        title="Efeitos passivos"
        description="Aplicados continuamente enquanto a habilidade estiver atribuída a esta ficha."
        defs={defs}
        allowHealing={false}
      />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void save()}>{busy ? "Salvando..." : "Salvar valores desta ficha"}</Button>
            {ability.can_activate && ability.cooldown_remaining > 0 && <Button size="sm" variant="outline" onClick={() => void setCooldownRemaining(Math.max(0, ability.cooldown_remaining - 1))}><Minus className="mr-1 h-3.5 w-3.5" /> Reduzir cooldown</Button>}
            {ability.can_activate && ability.cooldown_remaining > 0 && <Button size="sm" variant="outline" onClick={() => void setCooldownRemaining(0)}><Check className="mr-1 h-3.5 w-3.5" /> Zerar cooldown</Button>}
          </div>
        </div>
      )}
    </article>
  );
}


function BattleAbilityOverrideEditor({ ability, battleId, defs }: { ability: CharacterAbility; battleId: string; defs: NonNullable<ReturnType<typeof useDefs>["data"]> }) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const db = supabase as any;
  const [open, setOpen] = useState(false);
  const [manaCost, setManaCost] = useState(String(ability.mana_cost));
  const [effects, setEffects] = useState<AbilityEffectDefinition[]>(parseAbilityEffects(ability.effects));
  const [endEffects, setEndEffects] = useState<AbilityEffectDefinition[]>(parseAbilityEffects(ability.end_effects));
  const [keepAfterUse, setKeepAfterUse] = useState(false);
  const [saving, setSaving] = useState(false);
  const { data: existing } = useQuery({
    queryKey: ["battle-ability-override", battleId, ability.id],
    enabled: !!me?.isMaster && open,
    queryFn: async () => {
      const { data, error } = await db.from("battle_ability_overrides").select("override_values,keep_after_use")
        .eq("battle_id", battleId).eq("character_ability_id", ability.id).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  useEffect(() => {
    const values = existing?.override_values && typeof existing.override_values === "object" ? existing.override_values as Record<string, unknown> : {};
    setManaCost(String(values.mana_cost ?? ability.mana_cost));
    setEffects(parseAbilityEffects(values.effects ?? ability.effects));
    setEndEffects(parseAbilityEffects(values.end_effects ?? ability.end_effects));
    setKeepAfterUse(Boolean(existing?.keep_after_use));
  }, [existing, ability.id, ability.mana_cost, ability.effects, ability.end_effects]);

  if (!me?.isMaster) return null;
  async function saveOverride() {
    const cost = Math.floor(Number(manaCost));
    if (!Number.isFinite(cost) || cost < 0 || cost > 1000000) { toast.error("O custo de Mana deve ficar entre 0 e 1.000.000"); return; }
    setSaving(true);
    const { error } = await db.from("battle_ability_overrides").upsert({
      battle_id: battleId,
      character_ability_id: ability.id,
      override_values: {
        mana_cost: cost,
        effects: effects.map((effect) => ({ ...effect, duration: Math.max(1, effect.duration) })),
        end_effects: endEffects.map((effect) => ({ ...effect, duration: Math.max(1, effect.duration) })),
      },
      keep_after_use: keepAfterUse,
      updated_at: new Date().toISOString(),
    }, { onConflict: "battle_id,character_ability_id" });
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success(keepAfterUse ? "Alterações mantidas durante este combate" : "Alterações serão usadas uma vez e depois restauradas");
    await qc.invalidateQueries({ queryKey: ["battle-ability-override", battleId, ability.id] });
    setOpen(false);
  }
  async function resetOverride() {
    const { error } = await db.from("battle_ability_overrides").delete().eq("battle_id", battleId).eq("character_ability_id", ability.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Valores originais restaurados");
    await qc.invalidateQueries({ queryKey: ["battle-ability-override", battleId, ability.id] });
    setOpen(false);
  }
  return (
    <div className="mt-3">
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen((value) => !value)}>
        {open ? "Fechar mudança de valores" : "Mudar valores"}
      </Button>
      {open && (
        <div className="mt-3 space-y-4 rounded-md border border-amber-500/35 bg-amber-500/5 p-3">
          <div>
            <h4 className="font-semibold text-amber-300">Alterações temporárias de combate</h4>
            <p className="mt-1 text-xs text-muted-foreground">Esses valores não alteram a ficha permanente e são apagados quando o combate termina.</p>
          </div>
          <div className="space-y-1">
            <Label>Custo de Mana nesta batalha</Label>
            <Input type="number" min={0} max={1000000} value={manaCost} onChange={(event) => setManaCost(event.target.value)} />
          </div>
          <AbilityEffectsEditor effects={effects} onChange={setEffects} permanent={false} title="Efeitos alterados nesta batalha" description="Os atributos afetados por esses efeitos também são temporários." defs={defs} />
          <AbilityEffectsEditor effects={endEffects} onChange={setEndEffects} permanent={false} title="Efeitos ao terminar" description="Efeitos de encerramento temporários para esta batalha." defs={defs} allowPeriodicHealing={false} />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={keepAfterUse} onChange={(event) => setKeepAfterUse(event.target.checked)} />
            <span><strong>Manter Alterações</strong><span className="block text-xs text-muted-foreground">Marcado: usar os valores alterados nas próximas ativações. Desmarcado: usar uma vez e restaurar os valores originais.</span></span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void saveOverride()} disabled={saving}>{saving ? "Salvando..." : "Salvar alterações"}</Button>
            <Button size="sm" variant="outline" onClick={() => void resetOverride()}>Restaurar valores originais</Button>
          </div>
        </div>
      )}
    </div>
  );
}
