import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock3, Copy, Crosshair, Flame, HeartPulse, Minus, Plus, Sparkles, Swords, Trash2, WandSparkles, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SearchableGrantPicker } from "@/components/ui/searchable-grant-picker";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { dispatchCustomAbilityScriptEvents } from "@/lib/ability-script-runtime";
import { applyAbilityTargetDamage, isValidAbilityTargetAdjustment, shouldApplyAbilityDirectDamage } from "@/lib/ability-attack-damage";
import { addDefenseIgnore, defenseIgnoreText, ZERO_DEFENSE_IGNORE, type DefenseIgnore } from "@/lib/defense-ignore";
import { DefenseIgnoreInputs } from "@/components/abilities/DefenseIgnoreInputs";
import { attackDiceModifier } from "@/lib/combat-dice";
import { sedentoInvincibilityCooldown } from "@/lib/sedento-invincibility";
import { useDefs, useMe, useRaces, useClasses, useVirtues } from "@/lib/sheets";
import { parseAbilityEffects, parseAbilityAttackDamage, parseAbilityAttackEffectGroups, parseAbilityDotEffects, useAbilities, useCharacterAbilities, useCharacterActiveEffects, useDamageTypes, useDotTemplates, type Ability, type AbilityEffectDefinition, type CharacterAbility, type AbilityDotEffect, type AbilityAttackDamageConfig, type AbilityAttackEffectGroup } from "@/lib/abilities";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import { ContinuousRulesEditor } from "@/components/abilities/ContinuousRulesEditor";
import { parseContinuousRules, type ContinuousRule, type ContinuousInstance } from "@/lib/continuous-effects";
import { planContinuousTargetTransfer, validateTransferSelection, type TransferRequirement } from "@/lib/continuous-target-transfer";
import { parseAttributeStatusModifiers } from "@/lib/multi-attribute-effects";
import { ActivationEffectValuesDialog, type ActivationEffectOverrides } from "@/components/abilities/ActivationEffectValuesDialog";
import { customizableActivationEffects } from "@/lib/activation-effect-values";
import { SheetAbilityAttackEditor } from "@/components/abilities/SheetAbilityAttackEditor";
import { TemporaryAttackCategoryEditor } from "@/components/abilities/TemporaryAttackCategoryEditor";
import { TemporaryGuaranteedDotsEditor } from "@/components/abilities/TemporaryGuaranteedDotsEditor";
import { findRegisteredDotTemplate, registerAbilityDotTemplates } from "@/lib/ability-dot-templates";
import type { Json } from "@/integrations/supabase/types";
import { CUSTOM_ABILITY_SCRIPTS, parseCustomAbilityAttributes, type CustomAbilityAttribute } from "@/lib/custom-ability-scripts";

/** Supabase PostgrestError is a plain object, not an Error instance. */
function friendlyAbilityError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [value.message,value.details,value.hint].filter(
      (part): part is string => typeof part === "string" && part.trim().length > 0,
    );
    if (parts.length) return [...new Set(parts)].join(" · ");
    if (typeof value.code === "string") return "Erro ao processar ataque ("+value.code+").";
  }
  return "Não foi possível concluir o ataque. Confira os vínculos e tente novamente.";
}

/** Visible on the character sheet and in combat; only uses persistent script
 * state and the character's individual turn, never the ability's toggle cooldown.
 */
function SedentoInvincibilityInfo({
  ability, mode, battleId, individualTurn, activeEffects,
}: {
  ability: CharacterAbility;
  mode: "sheet" | "combat";
  battleId?: string;
  individualTurn?: number;
  activeEffects: Array<{ id: string; effect_type: string; name: string; duration: number; source_character_ability_id: string | null }>;
}) {
  const state = ability.custom_state && typeof ability.custom_state === "object"
    && !Array.isArray(ability.custom_state)
    ? ability.custom_state as Record<string, unknown>
    : {};
  const stateBattleId = typeof state.sedento_battle_id === "string"
    ? state.sedento_battle_id : null;
  const currentBattleId = mode === "combat" ? battleId ?? null : stateBattleId;
  const { data: sheetTurn, isPending: sheetTurnPending } = useQuery<number | null>({
    queryKey: ["sedento-invincibility-turn", ability.character_id, currentBattleId],
    enabled: mode === "sheet" && !!currentBattleId,
    queryFn: async () => {
      const [battle, participant] = await Promise.all([
        supabase.from("battles").select("active").eq("id", currentBattleId!).maybeSingle(),
        supabase.from("battle_participants").select("turn_count")
          .eq("battle_id", currentBattleId!).eq("character_id", ability.character_id).maybeSingle(),
      ]);
      if (battle.error) throw battle.error;
      if (participant.error) throw participant.error;
      if (!battle.data?.active || !participant.data) return null;
      return participant.data.turn_count ?? 0;
    },
    refetchInterval: mode === "sheet" ? 5000 : false,
  });
  const currentTurn = mode === "combat" ? individualTurn ?? null : sheetTurn ?? null;
  const cooldown = sedentoInvincibilityCooldown(state, currentBattleId, currentTurn);
  const hasTurn = cooldown.initialized && cooldown.remaining !== null;
  const isReady = hasTurn && cooldown.remaining === 0;
  const invincibility = activeEffects.find((effect) =>
    effect.effect_type === "invincible"
    && effect.source_character_ability_id === ability.id
    && (mode !== "combat" || !!battleId)
  );

  return (
    <div className="mt-3 space-y-1.5 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2 font-semibold">
        <HeartPulse className="h-4 w-4 text-red-400" />
        <span>Invencibilidade · Sedento por Sangue</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-1 font-semibold ${isReady ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-foreground"}`}>
          {hasTurn
            ? isReady
              ? "Recarga interna: pronta (0 turnos)"
              : `Recarga interna: faltam ${cooldown.remaining} turno(s)`
            : mode === "sheet" && currentBattleId && sheetTurnPending
              ? "Consultando turnos do combate..."
              : "Recarga interna: sem contador neste combate"}
        </span>
        <span className="rounded bg-muted px-2 py-1 text-muted-foreground">
          Habilidade {ability.toggle_active ? "ligada" : "desligada"}
        </span>
      </div>
      {invincibility && (
        <p className="font-semibold text-emerald-400">
          Invencibilidade ATIVA · {invincibility.duration} turno(s) restante(s)
        </p>
      )}
      {hasTurn ? (
        <p className="text-muted-foreground">
          Turno individual atual: {cooldown.currentTurn} · Invencibilidade disponível novamente no turno {cooldown.readyAt}.
        </p>
      ) : (
        <p className="text-muted-foreground">
          {mode === "sheet" && sheetTurn === null
            ? "Sem combate ativo para acompanhar o contador. Ele é calculado pelos turnos individuais."
            : "O contador aparece assim que a habilidade é ativada e o script registra o início do combate."}
        </p>
      )}
      <p className="text-muted-foreground">
        Estar pronta não ativa o efeito sozinho: a habilidade precisa estar ligada e o HP deve atingir o limite configurado.
        Esta recarga é independente do cooldown para ligar/desligar.
      </p>
    </div>
  );
}

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
    attribute.type === "number" && attribute.scale_with_race !== false && attribute.malefico !== true
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
                {ability.granted_by_virtue_id && multiplier > 1 && attribute.scale_with_race !== false && attribute.malefico !== true && (
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
  if (effect.effect_type === "visual_tag") return `🏷️ ${effect.name}`;
  if (effect.effect_type === "temporal_freeze") return `${effect.name}: Congelamento temporal · imune a dano e a perdas de Mana/Corpo`;
  const amount = effect.value_mode === "percent" ? `${effect.amount}%` : effect.effect_type === "damage_dealt" ? String(effect.amount) : (effect.effect_type === "mana_regeneration" || effect.effect_type === "mana_used") ? `${effect.amount} Mana` : `${effect.amount} pontos`;
  const polarity = effect.polarity === "buff" ? "+" : "−";
  if (effect.effect_type === "status") {
    const rows = parseAttributeStatusModifiers(effect.attribute_modifiers);
    if (rows.length) return `${effect.name}: ${rows.map((item) =>
      `${polarity}${item.amount}${item.value_mode === "percent" ? "%" : ""} ${defs.find((def) => def.key === item.attribute_key)?.label ?? item.attribute_key}`
    ).join(" · ")}`;
    return `${effect.name}: ${polarity}${amount} em ${defs.find((d) => d.key === effect.attribute_key)?.label ?? effect.attribute_key}`;
  }
  if (effect.effect_type === "regeneration") return `${effect.name}: regeneração ${polarity}${amount} de ${effect.attribute_key === "mana" ? "Mana" : "HP"}`;
  if (effect.effect_type === "mana_regeneration") return `${effect.name}: regeneração de Mana ${polarity}${amount}`;
  if (effect.effect_type === "mana_used") return `${effect.name}: Mana usada ${effect.polarity === "buff" ? "−" : "+"}${amount}`;
  if (effect.effect_type === "damage_dealt") {
    const scope = effect.damage_scope === "physical" ? "dano físico" : effect.damage_scope === "magical" ? "dano mágico" : "qualquer dano";
    return `${effect.name}: ${polarity}${amount} de dano causado (${scope})`;
  }
  if (effect.effect_type === "dot_resistance") return `${effect.name}: resistência a DoTs — ${effect.dot_resistance_mode === "duration" ? "reduz duração" : "reduz dano"} em ${effect.dot_resistance_amount ?? effect.amount}${(effect.dot_resistance_value_mode ?? effect.value_mode) === "percent" ? "%" : " fixos"} (${effect.dot_resistance_scope ?? "all"})`;
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
    if ((effect.healing_relieve_debuff_percent ?? 0) > 0) parts.push(`alivia intensidade de debuffs em ${effect.healing_relieve_debuff_percent}%`);
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
  characterId, characterName, mode, canUse, battleId, individualTurn, targets = [], stunnedTargetIds = [], getAttributeValue, showActiveEffects = true, allowCustomAttributeEdit = false,
}: {
  characterId: string;
  characterName: string;
  mode: "sheet" | "combat";
  canUse: boolean;
  battleId?: string;
  individualTurn?: number;
  targets?: TargetOption[];
  stunnedTargetIds?: string[];
  getAttributeValue?: (characterId: string, attributeKey: string) => number;
  /** Hide the active runtime effects list when viewing another character in combat. */
  showActiveEffects?: boolean;
  /** Let the owner personalize the script attributes for abilities on their own sheet. */
  allowCustomAttributeEdit?: boolean;
}) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: loadout, isLoading } = useCharacterAbilities(characterId);
  const { data: activeEffects = [] } = useCharacterActiveEffects(characterId, showActiveEffects);
  const { data: defs } = useDefs();
  const { data: damageTypes = [] } = useDamageTypes();
  const { data: races = [] } = useRaces();
  const { data: classes = [] } = useClasses();
  const { data: abilityCatalog = [] } = useAbilities();
  const db = supabase as any;
  const { data: attackContinuousLinks = [] } = useQuery<ContinuousInstance[]>({
    queryKey:["battle-continuous-instances",battleId],
    enabled:mode==="combat" && !!battleId && !!me?.isMaster,
    refetchInterval:5000,
    queryFn:async()=>{
      const {data,error}=await db.from("continuous_effect_instances").select(
        "id,battle_id,character_ability_id,caster_character_id,target_character_id,rule_index,name,rule,ticks,active"
      ).eq("battle_id",battleId!).eq("active",true).order("created_at");
      if(error)throw error;
      return (data??[]).map((value:ContinuousInstance)=>({
        ...value,rule:parseContinuousRules([value.rule])[0]??value.rule,
      }));
    },
  });
  const [releasingContinuous,setReleasingContinuous] = useState<string|null>(null);
  async function releaseContinuousTarget(id:string){
    if(releasingContinuous || !battleId)return;
    setReleasingContinuous(id);
    const {error}=await db.rpc("control_continuous_effect",{_id:id,_mode:"interrupt"});
    setReleasingContinuous(null);
    if(error){toast.error("Não foi possível liberar este alvo: "+error.message);return;}
    toast.success("Vínculo encerrado. A penalidade residual foi preservada.");
    await Promise.all([
      qc.invalidateQueries({queryKey:["battle-continuous-instances",battleId]}),
      qc.invalidateQueries({queryKey:["battle-effects"]}),
      qc.invalidateQueries({queryKey:["character-active-effects"]}),
    ]);
  }
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
    const linkedVirtueId = (ability as (CharacterAbility & { linked_by_virtue_id?: string | null }) | undefined)?.linked_by_virtue_id;
    const abilityTraitId = linkedVirtueId ?? ability?.granted_by_virtue_id;
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
  const { data: demonioHp, isError: demonioHpError } = useQuery<{
    current: number; maximum: number; configuredMax: number;
  }>({
    queryKey: ["demonio-interno-hp", characterId],
    enabled: !!demonioAssignment,
    queryFn: async () => {
      // calculate_character_resource_max is deliberately not executable by
      // browser roles. This narrow, ownership-checked RPC reads the same
      // effective HP maximum as the custom script running on the server.
      const { data, error } = await db.rpc("get_character_hp_for_ability_preview", {
        _character_id: characterId,
      });
      if (error) throw error;
      const values = data as { current?: unknown; maximum?: unknown; configured_max?: unknown } | null;
      const current = Number(values?.current);
      const maximum = Number(values?.maximum);
      const configuredMax = Number(values?.configured_max);
      if (![current, maximum, configuredMax].every(Number.isFinite)) {
        throw new Error("A consulta retornou valores de HP inválidos.");
      }
      return { current, maximum, configuredMax };
    },
    staleTime: 0,
    refetchInterval: mode === "combat" ? 5000 : false,
    refetchOnWindowFocus: "always",
  });
  const demonioBonusDamage = Math.floor(demonioHeat * demonioReflectPercent / 100);
  const demonioHpCost = demonioHp
    ? Math.ceil(demonioHp.maximum * demonioHpCostPercent / 100)
    : null;
  const demonioCannotPay = demonioHp !== undefined && demonioHpCost !== null
    && demonioHpCost > 0 && demonioHp.current <= 0;
  const [targetId, setTargetId] = useState(characterId);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [activationPreparingId, setActivationPreparingId] = useState<string | null>(null);
  const [activationSetup, setActivationSetup] = useState<{
    ability: CharacterAbility;
    targetId: string;
    effects: AbilityEffectDefinition[];
  } | null>(null);
  const [extraManaCosts, setExtraManaCosts] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(true);
  const [attackDialogAbilityId, setAttackDialogAbilityId] = useState<string | null>(null);
  const [attackTargetIds, setAttackTargetIds] = useState<string[]>([]);
  // Mobile shows one attack target at a time; desktop still renders all targets.
  const [attackFocusedTargetId, setAttackFocusedTargetId] = useState<string | null>(null);
  const [attackShowTargetPicker, setAttackShowTargetPicker] = useState(true);
  const [attackHits, setAttackHits] = useState<Record<string, boolean>>({});
  const [attackCriticalHits, setAttackCriticalHits] = useState<Record<string, boolean>>({});
  const [attackEffectHits, setAttackEffectHits] = useState<Record<string, string[]>>({});
  const [attackExtraDamage, setAttackExtraDamage] = useState<Record<string, string>>({});
  const [attackExtraDamagePercent, setAttackExtraDamagePercent] = useState<Record<string, string>>({});
  const [attackTargetDefenseIgnore, setAttackTargetDefenseIgnore] = useState<Record<string, DefenseIgnore>>({});
  const [attackBusy, setAttackBusy] = useState(false);
  const [pendingTargetTransfer, setPendingTargetTransfer] = useState<{
    requirements: TransferRequirement[]; newTargets: string[];
  } | null>(null);
  const [transferSelectedIds, setTransferSelectedIds] = useState<string[]>([]);
  const [attackStarted, setAttackStarted] = useState(false);
  const [attackCount, setAttackCount] = useState(0);
  const [attackResults, setAttackResults] = useState<Record<string, string>>({});
  const [attackExpandedGroups, setAttackExpandedGroups] = useState<Record<string, boolean>>({});
  const [attackGroupEdits, setAttackGroupEdits] = useState<Record<string, {
    effects: AbilityEffectDefinition[];
    dots: AbilityDotEffect[];
  }>>({});
  const [attackGuaranteedDotExpanded, setAttackGuaranteedDotExpanded] = useState<Record<string, boolean>>({});
  const [attackGuaranteedDotEdits, setAttackGuaranteedDotEdits] = useState<Record<string, AbilityDotEffect[]>>({});
  const eligibleAttackTargets = targets.filter((target) => target.id !== characterId);
  const attackAbility = loadout?.find((ability) => ability.id === attackDialogAbilityId);
  const attackContinuousRules = parseContinuousRules((attackAbility as CharacterAbility & {continuous_rules?:unknown}|undefined)?.continuous_rules);
  const heldAttackTargets = attackContinuousLinks.filter(instance=>instance.character_ability_id===attackAbility?.id);
  const attackCatalogEntry = abilityCatalog.find((catalogAbility) => catalogAbility.id === attackAbility?.ability_id);
  // Catalog abilities keep their shared model; exclusive sheet abilities use
  // the attack settings stored directly on character_abilities.
  const attackDefinition = attackAbility?.ability_id
    ? attackCatalogEntry
    : attackAbility;
  function attackManaBaseFor(ability: CharacterAbility): number {
    const catalogAbility = ability.ability_id
      ? abilityCatalog.find((entry) => entry.id === ability.ability_id)
      : null;
    return ability.attack_mana_cost ?? catalogAbility?.attack_mana_cost ?? ability.mana_cost;
  }
  const attackConfig = attackDefinition?.attack_enabled ? parseAbilityAttackDamage(attackDefinition.attack_damage) : null;
  const attackEffectGroups = attackDefinition?.attack_enabled ? parseAbilityAttackEffectGroups(attackDefinition.attack_effect_groups) : [];
  const guaranteedAttackDots = attackDefinition?.attack_enabled ? parseAbilityDotEffects(attackDefinition.dot_effects) : [];
  const currentAttackTargets = eligibleAttackTargets.filter((target) => attackTargetIds.includes(target.id));
  const focusedAttackTargetId = currentAttackTargets.some((target) => target.id === attackFocusedTargetId)
    ? attackFocusedTargetId
    : currentAttackTargets[0]?.id ?? null;
  const focusedAttackTargetIndex = Math.max(0, currentAttackTargets.findIndex((target) => target.id === focusedAttackTargetId));
  const confirmedAttackHits = currentAttackTargets.filter((target) => attackHits[target.id] === true).length;
  const statValue = (id: string, key: string) => Math.max(0, Number(getAttributeValue?.(id, key) ?? 0) || 0);
  const attackBaseDamage = attackConfig
    ? Math.min(1000000, Math.max(0, Math.round(
        (attackConfig.attribute_key ? statValue(characterId, attackConfig.attribute_key) * attackConfig.attribute_percent / 100 : 0)
        + attackConfig.fixed_damage
      )))
    : 0;
  const diceModifier = (mine: number, theirs: number) => Math.max(0, Math.floor((mine - theirs) / 10));
  const diceText = (modifier: number) => `1d20+${modifier}`;

  function snapshotDotAttributeValues(dots: AbilityDotEffect[]): Record<string, number> | null {
    const values: Record<string, number> = {};
    for (const dot of dots) {
      if (dot.damage_mode !== "attribute") continue;
      if (!dot.attribute_key) {
        toast.error(`Selecione um atributo para o DoT "${dot.name}".`);
        return null;
      }
      if (!getAttributeValue) {
        toast.error("Para calcular DoTs baseados em atributo, use a habilidade dentro do combate.");
        return null;
      }
      values[dot.id] = statValue(characterId, dot.attribute_key);
    }
    return values;
  }

  const hasSelectableTargetAbility = loadout?.some((ability) => ability.can_activate && !ability.self_target_only) ?? false;
  const targetOptions = useMemo(() => [
    { id: characterId, name: `${characterName} (si mesmo)` },
    ...targets.filter((target) => target.id !== characterId),
  ], [characterId, characterName, targets]);

  useEffect(() => {
    setTargetId(characterId);
  }, [characterId]);

  function openAttackDialog(ability: CharacterAbility) {
    if (!canUse || mode !== "combat" || !battleId || !ability.can_activate || ability.cooldown_remaining > 0 || ability.active_duration_remaining > 0 || ability.cooldown_turns < 0) return;
    if ((ability as CharacterAbility & { once_per_battle?: boolean }).once_per_battle && usedOnceAbilityIds.includes(ability.id)) {
      toast.error("Esta habilidade já foi usada neste combate.");
      return;
    }
    const preferred = targetId !== characterId && eligibleAttackTargets.some((target) => target.id === targetId)
      ? [targetId]
      : eligibleAttackTargets.slice(0, 1).map((target) => target.id);
    setAttackDialogAbilityId(ability.id);
    setAttackTargetIds(preferred);
    setAttackFocusedTargetId(preferred[0] ?? null);
    setAttackShowTargetPicker(true);
    setAttackHits({});
    setAttackCriticalHits({});
    setAttackEffectHits({});
    setAttackExtraDamage({});
    setAttackExtraDamagePercent({});
    setAttackTargetDefenseIgnore({});
    setAttackResults({});
    setAttackExpandedGroups({});
    setAttackGroupEdits({});
    setAttackGuaranteedDotExpanded({});
    setAttackGuaranteedDotEdits({});
    setAttackStarted(false);
    setAttackCount(0);
  }

  function copyDiceValue(value: string) {
    void navigator.clipboard.writeText(value)
      .then(() => toast.success("Dado copiado"))
      .catch(() => toast.error("Não foi possível copiar o dado"));
  }

  async function resolveAbilityAttack(releaseIds?: string[]) {
    if (!attackAbility || !attackDefinition?.attack_enabled || !attackConfig || !battleId || attackBusy) return;
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
    // Resolve capped ongoing links as part of the same database transaction.
    // Never release a previous victim in a separate request before the attack
    // has succeeded; cooldown, mana and residuals all roll back together.
    if (attackContinuousRules.some(rule => rule.max_targets !== null) && hitTargets.length > 0) {
      const { data: freshLinks, error: freshError } = await db.from("continuous_effect_instances")
        .select("id,battle_id,character_ability_id,caster_character_id,target_character_id,rule_index,rule,name,ticks,active")
        .eq("battle_id", battleId).eq("character_ability_id", attackAbility.id).eq("active", true);
      if (freshError) {
        toast.error("Não foi possível consultar vínculos: " + friendlyAbilityError(freshError));
        return;
      }
      const plan = planContinuousTargetTransfer(attackContinuousRules,
        (freshLinks ?? []) as ContinuousInstance[],hitTargets.map(target => target.id));
      if (plan.error) { toast.error(plan.error); return; }
      if (plan.requirements.length) {
        if (!releaseIds) {
          setTransferSelectedIds([]);
          setPendingTargetTransfer({
            requirements:plan.requirements,newTargets:hitTargets.map(target => target.name),
          });
          return;
        }
        if (!validateTransferSelection(plan.requirements,releaseIds)) {
          toast.error("Selecione exatamente quais vínculos antigos serão liberados antes do ataque.");
          return;
        }
      } else if (releaseIds?.length) {
        toast.error("A seleção de vítimas mudou. Confira os vínculos atuais e tente novamente.");
        setPendingTargetTransfer(null);
        return;
      }
    }
    const hasInvalidExtraDamage = hitTargets.some((target) =>
      !isValidAbilityTargetAdjustment(
        Number(attackExtraDamage[target.id] ?? 0),
        Number(attackExtraDamagePercent[target.id] ?? 0),
      )
    );
    if (hasInvalidExtraDamage) {
      toast.error("Por alvo: ajuste fixo inteiro entre -1.000.000 e +1.000.000; percentual entre -100% e +1000%.");
      return;
    }
    const guaranteedDots = parseAbilityDotEffects(attackDefinition.dot_effects);
    // A target-specific ID avoids collisions when two targets use different
    // caster attribute calculations for the same guaranteed DoT.
    const guaranteedDotsForTarget = (targetId: string) => {
      const edited = attackGuaranteedDotEdits[targetId];
      return edited === undefined
        ? guaranteedDots
        : edited.map((dot) => ({ ...dot, id: `${dot.id}@guaranteed:${targetId}` }));
    };
    const allAttackDots = [
      ...currentAttackTargets.flatMap((target) => guaranteedDotsForTarget(target.id)),
      ...currentAttackTargets.flatMap((target) => attackEffectGroups.flatMap((group) =>
        attackGroupEdits[`${target.id}:${group.id}`]?.dots ?? group.dots)),
    ];
    const dotAttributeValues = snapshotDotAttributeValues(allAttackDots);
    if (!dotAttributeValues) return;
    // Only selected attack categories with temporary edits send overrides.
    const groupOverridesForTarget = (targetId: string) => Object.fromEntries(
      attackEffectGroups.filter((group) =>
        (attackEffectHits[targetId] ?? []).includes(group.id) &&
        attackGroupEdits[`${targetId}:${group.id}`]
      ).map((group) => [group.id, attackGroupEdits[`${targetId}:${group.id}`]])
    );
    const dotTargetSelections = currentAttackTargets.map((target) => ({
      target_id: target.id,
      hit: attackHits[target.id] === true,
      group_ids: attackHits[target.id] === true
        ? (attackEffectHits[target.id] ?? []).filter((groupId) => attackEffectGroups.some((group) => group.id === groupId))
        : [],
      group_overrides: attackHits[target.id] === true ? groupOverridesForTarget(target.id) : {},
      ...(attackGuaranteedDotEdits[target.id] === undefined ? {} : {
        guaranteed_dots_override: guaranteedDotsForTarget(target.id),
      }),
    }));
    const extraMana = Math.max(0, Math.min(1000000, Math.floor(Number(extraManaCosts[attackAbility.id] ?? 0) || 0)));
    const continuousRuleCount = parseContinuousRules((attackAbility as CharacterAbility & { continuous_rules?: unknown }).continuous_rules).length;
    setAttackBusy(true);
    setAttackResults({});
    try {
      // Snapshot existing effects before casting. This lets the popup confirm
      // which DoTs/buffs/debuffs were created by this strike independently
      // of the direct damage result (including damage reduced to zero).
      const existingEffectsResponse = await supabase.from("battle_effects")
        .select("id")
        .eq("battle_id", battleId)
        .eq("source_character_ability_id", attackAbility.id)
        .in("character_id", attackTargetIds);
      const existingEffectIds = existingEffectsResponse.error
        ? null
        : new Set((existingEffectsResponse.data ?? []).map((effect) => effect.id));

      const continuingAttack = attackStarted;
      const { data: spentMana, error: activationError } = await db.rpc(
        releaseIds?.length ? "attack_with_continuous_transfer"
          : continuingAttack ? "repeat_character_ability_attack" : "activate_character_ability_attack", {
        ...(releaseIds?.length ? {
          _release_continuous_ids: releaseIds,
          _repeat: continuingAttack,
        } : {}),
        _character_ability_id: attackAbility.id,
        _target_character_id: hitTargets[0]?.id ?? characterId,
        _battle_id: battleId,
        _extra_mana_cost: continuingAttack ? 0 : extraMana,
        _hit_target_ids: hitTargets.map((target) => target.id),
        _hit_effect_groups: hitTargets.map((target) => ({
          target_id: target.id,
          group_ids: (attackEffectHits[target.id] ?? []).filter((groupId) => attackEffectGroups.some((group) => group.id === groupId)),
          group_overrides: groupOverridesForTarget(target.id),
        })),
        _dot_target_selections: dotTargetSelections,
        _dot_attribute_values: dotAttributeValues,
      });
      if (activationError) throw activationError;
      setPendingTargetTransfer(null);
      setTransferSelectedIds([]);
      // A sequência continua mesmo que um alvo falhe depois desta ativação.
      // As próximas aplicações repetem dano/efeitos, não o custo nem a recarga.
      if (!continuingAttack) {
        setAttackStarted(true);
        if ((attackAbility as CharacterAbility & { once_per_battle?: boolean }).once_per_battle) {
          await qc.invalidateQueries({ queryKey: ["battle-ability-uses", battleId, characterId] });
        }
        setExtraManaCosts((current) => ({ ...current, [attackAbility.id]: "0" }));
        void dispatchCustomAbilityScriptEvents(battleId);
      }

      const results: Record<string, string> = {};
      for (const target of hitTargets) {
        const extraRaw = Number(attackExtraDamage[target.id] ?? 0);
        const extraPercent = Number(attackExtraDamagePercent[target.id] ?? 0);
        const finalBaseDamage = applyAbilityTargetDamage(attackBaseDamage, extraRaw, extraPercent);
        // A pure status / grapple attack must never lose HP from flat attacker
        // bonuses, target vulnerabilities, or negative defenses when its raw
        // damage is zero. Activation already handled hit effects and links.
        if (!shouldApplyAbilityDirectDamage(finalBaseDamage)) {
          results[target.id] = "Dano base 0 → dano final 0; sem dano direto ao HP. " +
            "Os efeitos, DoTs e vínculos do acerto continuam sendo aplicados normalmente.";
          continue;
        }
        const selectedIgnoreGroups = attackEffectGroups.filter((group) =>
          (attackEffectHits[target.id] ?? []).includes(group.id));
        const defenseIgnore = addDefenseIgnore(
          attackConfig.defense_ignore,
          ...selectedIgnoreGroups.map((group) => group.defense_ignore),
          attackTargetDefenseIgnore[target.id] ?? ZERO_DEFENSE_IGNORE,
        );
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
            _critical_damage: attackCriticalHits[target.id] === true,
            _defense_ignore: defenseIgnore,
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
        const damageResult = (runtimeResponse as { damage_result?: {
          total_damage?: number; hp_before?: number; hp_after?: number; final_damage_by_hit?: number[];
          critical_before_defense?: boolean; critical_raw_damage_by_hit?: number[];
        } } | null)?.damage_result;
        if (!damageResult) {
          results[target.id] = "Dano enviado, mas sem resultado retornado.";
          continue;
        }
        results[target.id] = `${attackCriticalHits[target.id] && damageResult.critical_before_defense ? "⚔️ Crítico ×2 antes da defesa · " : ""}Dano base ${finalBaseDamage}${attackCriticalHits[target.id] && damageResult.critical_raw_damage_by_hit?.length ? " → bruto crítico " + damageResult.critical_raw_damage_by_hit.join(", ") : ""} → dano final ${Number(damageResult.total_damage ?? 0)}; HP ${Number(damageResult.hp_before ?? 0)} → ${Number(damageResult.hp_after ?? 0)}.${defenseIgnoreText(defenseIgnore) ? ` Ignorou: ${defenseIgnoreText(defenseIgnore)}.` : ""}`;
      }

      // Report the real status effects and DoTs applied during this use, even
      // if defense/mitigation/invincibility reduced direct damage to 0 HP.
      // Guaranteed DoTs apply to selected targets regardless of the Acertou
      // checkbox; category effects require the master's category selection.
      const appliedEffectsResponse = existingEffectIds === null
        ? null
        : await supabase.from("battle_effects")
            .select("id,character_id,effect_type,name")
            .eq("battle_id", battleId)
            .eq("source_character_ability_id", attackAbility.id)
            .in("character_id", attackTargetIds);
      const newEffects = appliedEffectsResponse?.data?.filter(
        (effect) => !existingEffectIds?.has(effect.id)
      ) ?? [];
      for (const target of currentAttackTargets) {
        const appliedToTarget = newEffects.filter((effect) => effect.character_id === target.id);
        const dots = appliedToTarget.filter((effect) => effect.effect_type === "damage_over_time");
        const otherEffects = appliedToTarget.filter((effect) => effect.effect_type !== "damage_over_time");
        const directlyHit = attackHits[target.id] === true;
        const directText = results[target.id] || (directlyHit
          ? "Ataque marcado como acertado."
          : "Sem dano direto (alvo não marcado como acertado).");
        if (existingEffectIds === null || appliedEffectsResponse?.error) {
          results[target.id] = `${directText} Não foi possível confirmar a lista de efeitos; consulte os efeitos ativos.`;
          continue;
        }
        const effectNames = [
          ...dots.map((effect) => effect.name),
          ...otherEffects.map((effect) => effect.name),
        ];
        const continuousNote = directlyHit && continuousRuleCount > 0
          ? ` Vínculo contínuo iniciado (${continuousRuleCount} regra(s)). A penalidade ou o dano periódico será aplicado quando o turno configurado avançar.`
          : "";
        results[target.id] = `${directText} DoTs aplicados: ${dots.length}. Outros efeitos aplicados: ${otherEffects.length}.${effectNames.length ? ` ${effectNames.join(" · ")}.` : ""}${continuousNote}`;
      }
      setAttackResults(results);
      setAttackCriticalHits({}); // Each new strike must require an explicit critical selection.
      setAttackCount((count) => count + 1);
      // Another Causar o Ataque starts with the saved defaults; changing them
      // again requires opening Maximizar for that target/category.
      setAttackExpandedGroups({});
      setAttackGroupEdits({});
      setAttackGuaranteedDotExpanded({});
      setAttackGuaranteedDotEdits({});
      toast.success(hitTargets.length
        ? `${attackAbility.name}: golpe aplicado em ${hitTargets.length} alvo(s).${!continuingAttack && typeof spentMana === "number" && spentMana > 0 ? ` Mana gasta: ${spentMana}.` : ""}`
        : `${attackAbility.name}: aplicação sem acertos.${!continuingAttack && typeof spentMana === "number" && spentMana > 0 ? ` Mana gasta: ${spentMana}.` : ""}`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["character-abilities", characterId] }),
        qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
        qc.invalidateQueries({ queryKey: ["battle-effects"] }),
        qc.invalidateQueries({ queryKey: ["battle-continuous-instances", battleId] }),
        qc.invalidateQueries({ queryKey: ["character-active-effects"] }),
        qc.invalidateQueries({ queryKey: ["battles"] }),
        qc.invalidateQueries({ queryKey: ["character", characterId] }),
        qc.invalidateQueries({ queryKey: ["battle-character-public-states"] }),
      ]);
    } catch (error) {
      toast.error(friendlyAbilityError(error));
    } finally {
      setAttackBusy(false);
    }
  }

  async function finishAbilityAttack(chargeIfUnused = true) {
    if (attackBusy || !attackDialogAbilityId) return;
    const completedAbilityId = attackDialogAbilityId;
    // The X/Escape can cancel an attack that has not been used yet; only the
    // explicit "Finalizar Ataque" consumes the ability on a complete miss.
    if (!chargeIfUnused && !attackStarted) {
      setAttackDialogAbilityId(null);
      setAttackResults({});
      return;
    }
    if (!battleId || !attackAbility || !attackDefinition?.attack_enabled) {
      toast.error("Não foi possível confirmar a habilidade ou a batalha.");
      return;
    }

    setAttackBusy(true);
    try {
      if (!attackStarted) {
        const extraMana = Math.max(0, Math.min(1000000,
          Math.floor(Number(extraManaCosts[completedAbilityId] ?? 0) || 0)));
        // Empty hit/group/DoT lists mean no target was struck. The regular
        // activation RPC still consumes Mana, starts cooldown, counts a
        // once-per-battle use, and fires the activation script exactly once.
        const { error: activationError } = await db.rpc("activate_character_ability_attack", {
          _character_ability_id: completedAbilityId,
          _target_character_id: characterId,
          _battle_id: battleId,
          _extra_mana_cost: extraMana,
          _hit_target_ids: [],
          _hit_effect_groups: [],
          _dot_target_selections: [],
          _dot_attribute_values: {},
        });
        if (activationError) throw activationError;
        // If closing the server-side session fails, a retry must not charge
        // Mana or reset cooldown again.
        setAttackStarted(true);
        setExtraManaCosts((current) => ({ ...current, [completedAbilityId]: "0" }));
        void dispatchCustomAbilityScriptEvents(battleId);
      }

      const { error } = await db.rpc("finish_character_ability_attack", {
        _character_ability_id: completedAbilityId,
        _battle_id: battleId,
      });
      if (error) throw error;
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["character-abilities", characterId] }),
        qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
        qc.invalidateQueries({ queryKey: ["battle-ability-uses", battleId, characterId] }),
        qc.invalidateQueries({ queryKey: ["battles"] }),
        qc.invalidateQueries({ queryKey: ["battle-effects"] }),
        qc.invalidateQueries({ queryKey: ["character-active-effects"] }),
        qc.invalidateQueries({ queryKey: ["character", characterId] }),
      ]);
      setAttackDialogAbilityId(null);
      setAttackStarted(false);
      setAttackCount(0);
      setAttackResults({});
      setAttackExpandedGroups({});
      setAttackGroupEdits({});
      setAttackGuaranteedDotExpanded({});
      setAttackGuaranteedDotEdits({});
    } catch (error) {
      toast.error("Não foi possível finalizar o ataque: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setAttackBusy(false);
    }
  }

  function dispatchAndRefreshAbilityEffects(scriptBattleId?: string | null) {
    void dispatchCustomAbilityScriptEvents(scriptBattleId).then(() => {
      // An effect such as Sedento's Invencibilidade may be created by the
      // Edge script *after* the activation RPC returned.
      void Promise.all([
        qc.invalidateQueries({ queryKey: ["character-active-effects", characterId] }),
        qc.invalidateQueries({ queryKey: ["battle-effects"] }),
        qc.invalidateQueries({ queryKey: ["character-abilities", characterId] }),
        qc.invalidateQueries({ queryKey: ["battles"] }),
      ]);
    });
  }

  async function requestActivation(ability: CharacterAbility) {
    if (!canUse || mode !== "combat" || busyId || activationPreparingId || activationSetup) return;
    if (ability.cooldown_remaining > 0 || ability.active_duration_remaining > 0 || ability.toggle_active) return;
    if (!me?.isMaster || !battleId) {
      await activate(ability);
      return;
    }
    setActivationPreparingId(ability.id);
    try {
      // Respect temporary per-battle effect choices already configured by the
      // GM, so the popup edits exactly what the next activation will use.
      const { data, error } = await db.from("battle_ability_overrides")
        .select("override_values")
        .eq("battle_id", battleId)
        .eq("character_ability_id", ability.id)
        .maybeSingle();
      if (error) throw error;
      const values = data?.override_values;
      const effectiveEffects = parseAbilityEffects(
        values && typeof values === "object" && !Array.isArray(values) && Array.isArray(values.effects)
          ? values.effects
          : ability.effects
      );
      const chosenTargetId = ability.self_target_only ? characterId : (targetId || characterId);
      if (customizableActivationEffects(effectiveEffects).length > 0) {
        setActivationSetup({ ability, targetId: chosenTargetId, effects: effectiveEffects });
      } else {
        await activate(ability, undefined, chosenTargetId);
      }
    } catch (error) {
      toast.error("Não foi possível preparar os efeitos: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setActivationPreparingId(null);
    }
  }

  async function activate(
    ability: CharacterAbility,
    activationOverrides?: ActivationEffectOverrides,
    fixedTargetId?: string,
  ) {
    if (!canUse || mode !== "combat" || !ability.can_activate || ability.cooldown_turns < 0 || ability.cooldown_remaining > 0 || ability.active_duration_remaining > 0 || busyId || ability.toggle_active) return;
    if ((ability as CharacterAbility & { once_per_battle?: boolean }).once_per_battle && mode === "combat" && usedOnceAbilityIds.includes(ability.id)) {
      toast.error("Esta habilidade já foi usada neste combate.");
      return;
    }
    const catalogEntry = abilityCatalog.find((candidate) => candidate.id === ability.ability_id);
    const guaranteedDots = parseAbilityDotEffects(ability.ability_id ? catalogEntry?.dot_effects : ability.dot_effects);
    const actualTargetId = ability.self_target_only ? characterId : (fixedTargetId ?? targetId ?? characterId);
    if (guaranteedDots.length > 0 && (mode !== "combat" || !battleId)) {
      toast.error("DoTs de habilidades só podem ser aplicados durante um combate ativo.");
      return;
    }
    const dotAttributeValues = snapshotDotAttributeValues(guaranteedDots);
    if (!dotAttributeValues) return;
    setBusyId(ability.id);
    const { data: spentMana, error } = await db.rpc("activate_character_ability", {
      _character_ability_id: ability.id,
      _target_character_id: actualTargetId,
      _battle_id: mode === "combat" ? battleId ?? null : null,
      _extra_mana_cost: mode === "combat" && ability.mana_cost > 0
        ? Math.max(0, Math.min(1000000, Math.floor(Number(extraManaCosts[ability.id] ?? 0) || 0)))
        : 0,
      _dot_target_selections: guaranteedDots.length > 0 ? [{ target_id: actualTargetId, hit: true, group_ids: [] }] : null,
      _dot_attribute_values: activationOverrides
        ? { ...dotAttributeValues, __activation_effect_overrides: activationOverrides }
        : dotAttributeValues,
    });
    setBusyId(null);
    if (error) { toast.error(error.message); return; }
    if ((ability as CharacterAbility & { once_per_battle?: boolean }).once_per_battle && mode === "combat" && battleId) {
      await qc.invalidateQueries({ queryKey: ["battle-ability-uses", battleId, characterId] });
    }
    // O custo extra é enviado apenas nesta ativação; o valor salvo na ficha nunca muda.
    setExtraManaCosts((current) => ({ ...current, [ability.id]: "0" }));
    toast.success(`${ability.name} ativada!${typeof spentMana === "number" && spentMana > 0 ? ` Mana gasta: ${spentMana}.` : ""}`);
    dispatchAndRefreshAbilityEffects(mode === "combat" ? battleId : null);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["character-abilities", characterId] }),
      qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
      qc.invalidateQueries({ queryKey: ["battle-effects"] }),
      qc.invalidateQueries({ queryKey: ["battle-continuous-instances", battleId] }),
      qc.invalidateQueries({ queryKey: ["character-active-effects"] }),
      qc.invalidateQueries({ queryKey: ["battles"] }),
      qc.invalidateQueries({ queryKey: ["character", characterId] }),
      qc.invalidateQueries({ queryKey: ["battle-character-public-states"] }),
    ]);
    return true;
  }

  async function deactivate(ability: CharacterAbility) {
    if (!canUse || mode !== "combat" || !battleId || !ability.toggle_mode || !ability.toggle_active || busyId) return;
    setBusyId(ability.id);
    const { error } = await db.rpc("turn_off_character_ability", { _character_ability_id: ability.id, _battle_id: battleId });
    setBusyId(null);
    if (error) { toast.error(error.message); return; }
    toast.success(`${ability.name} desativada. Seus efeitos foram encerrados.`);
    dispatchAndRefreshAbilityEffects(battleId);
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
                  <span key={effect.id} className={`rounded border px-2 py-1 text-xs ${effect.effect_type === "visual_tag" ? "border-violet-500/40 bg-violet-500/10 text-violet-300" : effect.effect_type === "temporal_freeze" ? "border-sky-500/40 bg-sky-500/10 text-sky-300" : "border-border bg-muted"}`}>
                    {effect.effect_type === "visual_tag" ? "🏷️ " : ""}{effect.name} · {(effect as typeof effect & { source_class_id?: string | null }).source_class_id ? "permanente (classe)" : effect.source_race_id ? "permanente (raça)" : effect.until_combat_end ? "até o fim do combate" : `${effect.duration} turno(s)`}
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
                      {ability.passive_effects.filter((effect) => effect.effect_type === "visual_tag").map((tag,index) => (
                        <span key={`tag-${index}`} className="rounded border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-violet-300">🏷️ {tag.name}</span>
                      ))}
                      <span className={`rounded px-2 py-1 ${ability.is_magical ? "bg-violet-500/10 text-violet-300" : "bg-muted text-muted-foreground"}`}>
                        {ability.is_magical ? "Habilidade Mágica" : "Não mágica"}
                      </span>
                      {ability.can_activate && ability.self_target_only && <span className="rounded bg-muted px-2 py-1">Só em si mesmo</span>}
                      {ability.toggle_mode && <span className={`rounded px-2 py-1 ${ability.toggle_active ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground"}`}>Sustentada: {ability.toggle_active ? "Ligada" : "Desligada"}</span>}
                      {Boolean((ability as CharacterAbility & { once_per_battle?: boolean }).once_per_battle) && (
                        <span className={`rounded px-2 py-1 ${mode === "combat" && usedOnceAbilityIds.includes(ability.id) ? "bg-muted text-muted-foreground" : "bg-amber-500/10 text-amber-400"}`}>
                          {mode === "combat" && usedOnceAbilityIds.includes(ability.id) ? "Já usada neste combate" : "1 uso por combate"}
                        </span>
                      )}
                  {!ability.can_activate ? (
                        <span className="rounded bg-gold/10 px-2 py-1 text-gold"><Sparkles className="mr-1 inline h-3 w-3" /> Não ativável</span>
                      ) : (
                        <span className={`rounded px-2 py-1 ${ability.cooldown_remaining > 0 ? "bg-muted text-muted-foreground" : "bg-emerald-500/10 text-emerald-500"}`}>
                          <Clock3 className="mr-1 inline h-3 w-3" /> {ability.toggle_active ? "Em uso" : ability.active_duration_remaining > 0 ? `Em duração: ${ability.active_duration_remaining} turno(s)` : ability.cooldown_remaining > 0 ? `Cooldown: ${ability.cooldown_remaining} turno(s)` : "Pronta para usar"}
                        </span>
                      )}
                      {ability.active_duration_remaining > 0 && <span className="rounded bg-sky-500/15 px-2 py-1 text-sky-400">Duração: {ability.active_duration_remaining} turno(s) · recarga após terminar</span>}
                      {ability.can_activate && <span className="rounded bg-muted px-2 py-1">Ativar: {ability.mana_cost} Mana</span>}
                      {ability.can_activate && !ability.toggle_mode && (
                        ability.ability_id
                          ? abilityCatalog.some((catalogAbility) => catalogAbility.id === ability.ability_id && catalogAbility.attack_enabled)
                          : ability.attack_enabled
                      ) && <span className="rounded bg-violet-500/10 px-2 py-1 text-violet-300">Atacar: {attackManaBaseFor(ability)} Mana</span>}
                    </div>
                  </div>
                  {mode === "combat" && canUse && ability.can_activate && (
                    <>
                      {ability.toggle_mode && ability.toggle_active ? (
                        <Button size="sm" variant="destructive" disabled={busyId !== null || attackBusy || !battleId} onClick={() => void deactivate(ability)}>
                          <Zap className="mr-1 h-3.5 w-3.5" /> {busyId === ability.id ? "Desativando..." : "Desativar"}
                        </Button>
                      ) : (
                        <Button size="sm" disabled={busyId !== null || activationPreparingId !== null || activationSetup !== null || attackBusy || ability.cooldown_turns < 0 || ability.cooldown_remaining > 0 || ability.active_duration_remaining > 0 || (Boolean((ability as CharacterAbility & { once_per_battle?: boolean }).once_per_battle) && mode === "combat" && usedOnceAbilityIds.includes(ability.id))} onClick={() => void requestActivation(ability)}>
                          <Zap className="mr-1 h-3.5 w-3.5" /> {busyId === ability.id ? "Ativando..." : activationPreparingId === ability.id ? "Preparando..." : ability.toggle_mode ? "Ligar" : "Ativar"}
                        </Button>
                      )}
                      {mode === "combat" && me?.isMaster && ability.cooldown_remaining > 0 && (
                        <div className="flex flex-wrap items-center gap-1">
                          <Button size="sm" variant="outline" onClick={async () => {
                            const raw = prompt("Quantos turnos de cooldown deseja reduzir?", "1");
                            if (raw === null) return;
                            const turns = Number(raw);
                            if (!Number.isInteger(turns) || turns < 0 || turns > 1000) { toast.error("Informe um número inteiro entre 0 e 1000"); return; }
                            const { error } = await db.rpc("master_adjust_ability_cooldown", { _character_ability_id: ability.id, _turns: turns, _mode: "reduce" });
                            if (error) { toast.error(error.message); return; }
                            toast.success("Cooldown ajustado");
                            void dispatchCustomAbilityScriptEvents(battleId);
                            await Promise.all([qc.invalidateQueries({ queryKey: ["character-abilities", characterId] }), qc.invalidateQueries({ queryKey: ["character-abilities-battle"] })]);
                          }}><Minus className="mr-1 h-3.5 w-3.5" /> Reduzir recarga</Button>
                          <Button size="sm" variant="outline" onClick={async () => {
                            const { error } = await db.rpc("master_adjust_ability_cooldown", { _character_ability_id: ability.id, _turns: 0, _mode: "clear" });
                            if (error) { toast.error(error.message); return; }
                            toast.success("Cooldown zerado");
                            void dispatchCustomAbilityScriptEvents(battleId);
                            await Promise.all([qc.invalidateQueries({ queryKey: ["character-abilities", characterId] }), qc.invalidateQueries({ queryKey: ["character-abilities-battle"] })]);
                          }}><Check className="mr-1 h-3.5 w-3.5" /> Tirar do cooldown</Button>
                        </div>
                      )}
                      {mode === "combat" && battleId && !ability.toggle_mode && (
                        ability.ability_id
                          ? abilityCatalog.some((catalogAbility) => catalogAbility.id === ability.ability_id && catalogAbility.attack_enabled)
                          : ability.attack_enabled
                      ) && (
                        <Button size="sm" variant="outline" disabled={busyId !== null || attackBusy || attackDialogAbilityId !== null || ability.cooldown_turns < 0 || ability.cooldown_remaining > 0 || ability.active_duration_remaining > 0 || (Boolean((ability as CharacterAbility & { once_per_battle?: boolean }).once_per_battle) && usedOnceAbilityIds.includes(ability.id))} onClick={() => openAttackDialog(ability)}>
                          <Swords className="mr-1 h-3.5 w-3.5" /> Atacar
                        </Button>
                      )}
                    </>
                  )}
                </div>
                {abilityCatalog.some((catalogAbility) =>
                  catalogAbility.id === ability.ability_id && catalogAbility.custom_script_key === "sedento_por_sangue"
                ) && (showActiveEffects || me?.isMaster || mode === "sheet") && (
                  <SedentoInvincibilityInfo
                    ability={ability}
                    mode={mode}
                    battleId={battleId}
                    individualTurn={individualTurn}
                    activeEffects={activeEffects}
                  />
                )}
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
                {mode === "combat" && ability.can_activate && (
                  ability.mana_cost > 0 ||
                  (!ability.toggle_mode && (ability.ability_id
                    ? abilityCatalog.some((entry) => entry.id === ability.ability_id && entry.attack_enabled)
                    : ability.attack_enabled) && attackManaBaseFor(ability) > 0)
                ) && (
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
                    <span className="text-xs text-muted-foreground">
                      Ativar: {ability.mana_cost + Math.max(0, Math.min(1000000, Math.floor(Number(extraManaCosts[ability.id] ?? 0) || 0)))} Mana
                      {!ability.toggle_mode && (ability.ability_id
                        ? abilityCatalog.some((entry) => entry.id === ability.ability_id && entry.attack_enabled)
                        : ability.attack_enabled) &&
                        <> · Atacar: {attackManaBaseFor(ability) + Math.max(0, Math.min(1000000, Math.floor(Number(extraManaCosts[ability.id] ?? 0) || 0)))} Mana</>}
                      . A Mana extra volta ao normal após o uso.
                    </span>
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
                            ? "Falha na consulta do HP"
                            : demonioHpCost === null
                              ? "Calculando HP máximo…"
                              : demonioHeat > 0 && demonioBonusDamage > 0
                                ? demonioCannotPay
                                  ? "Sem HP para refletir"
                                  : `${demonioHpCost} HP`
                                : "0 HP neste momento"}
                          <span className="ml-1 text-xs font-normal text-muted-foreground">
                            ({demonioHpCostPercent}% do HP máximo{demonioHp ? `: ${demonioHp.maximum} × ${demonioHpCostPercent}%` : ""})
                          </span>
                        </div>
                        {demonioHp && (
                          <div className="text-muted-foreground">
                            HP atual: {demonioHp.current}/{demonioHp.maximum} (máximo efetivo). O custo é arredondado para cima e só é pago quando houver reflexão.
                          </div>
                        )}
                        {demonioHp?.configuredMax === 0 && (
                          <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">
                            A ficha está com HP máximo configurado em 0. O cálculo interno utiliza o mínimo de 1 HP.
                            Configure o HP da ficha para poder pagar o custo de reflexões.
                          </div>
                        )}
                        {demonioCannotPay && demonioHeat > 0 && demonioBonusDamage > 0 && (
                          <div className="text-amber-300">
                            Não é possível refletir dano com 0 HP quando a habilidade exige custo de HP.
                          </div>
                        )}
                        {demonioHpError && (
                          <div className="text-muted-foreground">A consulta do HP falhou; tente atualizar a página. O custo não é estimado a partir de valores incompletos.</div>
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
        if (!open) void finishAbilityAttack(false);
      }}>
        <DialogContent className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[min(92dvh,900px)] sm:max-h-[92dvh] sm:w-[min(96vw,860px)] sm:max-w-3xl sm:rounded-xl">
          <DialogHeader className="shrink-0 border-b border-border px-4 pb-3 pt-5 pr-12 text-left sm:px-6 sm:pt-6 sm:pr-12">
            <DialogTitle className="truncate text-lg text-gold sm:text-xl">Atacar · {attackAbility?.name ?? "Habilidade"}</DialogTitle>
            <DialogDescription className="text-xs leading-relaxed sm:text-sm">
              <span className="sm:hidden">{characterName} ataca. Escolha os alvos, confira os dados e marque quem acertou.</span>
              <span className="hidden sm:inline">{characterName} lança o ataque. Marque cada alvo que acertou e as categorias que acertaram. DoTs fora das categorias são garantidos em todos os alvos selecionados; DoTs dentro das categorias só aplicam quando a categoria foi marcada como acertada.</span>
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6" data-testid="ability-attack-scroll-area">
          {!attackAbility || !attackConfig ? (
            <p className="text-sm text-muted-foreground">Não foi possível carregar a configuração de dano desta habilidade.</p>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2 rounded-lg border border-gold/25 bg-gold/5 px-3 py-2 sm:hidden">
                <div className="min-w-0 text-xs">
                  <span className="block font-semibold text-gold">{currentAttackTargets.length} alvo(s) escolhido(s)</span>
                  <span className="text-muted-foreground">{confirmedAttackHits} acerto(s) marcado(s)</span>
                </div>
                <Button type="button" variant="outline" size="sm" className="min-h-10 shrink-0" disabled={attackBusy}
                  onClick={() => setAttackShowTargetPicker((current) => !current)} aria-expanded={attackShowTargetPicker}>
                  <Crosshair className="mr-1.5 h-4 w-4" /> {attackShowTargetPicker ? "Ocultar seleção" : "Editar alvos"}
                </Button>
              </div>
              <section className={attackShowTargetPicker ? "space-y-2" : "hidden space-y-2 sm:block"}>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-gold"><Crosshair className="h-4 w-4" /> Selecionar alvos</h3>
                {eligibleAttackTargets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Não há outros personagens nesta batalha.</p>
                ) : (
                  <div className="grid max-h-[29dvh] gap-2 overflow-y-auto pr-1 sm:max-h-none sm:grid-cols-2 sm:overflow-visible">
                    {eligibleAttackTargets.map((target) => {
                      const selected = attackTargetIds.includes(target.id);
                      return (
                        <label key={target.id} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors ${selected ? "border-gold bg-gold/10" : "border-border"}`}>
                          <input type="checkbox" className="h-5 w-5 shrink-0 accent-amber-500" checked={selected} disabled={attackBusy}
                            onChange={(event) => {
                              if (event.target.checked) setAttackFocusedTargetId(target.id);
                              setAttackTargetIds((current) => event.target.checked
                                ? [...new Set([...current, target.id])]
                                : current.filter((id) => id !== target.id));
                              if (!event.target.checked) {
                                setAttackHits((current) => { const next = { ...current }; delete next[target.id]; return next; });
                                setAttackCriticalHits((current) => { const next = { ...current }; delete next[target.id]; return next; });
                                setAttackExtraDamage((current) => { const next = { ...current }; delete next[target.id]; return next; });
                                setAttackExtraDamagePercent((current) => { const next = { ...current }; delete next[target.id]; return next; });
                              }
                            }} />
                          <span className="min-w-0 flex-1">{target.name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
                {eligibleAttackTargets.length > 0 && <div className="flex flex-wrap justify-end gap-2 sm:hidden">
                  <Button type="button" size="sm" variant="ghost" disabled={attackBusy || attackTargetIds.length === 0}
                    onClick={() => {
                      setAttackTargetIds([]);
                      setAttackHits({});
                      setAttackCriticalHits({});
                      setAttackEffectHits({});
                    }}>Limpar seleção</Button>
                  <Button type="button" size="sm" className="min-h-10" disabled={attackBusy || currentAttackTargets.length === 0}
                    onClick={() => setAttackShowTargetPicker(false)}>Pronto · configurar acertos</Button>
                </div>}
              </section>
              {currentAttackTargets.length > 0 && (
                <section className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-gold">Dados para lançar e esquivar</h3>
                    <span className="text-xs text-muted-foreground sm:hidden">{focusedAttackTargetIndex + 1} / {currentAttackTargets.length}</span>
                  </div>
                  <div className="sticky top-0 z-10 -mx-4 border-y border-border bg-background/95 px-4 py-2 backdrop-blur sm:hidden" aria-label="Escolher alvo para conferir">
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {currentAttackTargets.map((target, index) => (
                        <button key={target.id} type="button" aria-pressed={focusedAttackTargetId === target.id}
                          onClick={() => { setAttackFocusedTargetId(target.id); setAttackShowTargetPicker(false); }}
                          className={`min-h-10 max-w-44 shrink-0 truncate rounded-lg border px-3 text-xs font-semibold ${focusedAttackTargetId === target.id ? "border-gold bg-gold/15 text-gold" : "border-border text-muted-foreground"}`}>
                          {index + 1}. {target.name}{attackHits[target.id] ? " ✓" : ""}
                        </button>
                      ))}
                    </div>
                  </div>
                  {currentAttackTargets.map((target) => {
                    const attackSpeed = statValue(characterId, "atk_speed");
                    const targetSpeed = statValue(target.id, "speed");
                    const stunned = stunnedTargetIds.includes(target.id);
                    const attackMod = attackDiceModifier(attackSpeed, targetSpeed, stunned);
                    const dodgeMod = diceModifier(targetSpeed, attackSpeed);
                    const extra = Number(attackExtraDamage[target.id] ?? 0) || 0;
                    const percent = Number(attackExtraDamagePercent[target.id] ?? 0) || 0;
                    const damage = applyAbilityTargetDamage(attackBaseDamage, extra, percent);
                    return (
                      <article key={target.id} className={`space-y-3 rounded-lg border border-border p-3 sm:p-4 ${focusedAttackTargetId !== target.id ? "hidden sm:block" : ""}`}>
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold">{target.name}</div>
                            <details className="mt-2 text-xs text-muted-foreground">
                              <summary className="cursor-pointer py-1">Ver cálculo dos dados</summary>
                              <div className="mt-1">Lançamento: ({attackSpeed} Velocidade de Ataque − {targetSpeed} Velocidade) ÷ 10, mínimo 0</div>
                              <div>Esquiva: ({targetSpeed} Velocidade − {attackSpeed} Velocidade de Ataque) ÷ 10, mínimo 0</div>
                            </details>
                            {stunned && <div className="text-xs font-semibold text-amber-400">Alvo com Stun: +1 no dado de ataque.</div>}
                          </div>

                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="min-w-0 rounded-md bg-muted/40 p-2.5 sm:p-3">
                            <div className="text-xs text-muted-foreground">Dado de quem lança</div>
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0 truncate font-display text-lg text-gold sm:text-2xl">{diceText(attackMod)}</div>
                              <Button type="button" size="icon" variant="ghost" className="h-10 w-10 shrink-0" aria-label={`Copiar ${diceText(attackMod)}`} onClick={() => copyDiceValue(diceText(attackMod))} disabled={attackBusy}>
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                          <div className="min-w-0 rounded-md bg-muted/40 p-2.5 sm:p-3">
                            <div className="text-xs text-muted-foreground">Dado de esquiva</div>
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0 truncate font-display text-lg text-gold sm:text-2xl">{diceText(dodgeMod)}</div>
                              <Button type="button" size="icon" variant="ghost" className="h-10 w-10 shrink-0" aria-label={`Copiar ${diceText(dodgeMod)}`} onClick={() => copyDiceValue(diceText(dodgeMod))} disabled={attackBusy}>
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        </div>
                        <label className={`flex min-h-14 cursor-pointer flex-wrap items-center gap-3 rounded-lg border px-3 py-3 text-sm transition-colors ${attackHits[target.id] ? "border-emerald-500/70 bg-emerald-500/10" : "border-border bg-muted/20"}`}>
                          <input type="checkbox" className="h-5 w-5 shrink-0 accent-emerald-500" checked={attackHits[target.id] === true} disabled={attackBusy}
                            onChange={(event) => {
                              setAttackHits((current) => ({ ...current, [target.id]: event.target.checked }));
                              if (!event.target.checked) {
                                setAttackCriticalHits((current) => ({ ...current, [target.id]: false }));
                                setAttackEffectHits((current) => ({ ...current, [target.id]: [] }));
                              }
                            }} />
                          <span className="min-w-0 flex-1 font-semibold">{attackHits[target.id] ? "Acerto confirmado" : "Marcar: Acertou"}</span>
                          <span className="w-full text-xs text-muted-foreground">O acerto vale mesmo com 0 de dano. DoTs garantidos são aplicados mesmo sem acerto.</span>
                        </label>
                        {attackHits[target.id] === true && (
                          <label className={`flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${attackCriticalHits[target.id] ? "border-amber-500 bg-amber-500/10" : "border-amber-500/30 bg-amber-500/5"}`}>
                            <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-amber-500" checked={attackCriticalHits[target.id] === true} disabled={attackBusy}
                              onChange={(event) => setAttackCriticalHits((current) => ({ ...current, [target.id]: event.target.checked }))} />
                            <span className="min-w-0">
                              <strong className="block text-amber-500">Dano Crítico — ×2 do dano bruto</strong>
                              <span className="mt-1 block text-xs text-muted-foreground">Dobra o dano deste alvo antes da defesa e mitigação. Exemplo: 40 × 2 − 78 Defesa = 2. Limite de 500000 por golpe bruto crítico; a próxima aplicação volta ao normal.</span>
                            </span>
                          </label>
                        )}
                        {guaranteedAttackDots.length > 0 && (
                          <TemporaryGuaranteedDotsEditor
                            targetName={target.name}
                            dots={attackGuaranteedDotEdits[target.id] ?? guaranteedAttackDots}
                            expanded={attackGuaranteedDotExpanded[target.id] === true}
                            disabled={attackBusy}
                            defs={defs ?? []}
                            damageTypes={damageTypes}
                            onToggle={() => {
                              setAttackGuaranteedDotExpanded((current) => ({
                                ...current, [target.id]: !current[target.id],
                              }));
                              setAttackGuaranteedDotEdits((current) =>
                                current[target.id] !== undefined ? current : {
                                  ...current,
                                  [target.id]: guaranteedAttackDots.map((dot) => ({ ...dot })),
                                }
                              );
                            }}
                            onChange={(dots) => setAttackGuaranteedDotEdits((current) => ({
                              ...current, [target.id]: dots,
                            }))}
                          />
                        )}
                        {attackHits[target.id] && (
                          <>
                            {attackEffectGroups.length > 0 && (
                              <div className="space-y-2 rounded-md border border-violet-500/30 bg-violet-500/5 p-3">
                                <div>
                                  <div className="text-sm font-semibold text-gold">Efeitos que acertaram</div>
                                  <p className="mt-1 text-xs text-muted-foreground">Marque cada categoria separadamente. Os efeitos de uma categoria não são aplicados se ela não estiver marcada.</p>
                                </div>
                                {attackEffectGroups.map((group) => {
                                  const editKey = `${target.id}:${group.id}`;
                                  const edits = attackGroupEdits[editKey];
                                  const shownEffects = edits?.effects ?? group.effects;
                                  const shownDots = edits?.dots ?? group.dots;
                                  const summary = [
                                    ...shownEffects.map((effect) => effectSummary(effect, defs ?? [], damageTypes, races ?? [])),
                                    ...(defenseIgnoreText(group.defense_ignore) ? [`Ignorar defesa: ${defenseIgnoreText(group.defense_ignore)}`] : []),
                                    ...shownDots.map((dot) => {
                                      const type = dot.damage_kind === "physical"
                                        ? (damageTypes.find((item) => item.id === dot.physical_damage_type_id)?.name ?? "tipo físico")
                                        : (damageTypes.find((item) => item.id === dot.damage_type_id)?.name ?? "tipo mágico") + " · " + (dot.magic_level ?? "baixa");
                                      const amountText = dot.damage_mode === "percent"
                                        ? (dot.damage_amount + "% do HP máximo por turno")
                                        : dot.damage_mode === "attribute"
                                          ? ((dot.attribute_percent + "% de " + (defs?.find((def) => def.key === dot.attribute_key)?.label ?? dot.attribute_key ?? "atributo")) + " + " + dot.fixed_damage + " fixos por turno")
                                          : (dot.damage_amount + " de dano por turno");
                                      return `DoT ${dot.name} — ${dot.damage_kind === "physical" ? "físico" : "mágico"} · ${type} · ${amountText} · ${dot.duration} turno(s)`;
                                    }),
                                  ].join(" · ") || "Sem efeitos configurados";
                                  return (
                                    <TemporaryAttackCategoryEditor
                                      key={editKey}
                                      group={group}
                                      targetName={target.name}
                                      checked={(attackEffectHits[target.id] ?? []).includes(group.id)}
                                      expanded={attackExpandedGroups[editKey] === true}
                                      disabled={attackBusy}
                                      summary={summary}
                                      effects={shownEffects}
                                      dots={shownDots}
                                      defs={defs ?? []}
                                      damageTypes={damageTypes}
                                      onCheckedChange={(checked) => setAttackEffectHits((current) => {
                                        const selected = current[target.id] ?? [];
                                        return { ...current, [target.id]: checked
                                          ? [...new Set([...selected, group.id])]
                                          : selected.filter((id) => id !== group.id) };
                                      })}
                                      onExpandedChange={() => {
                                        setAttackExpandedGroups((current) => ({ ...current, [editKey]: !current[editKey] }));
                                        setAttackGroupEdits((current) => current[editKey] ? current : {
                                          ...current, [editKey]: { effects: group.effects.map((effect) => ({ ...effect })),
                                            dots: group.dots.map((dot) => ({ ...dot })) },
                                        });
                                      }}
                                      onEffectsChange={(effects) => setAttackGroupEdits((current) => ({
                                        ...current, [editKey]: { effects, dots: current[editKey]?.dots ?? group.dots },
                                      }))}
                                      onDotsChange={(dots) => setAttackGroupEdits((current) => ({
                                        ...current, [editKey]: { effects: current[editKey]?.effects ?? group.effects, dots },
                                      }))}
                                    />
                                  );
                                })}
                              </div>
                            )}
                            <details className="rounded-lg border border-border bg-muted/10 p-3">
                              <summary className="cursor-pointer text-sm font-semibold text-gold">
                                Modificadores avançados deste alvo
                                {(extra !== 0 || percent !== 0 || defenseIgnoreText(attackTargetDefenseIgnore[target.id] ?? ZERO_DEFENSE_IGNORE))
                                  ? " · ajustes configurados" : ""}
                              </summary>
                              <div className="mt-3 space-y-3">
                            <div className="grid gap-2 sm:grid-cols-2">
                              <label className="space-y-1 text-xs font-medium">
                                Ajuste fixo deste alvo (+/-)
                                <Input type="number" min={-1000000} max={1000000} step={1} disabled={attackBusy}
                                  value={attackExtraDamage[target.id] ?? "0"}
                                  onChange={(event) => setAttackExtraDamage((current) => ({ ...current, [target.id]: event.target.value }))} />
                              </label>
                              <label className="space-y-1 text-xs font-medium">
                                Ajuste percentual deste alvo (+/- %)
                                <Input type="number" min={-100} max={1000} step={1} disabled={attackBusy}
                                  value={attackExtraDamagePercent[target.id] ?? "0"}
                                  onChange={(event) => setAttackExtraDamagePercent((current) => ({ ...current, [target.id]: event.target.value }))} />
                              </label>
                            </div>
                            <div className="rounded-md border border-gold/25 p-3">
                              <DefenseIgnoreInputs
                                title="Ignorar defesa apenas deste alvo"
                                value={attackTargetDefenseIgnore[target.id] ?? ZERO_DEFENSE_IGNORE}
                                onChange={(value) => setAttackTargetDefenseIgnore((current) => ({
                                  ...current, [target.id]: value,
                                }))}
                                disabled={attackBusy}
                              />
                              <p className="mt-2 text-xs text-muted-foreground">
                                {(() => {
                                  const selected = attackEffectGroups.filter((g) => (attackEffectHits[target.id] ?? []).includes(g.id));
                                  const combined = addDefenseIgnore(
                                    attackConfig.defense_ignore,
                                    ...selected.map((g) => g.defense_ignore),
                                    attackTargetDefenseIgnore[target.id] ?? ZERO_DEFENSE_IGNORE,
                                  );
                                  return `Total de defesa ignorada neste golpe: ${defenseIgnoreText(combined) || "nenhuma"}.`;
                                })()}
                              </p>
                            </div>
                              </div>
                            </details>
                            <div className="rounded-md border border-gold/30 bg-gold/5 p-3">
                              <div className="text-xs text-muted-foreground">Dano calculado para este alvo</div>
                              <div className="text-lg font-bold text-gold">{damage}</div>
                              <div className="text-[11px] text-muted-foreground">
                                {attackConfig.attribute_key
                                  ? `${attackConfig.attribute_percent}% de ${defs?.find((def) => def.key === attackConfig.attribute_key)?.label ?? attackConfig.attribute_key} (${statValue(characterId, attackConfig.attribute_key)})`
                                  : "Sem atributo de origem"} + {attackConfig.fixed_damage} fixos; ajuste {extra >= 0 ? "+" : ""}{extra} fixo, {percent >= 0 ? "+" : ""}{percent}%; antes de defesa/mitigação
                              </div>
                            </div>
                          </>
                        )}
                        {attackResults[target.id] && <p className={`rounded-md border px-3 py-2 text-xs ${attackResults[target.id].startsWith("Erro") ? "border-destructive/50 text-destructive" : "border-emerald-500/40 text-emerald-500"}`}>{attackResults[target.id]}</p>}
                      </article>
                    );
                  })}
                  {currentAttackTargets.length > 1 && <div className="grid grid-cols-2 gap-2 sm:hidden">
                    <Button type="button" variant="outline" className="min-h-11" disabled={attackBusy || focusedAttackTargetIndex === 0}
                      onClick={() => setAttackFocusedTargetId(currentAttackTargets[focusedAttackTargetIndex - 1]?.id ?? null)}>
                      <ChevronLeft className="mr-1 h-4 w-4" /> Anterior
                    </Button>
                    <Button type="button" variant="outline" className="min-h-11" disabled={attackBusy || focusedAttackTargetIndex >= currentAttackTargets.length - 1}
                      onClick={() => setAttackFocusedTargetId(currentAttackTargets[focusedAttackTargetIndex + 1]?.id ?? null)}>
                      Próximo <ChevronRight className="ml-1 h-4 w-4" />
                    </Button>
                  </div>}
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
              {attackContinuousRules.some(rule=>rule.max_targets!==null) &&
                <section className="space-y-2 rounded-xl border border-gold/35 bg-gold/5 p-3">
                  <p className="text-sm font-semibold text-gold">Vínculos sustentados e limite de alvos</p>
                  <p className="text-xs text-muted-foreground">
                    Ao acertar uma nova vítima com o limite cheio, o Grimório pergunta quem soltar antes de confirmar o ataque.
                    A transferência ocorre junto com o golpe; se ele falhar, ninguém é solto. Também é possível liberar um alvo manualmente abaixo.
                  </p>
                  {attackContinuousRules.map((rule,index)=>rule.max_targets===null?null:(
                    <div key={index} className="space-y-2 rounded-lg border border-gold/15 p-2.5">
                      <div className="flex flex-wrap justify-between gap-2 text-xs">
                        <span className="font-semibold">{rule.name}</span>
                        <span className="font-semibold text-gold">
                          {heldAttackTargets.filter(item=>item.rule_index===index).length}/{rule.max_targets} alvos
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {rule.on_limit==="choose"?"Escolher quem liberar":rule.on_limit==="block"?"Bloquear novos alvos ao atingir o limite":"Substituir automaticamente o mais antigo"}
                      </p>
                      {heldAttackTargets.filter(item=>item.rule_index===index).map(instance=>(
                        <div key={instance.id} className="flex items-center justify-between gap-2 rounded-lg bg-background/60 px-2.5 py-2">
                          <span className="min-w-0 truncate text-xs">
                            {targets.find(target=>target.id===instance.target_character_id)?.name??"Alvo anterior"} · {instance.ticks} acúmulo(s)
                          </span>
                          <Button type="button" size="sm" variant="outline"
                            className="min-h-10 shrink-0 border-amber-600/40 text-amber-300"
                            disabled={!!releasingContinuous || attackBusy}
                            onClick={()=>void releaseContinuousTarget(instance.id)}>
                            {releasingContinuous===instance.id?"Liberando...":"Soltar alvo"}
                          </Button>
                        </div>
                      ))}
                    </div>
                  ))}
                </section>}
              {!attackStarted && (
                <p className="text-xs text-muted-foreground">
                  Custo base de Atacar: {attackAbility ? attackManaBaseFor(attackAbility) : 0} Mana
                  {attackAbility && Number(extraManaCosts[attackAbility.id] ?? 0) > 0
                    ? ` + ${extraManaCosts[attackAbility.id]} extra`
                    : ""}.
                  Finalizar Ataque consome Mana e inicia a recarga mesmo sem nenhum acerto. Fechar pelo X antes de usar cancela sem custo.
                </p>
              )}
              {attackStarted && (
                <p className="text-sm text-emerald-500">
                  {attackCount} aplicação(ões) nesta sequência. Causar o Ataque pode ser usado novamente, com outros alvos, acertos ou modificadores. A Mana e a recarga foram aplicadas apenas na primeira vez.
                </p>
              )}
            </div>
          )}
          </div>
          <DialogFooter className="z-10 shrink-0 flex flex-col gap-2 border-t border-border bg-background/95 px-4 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-6px_20px_rgba(0,0,0,.10)] sm:flex-row sm:items-center sm:px-6 sm:pb-4">
            <div className="text-xs text-muted-foreground sm:mr-auto">
              {currentAttackTargets.length} alvo(s) · {confirmedAttackHits} acerto(s)
              {attackStarted ? ` · ${attackCount} aplicação(ões)` : " · Mana cobrada na primeira aplicação"}
            </div>
            <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" onClick={() => void finishAbilityAttack()} disabled={attackBusy}>
              Finalizar Ataque
            </Button>
            <Button type="button" className="min-h-11 w-full sm:w-auto" onClick={() => void resolveAbilityAttack()} disabled={attackBusy || !attackAbility || !attackConfig || attackTargetIds.length === 0 || !battleId}>
              <Swords className="mr-1 h-4 w-4" />
              {attackBusy ? "Aplicando..." : "Causar o Ataque"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={pendingTargetTransfer !== null}
        onOpenChange={(open) => { if (!open && !attackBusy) setPendingTargetTransfer(null); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto border-gold/40 bg-background sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display text-gold">Transferir vínculo contínuo</DialogTitle>
            <DialogDescription>
              A habilidade atingiu o limite de alvos. Escolha quem soltar; o ataque no novo alvo e
              a liberação acontecerão juntos, sem perder os acúmulos residuais.
            </DialogDescription>
          </DialogHeader>
          {pendingTargetTransfer && <div className="space-y-3">
            <p className="rounded-lg border border-gold/25 bg-gold/5 p-3 text-xs">
              Novo(s) alvo(s): <strong>{pendingTargetTransfer.newTargets.join(", ")}</strong>
            </p>
            {pendingTargetTransfer.requirements.map(group => (
              <div key={group.ruleIndex} className="space-y-2 rounded-xl border border-gold/30 bg-[#150f0d] p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-gold">{group.name}</p>
                  <span className="text-xs text-muted-foreground">
                    Liberar {group.needed} · {group.available.filter(item => transferSelectedIds.includes(item.id)).length} selecionado(s)
                  </span>
                </div>
                {group.available.map(item => {
                  const checked = transferSelectedIds.includes(item.id);
                  const selectedForGroup = group.available.filter(link=>transferSelectedIds.includes(link.id)).length;
                  return <label key={item.id}
                    className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${checked?"border-amber-500/60 bg-amber-500/10":"border-border bg-background/60"}`}>
                    <input type="checkbox" className="h-5 w-5 accent-amber-500" checked={checked}
                      disabled={attackBusy || (!checked && selectedForGroup >= group.needed)}
                      onChange={e=>setTransferSelectedIds(current=>e.target.checked
                        ? [...current,item.id] : current.filter(id=>id!==item.id))}/>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate">
                        {targets.find(target=>target.id===item.target_character_id)?.name ?? "Alvo anterior"}
                      </strong>
                      <span className="block text-xs text-muted-foreground">
                        {item.ticks} acúmulo(s) · após soltar, penalidade por {item.rule.linger_turns} turno(s)
                      </span>
                    </span>
                  </label>;
                })}
              </div>
            ))}
          </div>}
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto"
              disabled={attackBusy} onClick={()=>setPendingTargetTransfer(null)}>
              Cancelar
            </Button>
            <Button type="button" className="min-h-11 w-full sm:w-auto"
              disabled={attackBusy || !pendingTargetTransfer ||
                !validateTransferSelection(pendingTargetTransfer.requirements,transferSelectedIds)}
              onClick={()=>void resolveAbilityAttack(transferSelectedIds)}>
              {attackBusy?"Transferindo...":"Soltar e aplicar ataque"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {activationSetup && (
        <ActivationEffectValuesDialog
          key={`${activationSetup.ability.id}:${activationSetup.targetId}`}
          abilityName={activationSetup.ability.name}
          targetName={targetOptions.find((target) => target.id === activationSetup.targetId)?.name ?? characterName}
          effects={activationSetup.effects}
          onCancel={() => setActivationSetup(null)}
          onConfirm={async (values) => {
            const result = await activate(activationSetup.ability, values, activationSetup.targetId);
            return result === true;
          }}
        />
      )}
    </section>
  );
}

export function CharacterAbilitiesManager({ characterId, personalOnly = false }: { characterId: string; personalOnly?: boolean }) {
  const qc = useQueryClient();
  const { data: allAbilities = [], isLoading: catalogLoading } = useAbilities();
  const { data: assigned = [], isLoading: assignedLoading } = useCharacterAbilities(characterId);
  const { data: races = [] } = useRaces();
  const { data: classes = [] } = useClasses();
  const { data: virtues = [] } = useVirtues();
  const { data: selectedTraitIds = { race_id: null, virtue_id: null, class_id: null } } = useQuery<{ race_id: string | null; virtue_id: string | null; class_id: string | null }>({
    queryKey: ["character-ability-linkable-traits", characterId],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("characters").select("race_id,virtue_id,class_id").eq("id", characterId).single();
      if (error) throw error;
      return data;
    },
  });
  const { data: defs } = useDefs();
  const [expanded, setExpanded] = useState(true);
  const [customName, setCustomName] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [creatingCustom, setCreatingCustom] = useState(false);
  const [customTraitLink, setCustomTraitLink] = useState<"none" | "race" | "virtue" | "class">("none");
  const db = supabase as any;
  useEffect(() => {
    const channel = supabase
      .channel(`character-ability-trait-links-${characterId}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "characters",
        filter: `id=eq.${characterId}`,
      }, () => {
        void qc.invalidateQueries({ queryKey: ["character-ability-linkable-traits", characterId] });
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [characterId, qc]);
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
      toggle_mode: ability.toggle_mode,
      cooldown_turns: ability.can_activate ? ability.cooldown_turns : 0,
      cooldown_remaining: 0,
      mana_cost: ability.can_activate ? ability.mana_cost : 0,
      effects: ability.effects,
      passive_effects: ability.passive_effects,
      end_effects: ability.end_effects,
      continuous_rules: (ability as Ability & { continuous_rules?: unknown }).continuous_rules ?? [],
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
      linked_by_race_id: customTraitLink === "race" ? selectedTraitIds.race_id : null,
      linked_by_virtue_id: customTraitLink === "virtue" ? selectedTraitIds.virtue_id : null,
      linked_by_class_id: customTraitLink === "class" ? selectedTraitIds.class_id : null,
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
    setCustomTraitLink("none");
    toast.success(customTraitLink === "none" ? "Habilidade exclusiva criada nesta ficha" : "Habilidade exclusiva vinculada à característica da ficha");
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
            <label className="block space-y-1 text-xs font-medium sm:col-span-2">
              Vincular habilidade a uma característica
              <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={customTraitLink} onChange={(event) => setCustomTraitLink(event.target.value as typeof customTraitLink)}>
                <option value="none">Sem vínculo — não remover automaticamente</option>
                {selectedTraitIds.race_id && <option value="race">Raça: {races.find((row) => row.id === selectedTraitIds.race_id)?.name ?? "selecionada"}</option>}
                {selectedTraitIds.virtue_id && <option value="virtue">Virtude: {virtues.find((row) => row.id === selectedTraitIds.virtue_id)?.name ?? "selecionada"}</option>}
                {selectedTraitIds.class_id && <option value="class">Classe: {classes.find((row) => row.id === selectedTraitIds.class_id)?.name ?? "selecionada"}</option>}
              </select>
              <span className="block text-[11px] text-muted-foreground">Ao trocar ou remover a característica escolhida, esta habilidade exclusiva será removida da ficha.</span>
            </label>
            </div>
            <Button size="sm" onClick={() => void createCustomAbility()} disabled={creatingCustom}>
              <Plus className="mr-1 h-3.5 w-3.5" /> {creatingCustom ? "Criando..." : "Criar habilidade exclusiva"}
            </Button>
            <p className="text-xs text-muted-foreground">Ela existe apenas nesta ficha e pode ser configurada abaixo, sem entrar no catálogo geral.</p>
          </div>
          {catalogLoading || assignedLoading ? <p className="text-sm text-muted-foreground">Carregando habilidades…</p> : !personalOnly && available.length > 0 ? (
            <div className="space-y-2">
              <Label>Adicionar do catálogo</Label>
              <SearchableGrantPicker
                options={available.map((ability) => ({
                  id: ability.id,
                  name: ability.name,
                  description: ability.description,
                }))}
                selectedIds={new Set<string>()}
                showSelected={false}
                addLabel="Habilidades disponíveis para esta ficha"
                searchPlaceholder="Pesquisar habilidade do catálogo…"
                onToggle={(id, checked) => {
                  if (!checked) return;
                  const ability = available.find((item) => item.id === id);
                  if (ability) void give(ability);
                }}
              />
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
  const { data: availableCatalogAbilities = [] } = useAbilities();
  const [name, setName] = useState(ability.name);
  const [description, setDescription] = useState(ability.description ?? "");
  const [personalScript,setPersonalScript] = useState((ability as CharacterAbility & { custom_script_key?:string|null }).custom_script_key ?? "");
  const [canActivate, setCanActivate] = useState(ability.can_activate);
  const [toggleMode, setToggleMode] = useState(ability.toggle_mode);
  const [oncePerBattle, setOncePerBattle] = useState(Boolean((ability as CharacterAbility & { once_per_battle?: boolean }).once_per_battle));
  const [isMagical, setIsMagical] = useState(ability.is_magical);
  const [selfTargetOnly, setSelfTargetOnly] = useState(ability.self_target_only);
  const [cooldown, setCooldown] = useState(String(ability.cooldown_turns));
  const [duration, setDuration] = useState(String(ability.duration_turns ?? 0));
  const [manaCost, setManaCost] = useState(String(ability.mana_cost));
  const [attackManaCost, setAttackManaCost] = useState(ability.attack_mana_cost === null ? "" : String(ability.attack_mana_cost));
  const [effects, setEffects] = useState<AbilityEffectDefinition[]>(ability.effects);
  const [continuousRules, setContinuousRules] = useState<ContinuousRule[]>(() =>
    parseContinuousRules((ability as CharacterAbility & { continuous_rules?: unknown }).continuous_rules));
  const [passiveEffects, setPassiveEffects] = useState<AbilityEffectDefinition[]>(ability.passive_effects);
  const [endEffects, setEndEffects] = useState<AbilityEffectDefinition[]>(ability.end_effects);
  const [attackEnabled, setAttackEnabled] = useState(Boolean(ability.attack_enabled));
  const [attackDamage, setAttackDamage] = useState<AbilityAttackDamageConfig>(() => parseAbilityAttackDamage(ability.attack_damage));
  const [attackEffectGroups, setAttackEffectGroups] = useState<AbilityAttackEffectGroup[]>(() => parseAbilityAttackEffectGroups(ability.attack_effect_groups));
  const [dotEffects, setDotEffects] = useState<AbilityDotEffect[]>(() => parseAbilityDotEffects(ability.dot_effects));
  const { data: damageTypes = [] } = useDamageTypes();
  const { data: dotTemplates = [] } = useDotTemplates();
  const [busy, setBusy] = useState(false);
  // Open each ability's settings only when the user clicks Maximizar.
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setName(ability.name);
    setDescription(ability.description ?? "");
    setPersonalScript((ability as CharacterAbility & { custom_script_key?:string|null }).custom_script_key ?? "");
    setCanActivate(ability.can_activate);
    setToggleMode(ability.toggle_mode);
    setOncePerBattle(Boolean((ability as CharacterAbility & { once_per_battle?: boolean }).once_per_battle));
    setIsMagical(ability.is_magical);
    setSelfTargetOnly(ability.self_target_only);
    setCooldown(String(ability.cooldown_turns));
    setDuration(String(ability.duration_turns ?? 0));
    setManaCost(String(ability.mana_cost));
    setAttackManaCost(ability.attack_mana_cost === null ? "" : String(ability.attack_mana_cost));
    setEffects(parseAbilityEffects(ability.effects));
    setContinuousRules(parseContinuousRules((ability as CharacterAbility & { continuous_rules?: unknown }).continuous_rules));
    setPassiveEffects(parseAbilityEffects(ability.passive_effects));
    setEndEffects(parseAbilityEffects(ability.end_effects));
    setAttackEnabled(Boolean(ability.attack_enabled));
    setAttackDamage(parseAbilityAttackDamage(ability.attack_damage));
    setAttackEffectGroups(parseAbilityAttackEffectGroups(ability.attack_effect_groups));
    setDotEffects(parseAbilityDotEffects(ability.dot_effects));
  }, [ability]);

  async function save() {
    const cooldownTurns = canActivate ? Math.floor(Number(cooldown)) : 0;
    const durationTurns = canActivate && !toggleMode ? Math.floor(Number(duration)) : 0;
    const cost = Math.floor(Number(manaCost));
    const attackCost = attackManaCost.trim() === "" ? null : Number(attackManaCost);
    if (!name.trim()) { toast.error("Informe o nome"); return; }
    if (ability.toggle_active) { toast.error("Desative esta habilidade antes de alterar sua configuração."); return; }
    if (toggleMode && !canActivate) { toast.error("Habilidade sustentada precisa ser ativável."); return; }
    const catalogDefinition = availableCatalogAbilities.find((row) => row.id === ability.ability_id);
    if (toggleMode && (
      (catalogDefinition && (catalogDefinition.attack_enabled || parseAbilityDotEffects(catalogDefinition.dot_effects).length > 0))
      || (!ability.ability_id && (attackEnabled || dotEffects.length > 0))
    )) {
      toast.error("Este modelo possui ataque ou DoTs de ativação. Remova-os do modelo antes de usar o modo sustentado.");
      return;
    }
    if (!ability.ability_id && attackEnabled && canActivate && !selfTargetOnly && !toggleMode) {
      const wantsPhysical = attackDamage.damage_kind === "physical" || attackDamage.damage_kind === "hybrid";
      const wantsMagical = attackDamage.damage_kind === "magical" || attackDamage.damage_kind === "hybrid";
      if (wantsPhysical && !damageTypes.some((type) => type.category === "physical" && type.id === attackDamage.physical_damage_type_id)) {
        toast.error("Selecione um tipo de dano físico válido para o ataque.");
        return;
      }
      if (wantsMagical && !damageTypes.some((type) => type.category === "magical" && type.id === attackDamage.damage_type_id)) {
        toast.error("Selecione um tipo de dano mágico válido para o ataque.");
        return;
      }
    }
    if (!Number.isInteger(durationTurns) || durationTurns < 0 || durationTurns > 1000) { toast.error("Duração deve ser um inteiro de 0 a 1000 turnos."); return; }
    if (ability.active_duration_remaining > 0) { toast.error("Aguarde o fim da duração antes de alterar a habilidade."); return; }
    if (!Number.isFinite(cost) || cost < 0) { toast.error("Custo de Mana inválido"); return; }
    if (attackCost !== null && (!Number.isInteger(attackCost) || attackCost < 0 || attackCost > 1000000)) {
      toast.error("Custo de Mana de Atacar deve ser um número inteiro de 0 a 1.000.000.");
      return;
    }
    if (canActivate && (!Number.isFinite(cooldownTurns) || cooldownTurns < 0)) { toast.error("O cooldown precisa ser 0 ou maior"); return; }
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
      !(effect.healing_reduce_debuff_turns_percent && effect.healing_reduce_debuff_turns_percent > 0) &&
      !(effect.healing_relieve_debuff_percent && effect.healing_relieve_debuff_percent > 0)
    );
    if (hasInvalidHealing) {
      toast.error("Configure pelo menos uma ação em cada efeito de cura.");
      return;
    }
    if (!ability.ability_id && [...dotEffects, ...attackEffectGroups.flatMap((group) => group.dots)]
      .some((dot) => !findRegisteredDotTemplate(dot, dotTemplates))) {
      toast.error("Selecione um DoT já cadastrado na página DoTs para cada entrada.");
      return;
    }
    setBusy(true);
    const db = supabase as any;
    const { error } = await db.from("character_abilities").update({
      name: name.trim(),
      once_per_battle: canActivate && oncePerBattle,
      description: description.trim() || null,
      can_activate: canActivate,
      toggle_mode: canActivate && toggleMode,
      is_magical: isMagical,
      self_target_only: canActivate && selfTargetOnly,
      is_passive: !canActivate,
      cooldown_turns: cooldownTurns,
      duration_turns: durationTurns,
      cooldown_remaining: canActivate ? Math.min(ability.cooldown_remaining, cooldownTurns) : 0,
      mana_cost: canActivate ? cost : 0,
      effects: effects.map((effect) => ({ ...effect, duration: Math.max(1, effect.duration) })) as unknown as Json,
      passive_effects: passiveEffects.map((effect) => ({ ...effect, duration: 1 })) as unknown as Json,
      end_effects: endEffects.map((effect) => ({ ...effect, duration: Math.max(1, effect.duration) })) as unknown as Json,
      continuous_rules: continuousRules as unknown as Json,
      ...(!ability.ability_id ? {
        custom_script_key: personalScript || null,
        attack_enabled: canActivate && !selfTargetOnly && !toggleMode && attackEnabled,
        attack_mana_cost: attackCost,
        attack_damage: attackDamage,
        attack_effect_groups: attackEffectGroups
          .filter((group) => group.name.trim() && (
            group.effects.length > 0 || group.dots.length > 0 || !!defenseIgnoreText(group.defense_ignore)
          )).map((group) => ({
            ...group,
            name: group.name.trim(),
            effects: group.effects.map((effect) => ({ ...effect, duration: Math.max(1, effect.duration) })),
            dots: registerAbilityDotTemplates(group.dots, dotTemplates),
          })),
        dot_effects: registerAbilityDotTemplates(dotEffects, dotTemplates),
      } : {}),
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
          <div className="text-xs text-muted-foreground">{ability.is_magical ? "Habilidade Mágica · " : "Não mágica · "}{ability.active_duration_remaining > 0 ? `Em duração: ${ability.active_duration_remaining} turno(s) · ` : ""}{ability.granted_by_virtue_id ? "Concedida por virtude · " : ""}{ability.can_activate ? `Cooldown atual: ${ability.cooldown_remaining}/${ability.cooldown_turns}` : "Não ativável · efeitos passivos permanentes"}</div>
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
            setCooldown(notActivatable ? "0" : (Number(cooldown) >= 0 ? cooldown : "0"));
            if (notActivatable) setManaCost("0");
          }} />
          Habilidade não ativável nesta ficha
        </label>
        <label className="flex min-h-10 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={isMagical} onChange={(e) => setIsMagical(e.target.checked)} />
          Habilidade Mágica
        </label>
        {canActivate && (
          <label className="flex min-h-10 items-center gap-2 rounded-md border border-gold/40 px-3 py-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={toggleMode} onChange={(e) => setToggleMode(e.target.checked)} disabled={ability.toggle_active} />
            <span>Habilidade sustentada (ligar/desligar)<span className="block text-xs text-muted-foreground">Os efeitos ao ativar continuam funcionando até o mestre desativar. A recarga começa ao desligar.</span></span>
          </label>
        )}
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
        {canActivate && <div className="space-y-1"><Label>Custo de Mana para Ativar</Label><Input type="number" min="0" value={manaCost} onChange={(e) => setManaCost(e.target.value)} /></div>}
        {canActivate && !ability.ability_id && !toggleMode && !selfTargetOnly && attackEnabled && (
          <div className="space-y-1">
            <Label>Custo de Mana para Atacar (opcional)</Label>
            <Input type="number" min="0" max="1000000" step="1"
              placeholder="Mesmo custo de Ativar" value={attackManaCost}
              onChange={(event) => setAttackManaCost(event.target.value)} />
            <p className="text-[11px] text-muted-foreground">
              Deixe em branco para usar o custo de Ativar. Defina 0 para Atacar sem gastar Mana.
              A Mana é cobrada uma vez na sequência de ataque, mesmo que não acerte.
            </p>
          </div>
        )}
        {!canActivate && <p className="text-xs text-muted-foreground">Não ativável: não gasta Mana nem possui cooldown; seus efeitos passivos continuam funcionando.</p>}
        {canActivate && <div className="space-y-1"><Label>Cooldown máximo (turnos)</Label><Input type="number" min="0" value={cooldown} onChange={(e) => setCooldown(e.target.value)} /></div>}
        {canActivate && !toggleMode && <div className="space-y-1"><Label>Duração da habilidade (turnos)</Label><Input type="number" min="0" max="1000" value={duration} onChange={(e) => setDuration(e.target.value)} />
          <p className="text-[11px] text-muted-foreground">0 = sem duração. Se maior que 0, a recarga só começa quando a duração terminar.</p>
        </div>}
        <div className="space-y-1 sm:col-span-2"><Label>Descrição para este jogador</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      </div>
      {ability.ability_id === null && (
        <section className="space-y-2 rounded-xl border border-gold/30 bg-gold/5 p-3">
          <h3 className="text-sm font-semibold text-gold">Script personalizado da ficha</h3>
          <p className="text-xs text-muted-foreground">
            Selecione apenas scripts já registrados no servidor. O script é executado nos eventos da habilidade
            e não altera o catálogo geral. A escolha é exclusiva deste personagem.
          </p>
          <select className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
            value={personalScript} disabled={busy} aria-label="Script registrado para esta habilidade exclusiva"
            onChange={e=>setPersonalScript(e.target.value)}>
            <option value="">Sem script personalizado</option>
            {CUSTOM_ABILITY_SCRIPTS.map(script=><option key={script.key} value={script.key}>{script.label}</option>)}
          </select>
        </section>
      )}
      {ability.ability_id === null && (
        <SheetAbilityAttackEditor
          defs={defs}
          canActivate={canActivate}
          toggleMode={toggleMode}
          selfTargetOnly={selfTargetOnly}
          attackEnabled={attackEnabled}
          setAttackEnabled={setAttackEnabled}
          attackDamage={attackDamage}
          setAttackDamage={setAttackDamage}
          attackEffectGroups={attackEffectGroups}
          setAttackEffectGroups={setAttackEffectGroups}
          dotEffects={dotEffects}
          setDotEffects={setDotEffects}
        />
      )}
      {canActivate && <ContinuousRulesEditor rules={continuousRules} onChange={setContinuousRules} defs={defs} disabled={busy}/>}
      {canActivate && <AbilityEffectsEditor
        allowActivationCustomization
        effects={effects}
        onChange={setEffects}
        permanent={false}
        title="Efeitos ao ativar"
        description={toggleMode ? "Permanecem aplicados enquanto a habilidade estiver ligada no combate. São removidos quando o mestre a desliga." : "Aplicados ao alvo escolhido quando esta habilidade for ativada."}
        defs={defs}
      />}
      {canActivate && <AbilityEffectsEditor
        effects={endEffects}
        onChange={setEndEffects}
        permanent={false}
        title="Efeitos quando a habilidade acaba"
        description={toggleMode ? "São aplicados quando a habilidade sustentada é desligada e os efeitos ativos terminam." : "Aplicados ao destino escolhido quando todos os efeitos desta ativação terminarem."}
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
          <AbilityEffectsEditor allowActivationCustomization effects={effects} onChange={setEffects} permanent={false} title="Efeitos alterados nesta batalha" description="Os atributos afetados por esses efeitos também são temporários." defs={defs} />
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
