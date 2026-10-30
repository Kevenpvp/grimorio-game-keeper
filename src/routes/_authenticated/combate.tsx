import type { Json } from "@/integrations/supabase/types";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Crosshair, Dices, Plus, Swords, Trash2, Copy, Footprints, RotateCw, Minus, Brain, Activity, Sparkles, Users, LayoutDashboard, ScrollText, Search, Settings2, Zap, ShieldAlert, ShieldCheck, Skull, Droplets, Hourglass, Crown, Repeat2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SearchableGrantPicker } from "@/components/ui/searchable-grant-picker";
import { ContinuousTurnDialog } from "@/components/combat/ContinuousTurnDialog";
import { InventoryPanel } from "@/components/inventory/InventoryPanel";
import { pendingContinuousInstances, parseContinuousRules, type ContinuousInstance, type ContinuousDecision } from "@/lib/continuous-effects";
import { parseAttributeStatusModifiers, type AttributeStatusModifier } from "@/lib/multi-attribute-effects";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { supabase } from "@/integrations/supabase/client";
import { dispatchCustomAbilityScriptEvents } from "@/lib/ability-script-runtime";

import { computeValue, conditionAdjustedValue, clampNonDefenseAttribute, physicalAttributePoints, traitMods, numberAllocation, useDefs, useMe, useRaces, useVirtues, useClasses, type AttributeDef } from "@/lib/sheets";
import { Portrait } from "@/components/sheet/CharacterSheetView";
import { CombatPortraitViewer, type CombatPortrait } from "@/components/combat/CombatPortraitViewer";
import { StatBar } from "@/components/sheet/StatBar";
import { cn } from "@/lib/utils";
import { DamageApplier } from "@/components/combat/DamageApplier";
import { FlorinPetalsControl, type FlorinPetalsState } from "@/components/combat/FlorinPetalsControl";
import { calculateManualCombatHp } from "@/lib/combat-hp-adjustment";
import { passiveEffectsForDisplay, unregisteredPassiveEffectsForDisplay, combatEffectBadgeCounts, type PassiveEffectDisplay } from "@/lib/passive-effect-display";
import { attackDiceModifier, hasActiveStun } from "@/lib/combat-dice";
import { DamageOverTimeManager } from "@/components/combat/DamageOverTimeManager";
import { CharacterAbilitiesPanel, effectSummary } from "@/components/abilities/CharacterAbilities";
import { TransformationAdvancedActivationDialog, type TransformationActivationOverrides } from "@/components/transformations/TransformationAdvancedActivationDialog";
import { SummonCombatPanel } from "@/components/summons/Summons";
import { parseAbilityEffects, passiveEffectTypeActive, passiveRegenerationModifiers, passiveStatusModifiers, useAbilities, useBattleCharacterAbilities, useCharacterAbilities, useDamageTypes, useDotTemplates, type AbilityEffectDefinition } from "@/lib/abilities";

export const Route = createFileRoute("/_authenticated/combate")({
  head: () => ({
    meta: [
      { title: "Modo de Combate — Grimório" },
      { name: "description", content: "Batalhas, turnos e dados para rolar." },
      { property: "og:title", content: "Modo de Combate — Grimório" },
      { property: "og:description", content: "Batalhas, turnos e dados para rolar." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CombatPage,
});

type Attr = { attribute_key: string; current_value: number; max_value: number; points: number; bonus: number };
type BattleEffect = { id: string; battle_id: string | null; character_id: string; name: string; effect_type: 'status' | 'regeneration' | 'mana_used' | 'no_regen_hp' | 'no_regen_mana' | 'magic_prohibition' | 'no_mana' | 'stun' | 'damage_dealt' | 'damage_reduction' | 'healing' | 'invincible' | 'healing_blocked' | 'damage_vulnerability' | 'damage_over_time' | 'debuff_relief' | 'mind_control' | 'mental_control_immunity' | 'mental_control_chance' | 'mental_control_resistance' | 'dot_immunity' | 'dot_resistance' | 'invisibility'; attribute_key: string | null; polarity: 'buff' | 'debuff'; value_mode: 'percent' | 'fixed'; amount: number; duration: number; duration_scope: 'individual' | 'global'; until_combat_end: boolean; effect_data?: Json; damage_scope?: 'any' | 'physical' | 'magical'; damage_reduction_scope?: 'physical' | 'magical'; damage_reduction_type_id?: string | null; damage_reduction_magic_level?: 'baixa' | 'media' | 'alta' | null; damage_reduction_type_ids?: string[] | null; damage_reduction_magic_levels?: ('baixa' | 'media' | 'alta')[] | null; source_character_ability_id?: string | null; source_race_id?: string | null; source_race_effect_index?: number | null; source_class_id?: string | null; source_class_effect_index?: number | null; effect_group_id?: string | null; is_end_effect?: boolean; is_sheet_permanent?: boolean; source_virtue_id?: string | null; source_virtue_effect_index?: number | null };
function damageReductionSummary(effect: BattleEffect, damageTypes: { id: string; name: string }[]) {
  const selectedTypeIds = effect.damage_reduction_type_ids ?? (effect.damage_reduction_type_id ? [effect.damage_reduction_type_id] : []);
  const selectedLevels = effect.damage_reduction_magic_levels ?? (effect.damage_reduction_magic_level ? [effect.damage_reduction_magic_level] : []);
  const typeNames = selectedTypeIds.length === 0
    ? "todos os tipos"
    : selectedTypeIds.map((id) => damageTypes.find((type) => type.id === id)?.name ?? "tipo removido").join(", ");
  const levelNames = selectedLevels.length === 0
    ? "todos os graus"
    : selectedLevels.map((level) => level === "baixa" ? "baixa" : level === "media" ? "média" : "alta").join(", ");
  const scope = effect.damage_reduction_scope === "magical" ? `mágica (${typeNames}; grau(s) ${levelNames})` : "física";
  return `Mitigação ${scope}: ${effect.value_mode === "percent" ? `${effect.amount}%` : `${effect.amount} fixos`} reduzidos depois da defesa`;
}

function damageOverTimeSummary(effect: BattleEffect, damageTypes: { id: string; name: string }[]) {
  const raw = effect.effect_data;
  const config: Record<string, Json | undefined> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, Json | undefined>
      : {};
  const physical = config.damage_kind === "physical";
  const typeId = String(physical ? config.physical_damage_type_id ?? "" : config.damage_type_id ?? "");
  const typeName = damageTypes.find((type) => type.id === typeId)?.name ?? (physical ? "tipo físico removido" : "tipo mágico removido");
  const mode = config.damage_mode === "percent" ? "percent" : "fixed";
  const rawAmount = Number(config.damage_amount ?? effect.amount);
  const amount = Number.isFinite(rawAmount) ? rawAmount : Number(effect.amount);
  const level = config.magic_level === "baixa" ? "baixa" : config.magic_level === "media" ? "média" : config.magic_level === "alta" ? "alta" : null;
  const typeLabel = physical ? `Físico · ${typeName}` : `Mágico · ${typeName}${level ? ` · magia ${level}` : ""}`;
  return `DoT — ${typeLabel}: ${mode === "percent" ? `${amount}% do HP máximo` : `${amount} fixos`} por turno`;
}


function periodicHealingSummary(effect: BattleEffect) {
  const raw = effect.effect_data;
  const config: Record<string, Json | undefined> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, Json | undefined>
      : {};
  const parts: string[] = [];
  const addResource = (
    enabledKey: string,
    modeKey: string,
    amountKey: string,
    label: string,
    fixedLabel: string,
    percentLabel: string,
  ) => {
    if (config[enabledKey] !== true) return;
    const numericAmount = Number(config[amountKey] ?? 0);
    const safeAmount = Number.isFinite(numericAmount) ? numericAmount : 0;
    const mode = config[modeKey] === "percent" ? "percent" : "fixed";
    const amount = mode === "percent" ? `${safeAmount}% ${percentLabel}` : `${safeAmount} ${fixedLabel}`;
    parts.push(`${label}: +${amount} por rodada`);
  };

  addResource("healing_hp_enabled", "healing_hp_mode", "healing_hp_amount", "HP", "fixos", "do máximo");
  addResource("healing_mana_enabled", "healing_mana_mode", "healing_mana_amount", "Mana", "fixos", "do máximo");
  addResource("healing_body_enabled", "healing_body_mode", "healing_body_amount", "Corpo", "pontos percentuais", "do que falta");
  addResource("healing_sanity_enabled", "healing_sanity_mode", "healing_sanity_amount", "Sanidade", "pontos percentuais", "do que falta");

  if (parts.length === 0) {
    return "Cura por rodada: nenhum recurso de HP, Mana, Corpo ou Sanidade configurado";
  }
  return `Cura por rodada: ${parts.join("; ")}`;
}

type Fighter = {
  id: string; name: string; player_name: string; photo_path: string | null; race_id: string | null; virtue_id: string | null; class_id: string | null; owner_id: string | null; class_custom_modifiers?: Json;
  race_physical_allocations: Json; virtue_physical_allocations: Json; class_physical_allocations: Json; race_physical_points_granted: number; virtue_physical_points_granted: number; class_physical_points_granted: number;
  body: number; sanity: number; participant_turn_count?: number;
  mana_regen_enabled?: boolean;
  mana_regen_mode?: "fixed" | "percent";
  mana_regen_amount?: number;
  character_attributes: Attr[];
};
type TransformationTemplate = {
  id: string;
  name: string;
  description: string | null;
  duration_turns: number;
  cooldown_turns: number;
  mana_cost: number;
  modifiers: Json;
  effects: Json;
  end_effects: Json;
  owner_character_id?: string | null;
  source_transformation_id?: string | null;
  source_inventory_item_id?: string | null;
};
type TransformationLink = { transformation_id: string; race_id?: string; virtue_id?: string; class_id?: string };
type CharacterTransformationState = {
  character_id: string;
  transformation_id: string;
  image_path: string | null;
  active: boolean;
  cooldown_remaining: number;
  active_duration_remaining: number;
  active_effect_group_id: string | null;
};

/** Applied total of an attribute (points + race + buff/debuff). */
function totalOf(def: AttributeDef, a: Attr | undefined, mods: Record<string, number>, physicalPoints = 0) {
  const race = mods[def.key] ?? 0;
  const value = !def.accepts_points
    ? (a?.max_value ?? 0) + race + (a?.bonus ?? 0)
    : computeValue(def, (a?.points ?? 0) + race + physicalPoints) + (a?.bonus ?? 0);
  // A racial penalty must never make a character's maximum HP zero or negative.
  return def.key === "hp" ? Math.max(1, value) : value;
}
const diceMod = (mine: number, theirs: number) => Math.max(0, Math.floor((mine - theirs) / 10));
const dice = (m: number) => `1d20+${m}`;

function HiddenResourceState({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border p-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="font-semibold">{value}</div>
    </div>
  );
}

// Coalesce Realtime notifications and explicit post-action refreshes into one batch.
// A single turn can update many effect rows, so invalidating on every row causes repeated refetches.
type PendingCombatRefresh = {
  timer?: ReturnType<typeof setTimeout>;
  queryKeys: Map<string, QueryKey>;
};

const pendingCombatRefreshes = new WeakMap<QueryClient, PendingCombatRefresh>();

function scheduleCombatRefresh(queryClient: QueryClient, ...queryKeys: QueryKey[]) {
  const batch = pendingCombatRefreshes.get(queryClient) ?? { queryKeys: new Map<string, QueryKey>() };
  pendingCombatRefreshes.set(queryClient, batch);

  for (const queryKey of queryKeys) {
    batch.queryKeys.set(JSON.stringify(queryKey), queryKey);
  }

  // Flush regularly even during a burst of Realtime events. Resetting the
  // timer on every event could postpone a refresh indefinitely.
  if (batch.timer) return;
  batch.timer = setTimeout(() => {
    if (pendingCombatRefreshes.get(queryClient) !== batch) return;
    pendingCombatRefreshes.delete(queryClient);
    const keysToRefresh = [...batch.queryKeys.values()];
    void Promise.all(keysToRefresh.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  }, 150);
}

function useLiveBattles(isMaster: boolean, userId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    const refreshBattles = () => scheduleCombatRefresh(qc, ["battles"], ["battle-character-public-states"]);
    const dispatchAndRefreshScripts = () => {
      if (!isMaster) return;
      void dispatchCustomAbilityScriptEvents().then(() => {
        // Script effects are inserted asynchronously *after* the HP/turn write.
        // Re-fetch both effect lists once the script queue has been drained.
        scheduleCombatRefresh(qc, ["battle-effects"], ["character-active-effects"], ["character-abilities"]);
      });
    };
    const ch = supabase
      .channel("battles-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "battles" }, refreshBattles)
      .on("postgres_changes", { event: "*", schema: "public", table: "battle_participants" }, () => {
        refreshBattles();
        dispatchAndRefreshScripts();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "character_attributes" }, () => {
        refreshBattles();
        // The HP-change trigger can queue Sedento por Sangue script events when
        // HP is edited directly, not only by damage/turn actions.
        dispatchAndRefreshScripts();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "characters" }, refreshBattles)
      .on("postgres_changes", { event: "*", schema: "public", table: "character_abilities" }, () => {
        scheduleCombatRefresh(qc, ["character-abilities"], ["character-abilities-battle"]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "battle_effects" }, () => {
        scheduleCombatRefresh(qc, ["battles"], ["battle-effects"], ["character-active-effects"], ["battle-character-public-states"]);
        dispatchAndRefreshScripts();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "character_abilities" }, () => {
        scheduleCombatRefresh(qc, ["character-abilities"], ["character-abilities-battle"], ["battle-character-public-states"]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "character_transformations" }, () => {
        scheduleCombatRefresh(qc, ["character-transformations"], ["battle-character-transformations"], ["battles"]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "transformations" }, () => {
        scheduleCombatRefresh(qc, ["transformations"], ["battle-character-transformations"]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "transformation_abilities" }, () => {
        scheduleCombatRefresh(qc, ["battle-transformation-abilities"]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "race_transformations" }, () => {
        scheduleCombatRefresh(qc, ["battle-race-transformations"], ["battles"]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "virtue_transformations" }, () => {
        scheduleCombatRefresh(qc, ["battle-virtue-transformations"], ["battles"]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "class_transformations" }, () => {
        scheduleCombatRefresh(qc, ["battle-class-transformations"], ["battles"]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "abilities" }, () => {
        scheduleCombatRefresh(qc, ["abilities"]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "active_summons" }, () => {
        scheduleCombatRefresh(qc, ["active-summons"], ["active-summon-names"], ["battles"], ["character-active-effects"]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "summon_grants" }, () => {
        scheduleCombatRefresh(qc, ["summon-grants"], ["character-abilities"], ["battles"]);
      })
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [qc, isMaster]);
  return useQuery({
    queryKey: ["battles", userId, isMaster],
    enabled: !!userId,
    // Mobile browsers may suspend the Realtime connection in an embedded
    // preview or after returning from another app. Poll visible battles as a
    // bounded fallback, without needing a manual page reload.
    refetchInterval: 5000,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    queryFn: async () => {
      const masterSelection = "*, battle_participants(sort_order,turn_count,mana_regen_enabled,mana_regen_mode,mana_regen_amount, characters(id,name,player_name,photo_path,race_id,virtue_id,class_id,class_custom_modifiers,owner_id,race_physical_allocations,virtue_physical_allocations,class_physical_allocations,race_physical_points_granted,virtue_physical_points_granted,class_physical_points_granted,body,sanity,character_attributes(attribute_key,current_value,max_value,points,bonus)))";
      const playerSelection = "*, battle_participants(sort_order,turn_count,mana_regen_enabled,mana_regen_mode,mana_regen_amount, characters(id,name,player_name,photo_path,owner_id,race_id,virtue_id,class_id))";
      const { data, error } = await supabase
        .from("battles")
        .select(isMaster ? masterSelection : playerSelection)
        .order("created_at", { ascending: false });
      if (error) throw error;
      if (isMaster || !userId) return data ?? [];

      type PublicCharacter = { id: string; name: string; player_name: string; photo_path: string | null; owner_id: string | null; race_id: string | null; virtue_id: string | null; class_id: string | null };
      type PublicParticipant = { characters: PublicCharacter | null; [key: string]: unknown };
      type PublicBattle = { battle_participants?: PublicParticipant[]; [key: string]: unknown };
      const publicBattles = (data ?? []) as unknown as PublicBattle[];
      const ownIds = [...new Set(publicBattles.flatMap((row) =>
        (row.battle_participants ?? [])
          .map((participant) => participant.characters)
          .filter((character): character is PublicCharacter => !!character && character.owner_id === userId)
          .map((character) => character.id)
      ))];

      if (ownIds.length === 0) return data ?? [];

      const { data: ownedCharacters, error: ownedError } = await supabase
        .from("characters")
        .select("id,name,player_name,photo_path,owner_id,race_id,virtue_id,class_id,class_custom_modifiers,race_physical_allocations,virtue_physical_allocations,class_physical_allocations,race_physical_points_granted,virtue_physical_points_granted,class_physical_points_granted,body,sanity,character_attributes(attribute_key,current_value,max_value,points,bonus)")
        .in("id", ownIds);
      if (ownedError) throw ownedError;

      const ownById = new Map((ownedCharacters ?? []).map((character) => [character.id, character]));
      const hydrated = publicBattles.map((row) => ({
        ...row,
        battle_participants: (row.battle_participants ?? []).map((participant) => {
          const character = participant.characters;
          if (!character || character.owner_id !== userId) return participant;
          return { ...participant, characters: ownById.get(character.id) ?? character };
        }),
      }));
      return hydrated as unknown as typeof data;
    },
  });
}

function CombatPage() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const isMaster = !!me?.isMaster;
  const { data: battles, isLoading } = useLiveBattles(isMaster, me?.user.id);
  const [sel, setSel] = useState<string | null>(null);
  const list = (battles ?? []).filter((b) => isMaster || b.active);
  const battle = list.find((b) => b.id === sel) ?? list[0];

  async function create() {
    const { data, error } = await supabase.from("battles").insert({ name: `Batalha ${list.length + 1}` }).select("id").single();
    if (error) { toast.error(error.message); return; }
    setSel(data.id);
    // This write belongs to this tab. Do not wait for a Realtime echo:
    // otherwise a brand-new battle remains invisible until page refresh.
    await qc.invalidateQueries({ queryKey: ["battles"] });
  }

  if (isLoading || !me) return <p className="text-muted-foreground">Carregando…</p>;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grimorio-page-heading min-w-0"><span className="rounded-lg border border-gold/40 bg-gold/10 p-2"><Swords className="h-6 w-6 text-gold" /></span><div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[.23em] text-muted-foreground">Central do mestre</p><h1 className="truncate text-2xl text-gold sm:text-3xl">Modo de Combate</h1></div></div>
        {isMaster && <Button onClick={create}><Plus className="mr-1 h-4 w-4" /> Nova batalha</Button>}
      </div>
      {list.length === 0 ? (
        <p className="text-muted-foreground">{isMaster ? "Nenhuma batalha criada." : "Seu personagem não está em nenhuma batalha agora."}</p>
      ) : (
        <>
          {list.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {list.map((b) => (
                <Button key={b.id} size="sm" variant={b.id === battle?.id ? "default" : "outline"} onClick={() => setSel(b.id)}>
                  {b.name}{!b.active && " (encerrada)"}
                </Button>
              ))}
            </div>
          )}
          {battle && <BattleView key={battle.id} battle={battle} isMaster={isMaster} userId={me.user.id} />}
        </>
      )}
    </div>
  );
}

type BattlesData = NonNullable<ReturnType<typeof useLiveBattles>["data"]>;
type BattleRow = BattlesData[number];


type CombatTab = "fighters" | "actions" | "summary" | "activity";
type CombatActivityKind = "turn" | "damage" | "effect" | "transformation";
type CombatActivity = { id: number; kind: CombatActivityKind; label: string; at: string };

const combatTabs = [
  { key: "fighters", label: "Combatentes", icon: Users },
  { key: "actions", label: "Ações", icon: Zap },
  { key: "summary", label: "Resumo", icon: LayoutDashboard },
  { key: "activity", label: "Atividade", icon: ScrollText },
] as const;

function CombatNavigation({ active, onSelect, mobile = false }: {
  active: CombatTab;
  onSelect: (tab: CombatTab) => void;
  mobile?: boolean;
}) {
  return (
    <nav aria-label="Seções do combate" className={mobile
      ? "fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-gold/30 bg-[#100c0a]/95 px-1 pt-2 pb-[max(.75rem,env(safe-area-inset-bottom))] shadow-2xl backdrop-blur-xl md:hidden"
      : "panel hidden grid-cols-4 gap-2 rounded-xl p-1.5 md:grid"}>
      {combatTabs.map(({ key, label, icon: Icon }) => (
        <button key={key} type="button" aria-current={active === key ? "page" : undefined}
          onClick={() => onSelect(key)}
          className={cn(
            "flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-[11px] font-semibold transition-colors md:flex-row md:gap-2 md:text-sm",
            active === key ? "bg-gradient-to-b from-gold/20 to-gold/5 text-gold ring-1 ring-gold/45 shadow-[inset_0_1px_0_rgba(245,215,149,.1)]" : "text-muted-foreground hover:bg-gold/10 hover:text-gold",
          )}>
          <Icon className="h-5 w-5 shrink-0 md:h-4 md:w-4" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </button>
      ))}
    </nav>
  );
}

function BattleView({ battle, isMaster, userId }: { battle: BattleRow; isMaster: boolean; userId: string }) {
  const { data: defs } = useDefs();
  const { data: races } = useRaces();
  const { data: virtues } = useVirtues();
  const { data: classes } = useClasses();
  const qc = useQueryClient();
  const [combatTab, setCombatTab] = useState<CombatTab>("fighters");
  const [previewPortrait, setPreviewPortrait] = useState<CombatPortrait | null>(null);
  const [actionMode, setActionMode] = useState<"combat" | "abilities" | "dots">("combat");
  const [detailTab, setDetailTab] = useState<"status" | "abilities" | "summons" | "transformations" | "effects" | "activeEffects" | "inventory">("status");
  const [battleAdminOpen, setBattleAdminOpen] = useState(false);
  const [fighterSearch, setFighterSearch] = useState("");
  const [fighterFilter, setFighterFilter] = useState<"all" | "targets" | "effects" | "critical">("all");
  const [combatActivity, setCombatActivity] = useState<CombatActivity[]>([]);
  function noteActivity(kind: CombatActivityKind, label: string) {
    setCombatActivity((current) => [{
      id: Date.now() + Math.random(),
      kind, label,
      at: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    }, ...current].slice(0, 80));
  }
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>(() => battle.target_character_id ? [battle.target_character_id] : []);
  const [manaRegenSettings, setManaRegenSettings] = useState<Record<string, { mode: "percent" | "fixed"; amount: string }>>({});
  const [savingManaRegen, setSavingManaRegen] = useState<Set<string>>(() => new Set());
  const [regeneratingManaIds, setRegeneratingManaIds] = useState<Set<string>>(() => new Set());
  const regeneratingManaInFlight = useRef<Set<string>>(new Set());
  const [advancingTurnKeys, setAdvancingTurnKeys] = useState<Set<string>>(() => new Set());
  const [pendingContinuousTurn,setPendingContinuousTurn] = useState<{ characterId:string|null; title:string; items:ContinuousInstance[] } | null>(null);
  const [stoppingContinuous,setStoppingContinuous] = useState<string|null>(null);
  // Keep cards compact by default; expand detailed abilities/resources independently per character.
  const [expandedFighterIds, setExpandedFighterIds] = useState<Set<string>>(() => new Set());
  const [expandedTransformationDetailsIds, setExpandedTransformationDetailsIds] = useState<Set<string>>(() => new Set());
  const fighters = useMemo(
    () => battle.battle_participants.slice().sort((a, b) => {
      const characterA = a.characters as { id?: string; name?: string } | null;
      const characterB = b.characters as { id?: string; name?: string } | null;
      const idA = characterA?.id ?? "";
      const idB = characterB?.id ?? "";
      const actorA = idA === battle.current_character_id;
      const actorB = idB === battle.current_character_id;
      if (actorA !== actorB) return actorA ? -1 : 1;

      const orderDiff = Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0);
      if (orderDiff !== 0) return orderDiff;

      const nameDiff = String(characterA?.name ?? "").localeCompare(String(characterB?.name ?? ""), "pt-BR");
      return nameDiff || idA.localeCompare(idB);
    }).map((p) => {
      const character = p.characters as Fighter;
      return {
        ...character,
        character_attributes: character?.character_attributes ?? [],
        participant_turn_count: p.turn_count ?? 0,
        mana_regen_enabled: p.mana_regen_enabled ?? false,
        mana_regen_mode: p.mana_regen_mode ?? "fixed",
        mana_regen_amount: Number(p.mana_regen_amount ?? 40),
      };
    }).filter((fighter) => !!fighter.id),
    [battle],
  );
  const fighterIds = useMemo(() => fighters.map((fighter) => fighter.id), [fighters]);
  const { data: florinPetals = [] } = useQuery<FlorinPetalsState[]>({
    queryKey: ["florin-petals", battle.id],
    enabled: isMaster && battle.active,
    refetchInterval: 6000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("list_florin_petals_battle", { _battle_id: battle.id });
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    },
  });
  const db = supabase as any;
  const { data: battleInventoryOrigins = [] } = useQuery<Array<{id:string;character_id:string;equipped:boolean;item_templates:{name:string}|null}>>({
    queryKey: ["battle-accessory-origins", battle.id, fighterIds],
    enabled: fighterIds.length > 0,
    refetchInterval: 8000,
    queryFn: async () => {
      const {data,error}=await db.from("character_inventory").select("id,character_id,equipped,item_templates(name)").in("character_id",fighterIds);
      if(error)throw error;
      return data ?? [];
    },
  });
  const { data: continuousInstances = [] } = useQuery<ContinuousInstance[]>({
    queryKey:["battle-continuous-instances",battle.id],
    enabled:isMaster && battle.active,
    refetchInterval:8000,
    queryFn:async()=>{
      const {data,error}=await db.from("continuous_effect_instances").select(
        "id,battle_id,character_ability_id,caster_character_id,target_character_id,name,ticks,rule,active"
      ).eq("battle_id",battle.id).eq("active",true).order("created_at");
      if(error)throw error;
      return (data??[]).map((item:ContinuousInstance)=>({...item,rule:parseContinuousRules([item.rule])[0]??item.rule}));
    },
  });
  const { data: transformationCatalog = [] } = useQuery<TransformationTemplate[]>({
    queryKey: ["transformations"],
    queryFn: async () => {
      const { data, error } = await db.from("transformations").select("id,name,description,duration_turns,cooldown_turns,mana_cost,owner_character_id,source_transformation_id,source_inventory_item_id,modifiers,effects,end_effects").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: transformationAbilityGrants = [] } = useQuery<Array<{ transformation_id: string; ability_id: string; only_while_transformed: boolean }>>({
    queryKey: ["battle-transformation-abilities"],
    queryFn: async () => {
      const { data, error } = await db.from("transformation_abilities").select("transformation_id,ability_id,only_while_transformed");
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: transformationAbilityCatalog = [] } = useAbilities();
  const { data: transformationDamageTypes = [] } = useDamageTypes();

  const { data: raceTransformationLinks = [] } = useQuery<TransformationLink[]>({
    queryKey: ["battle-race-transformations"],
    queryFn: async () => {
      const { data, error } = await db.from("race_transformations").select("race_id,transformation_id");
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: virtueTransformationLinks = [] } = useQuery<TransformationLink[]>({
    queryKey: ["battle-virtue-transformations"],
    queryFn: async () => {
      const { data, error } = await db.from("virtue_transformations").select("virtue_id,transformation_id");
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: classTransformationLinks = [] } = useQuery<TransformationLink[]>({
    queryKey: ["battle-class-transformations"],
    queryFn: async () => {
      const { data, error } = await db.from("class_transformations").select("class_id,transformation_id");
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: transformationStates = [] } = useQuery<CharacterTransformationState[]>({
    queryKey: ["battle-character-transformations", battle.id, fighterIds],
    enabled: fighterIds.length > 0,
    queryFn: async () => {
      const { data, error } = await db.from("character_transformations")
        .select("character_id,transformation_id,image_path,active,cooldown_remaining,active_duration_remaining,active_effect_group_id")
        .in("character_id", fighterIds);
      if (error) throw error;
      return data ?? [];
    },
  });
  const transformStateFor = (fighterId: string) => transformationStates.filter((state) => state.character_id === fighterId);
  const availableTransformationsFor = (fighter: Fighter) => {
    const ids = new Set([
      ...raceTransformationLinks.filter((link) => link.race_id === fighter.race_id).map((link) => link.transformation_id),
      ...virtueTransformationLinks.filter((link) => link.virtue_id === fighter.virtue_id).map((link) => link.transformation_id),
      ...classTransformationLinks.filter((link) => link.class_id === fighter.class_id).map((link) => link.transformation_id),
      ...transformationCatalog.filter((transformation) => transformation.owner_character_id === fighter.id).map((transformation) => transformation.id),
    ]);
    const overriddenIds = new Set(transformationCatalog
      .filter((transformation) => transformation.owner_character_id === fighter.id && transformation.source_transformation_id)
      .map((transformation) => transformation.source_transformation_id as string));
    return transformationCatalog.filter((transformation) => ids.has(transformation.id) && !overriddenIds.has(transformation.id));
  };
  const [activatingTransformationFor, setActivatingTransformationFor] = useState<string | null>(null);
  const [endingTransformationFor, setEndingTransformationFor] = useState<string | null>(null);
  const [pendingEndTransformation, setPendingEndTransformation] = useState<{
    characterId: string;
    transformationId: string;
    characterName: string;
    transformationName: string;
  } | null>(null);
  const [advancedTransformation, setAdvancedTransformation] = useState<{
    characterId: string; characterName: string; template: TransformationTemplate;
  } | null>(null);
  // Normal button activates immediately; customization is an optional master-only action.
  async function activateTransformation(characterId: string, transformationId: string, overrides?: TransformationActivationOverrides): Promise<boolean> {
    if (!battle.active || activatingTransformationFor) return false;
    setActivatingTransformationFor(characterId);
    try {
      const { data, error } = await db.rpc("activate_character_transformation", {
        _character_id: characterId,
        _transformation_id: transformationId,
        _battle_id: battle.id,
        ...(overrides ? { _effect_overrides: overrides } : {}),
      });
      if (error) {
        toast.error(error.message);
        return false;
      }
      const result = data && typeof data === "object" ? data as Record<string, unknown> : {};
      toast.success("Transformação ativada");
      noteActivity("transformation", "Transformação ativada: " + (transformationCatalog.find((item) => item.id === transformationId)?.name ?? "transformação") + ".");
      const configuredTransformation = transformationCatalog.find((item) => item.id === transformationId);
      const activeDuration = (typeof result.duration_remaining === "number" ? result.duration_remaining : undefined)
        ?? configuredTransformation?.duration_turns;
      if (activeDuration) toast.info(`Duração: ${activeDuration} turno(s)`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["battle-character-transformations"] }),
        qc.invalidateQueries({ queryKey: ["character-transformations"] }),
        qc.invalidateQueries({ queryKey: ["battles"] }),
        qc.invalidateQueries({ queryKey: ["character-attributes"] }),
        qc.invalidateQueries({ queryKey: ["battle-effects"] }),
      ]);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível ativar a transformação.");
      return false;
    } finally {
      setActivatingTransformationFor(null);
    }
  }
  function requestEndTransformation(characterId: string, transformationId: string) {
    if (!battle.active || activatingTransformationFor || endingTransformationFor) return;
    setPendingEndTransformation({
      characterId,
      transformationId,
      characterName: fighters.find((fighter) => fighter.id === characterId)?.name ?? "Personagem",
      transformationName: transformationCatalog.find((item) => item.id === transformationId)?.name ?? "Transformação ativa",
    });
  }
  async function endTransformation() {
    const pending = pendingEndTransformation;
    if (!pending || !battle.active || activatingTransformationFor || endingTransformationFor) return;
    const { characterId, transformationId, transformationName: name } = pending;
    setEndingTransformationFor(characterId);
    try {
      const { error } = await db.rpc("end_character_transformation", {
        _character_id: characterId,
        _transformation_id: transformationId,
        _battle_id: battle.id,
      });
      if (error) throw error;
      setPendingEndTransformation(null);
      toast.success(`Transformação "${name}" encerrada.`);
      noteActivity("transformation", "Transformação encerrada manualmente: " + name + ".");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["battle-character-transformations"] }),
        qc.invalidateQueries({ queryKey: ["character-transformations"] }),
        qc.invalidateQueries({ queryKey: ["transformations"] }),
        qc.invalidateQueries({ queryKey: ["battle-effects"] }),
        qc.invalidateQueries({ queryKey: ["character-active-effects"] }),
        qc.invalidateQueries({ queryKey: ["character-abilities"] }),
        qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
        qc.invalidateQueries({ queryKey: ["character-attributes"] }),
        qc.invalidateQueries({ queryKey: ["battles"] }),
      ]);
    } catch (error) {
      toast.error("Não foi possível destransformar: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setEndingTransformationFor(null);
    }
  }
  const visibleEffectCharacterIds = useMemo(
    () => isMaster ? fighterIds : fighters.filter((fighter) => fighter.owner_id === userId).map((fighter) => fighter.id),
    [isMaster, fighterIds, fighters, userId],
  );
  const { data: publicStates = [] } = useQuery({
    queryKey: ["battle-character-public-states", battle.id],
    enabled: !isMaster && !!battle.active,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_battle_character_public_states", { _battle_id: battle.id });
      if (error) throw error;
      return data ?? [];
    },
  });
  const publicStateByCharacter = useMemo(
    () => new Map(publicStates.map((state) => [state.character_id, state])),
    [publicStates],
  );
  const { data: effects = [] } = useQuery({
    queryKey: ["battle-effects", battle.id, visibleEffectCharacterIds],
    enabled: visibleEffectCharacterIds.length > 0,
    refetchInterval: battle.active ? 5000 : false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    queryFn: async () => {
      const [battleResult, standaloneResult] = await Promise.all([
        supabase.from("battle_effects").select("*").eq("battle_id", battle.id).in("character_id", visibleEffectCharacterIds),
        supabase.from("battle_effects").select("*").is("battle_id", null).in("character_id", visibleEffectCharacterIds),
      ]);
      if (battleResult.error) throw battleResult.error;
      if (standaloneResult.error) throw standaloneResult.error;
      const unique = new Map<string, BattleEffect>();
      for (const effect of [...(battleResult.data ?? []), ...(standaloneResult.data ?? [])]) unique.set(effect.id, effect as BattleEffect);
      return [...unique.values()];
    },
  });
  const { data: battleAbilities = [] } = useBattleCharacterAbilities(battle.id, fighterIds);
  const abilitiesOf = (fighterId: string) => battleAbilities.filter((ability) => ability.character_id === fighterId);
  const modsOf = (f: Fighter) => {
    const race = races?.find((r) => r.id === f.race_id);
    const classTrait = classes?.find((c) => c.id === f.class_id);
    const getMechanics = (trait: { special_mechanics?: unknown } | undefined) => {
      const value = trait?.special_mechanics;
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    };
    const multiplier = (mechanics: Record<string, unknown>) => {
      const blacklist = Array.isArray(mechanics.virtue_effect_blacklist) ? mechanics.virtue_effect_blacklist : [];
      const blacklisted = !!f.virtue_id && blacklist.includes(f.virtue_id);
      return mechanics.duplicate_virtue_effects === true && !blacklisted
        ? Math.max(1, Math.min(10, Number(mechanics.virtue_effect_multiplier) || 2))
        : 1;
    };
    const combined = { ...traitMods(race) };
    for (const [key, value] of Object.entries(traitMods(classTrait))) combined[key] = (combined[key] ?? 0) + value;
    // Bônus concedidos individualmente pelo mestre junto com a classe. Eles valem em combate
    // enquanto o personagem mantiver essa classe, sem alterar os bônus-base da classe.
    for (const [key, value] of Object.entries(numberAllocation(f.class_custom_modifiers))) combined[key] = (combined[key] ?? 0) + value;
    const virtueMultiplier = multiplier(getMechanics(race)) * multiplier(getMechanics(classTrait));
    for (const [key, value] of Object.entries(traitMods(virtues?.find((v) => v.id === f.virtue_id)))) {
      combined[key] = (combined[key] ?? 0) + value * virtueMultiplier;
      if (combined[key] === 0) delete combined[key];
    }
    return combined;
  };
  const val = (f: Fighter, key: string) => {
    const def = defs?.find((d) => d.key === key);
    const noMana = effects.some((e) => e.character_id === f.id && e.effect_type === "no_mana" && e.polarity === "debuff")
      || passiveEffectTypeActive(abilitiesOf(f.id), "no_mana");
    const base = def ? totalOf(def, f.character_attributes.find((a) => a.attribute_key === key), modsOf(f), physicalAttributePoints(f, key)) : 0;
    const active = effects.filter(e => e.character_id === f.id && e.effect_type === "status" && e.attribute_key === key);
    const passive = passiveStatusModifiers(abilitiesOf(f.id))[key] ?? { fixed: 0, percent: 0 };
    const fixed = passive.fixed + active.filter(e => e.value_mode === "fixed").reduce((n,e) => n + (e.polarity === "buff" ? 1 : -1) * Number(e.amount), 0);
    const percent = passive.percent + active.filter(e => e.value_mode === "percent").reduce((n,e) => n + (e.polarity === "buff" ? 1 : -1) * Number(e.amount), 0);
    const result = Math.floor((base + fixed) * (1 + percent / 100));
    return noMana && key === "mana" ? 0 : key === "hp" ? Math.max(1, result) : conditionAdjustedValue(f, key, clampNonDefenseAttribute(key, result));
  };
  const blocked = (fighterId: string, type: "no_regen_hp" | "no_regen_mana" | "no_mana") =>
    effects.some(e => e.character_id === fighterId && e.effect_type === type) ||
    passiveEffectTypeActive(abilitiesOf(fighterId), type);
  const regenValue = (fighterId: string, key: "hp" | "mana", base: number) => {
    if (blocked(fighterId, key === "hp" ? "no_regen_hp" : "no_regen_mana") || (key === "mana" && blocked(fighterId, "no_mana"))) return 0;
    const active = effects.filter(e => e.character_id === fighterId && e.effect_type === "regeneration" && e.attribute_key === key);
    const passive = passiveRegenerationModifiers(abilitiesOf(fighterId), key);
    const fixed = passive.fixed + active.filter(e => e.value_mode === "fixed").reduce((n,e) => n + (e.polarity === "buff" ? 1 : -1) * Number(e.amount), 0);
    const percent = passive.percent + active.filter(e => e.value_mode === "percent").reduce((n,e) => n + (e.polarity === "buff" ? 1 : -1) * Number(e.amount), 0);
    return Math.max(0, Math.floor(base * (1 + percent / 100) + fixed));
  };
  async function advanceCombatTurn(characterId: string | null, decisions?:Record<string,ContinuousDecision>) {
    const due=pendingContinuousInstances(continuousInstances,characterId);
    if(due.length && !decisions){
      setPendingContinuousTurn({
        characterId,items:due,
        title:characterId ? "Turno de "+(fighters.find(f=>f.id===characterId)?.name??"personagem") : "Turno geral",
      });
      return;
    }
    // Track loading per button: one fighter advancing must not make every
    // individual-turn button look like it is processing.
    if (!isMaster) return;
    const turnKey = characterId ?? "__global__";
    if (advancingTurnKeys.has(turnKey)) return;
    setAdvancingTurnKeys((current) => new Set(current).add(turnKey));

    try {
      const turnFighters = characterId ? fighters.filter((fighter) => fighter.id === characterId) : fighters;
      if (characterId && turnFighters.length === 0) {
        toast.error("Personagem não encontrado nesta batalha");
        return;
      }

      // The server uses the enabled checkbox and persisted configuration for
      // each fighter, avoiding accidental regeneration from stale browser tabs.
      const manaRegenerationSettingsForTurn: Record<string, never> = {};

      const { data: nextTurn, error } = due.length
        ? await db.rpc("confirm_continuous_and_advance",{
            _battle_id:battle.id,_character_id:characterId,
            _mana_regeneration_settings:manaRegenerationSettingsForTurn,
            _choices:decisions??{},
          })
        : await supabase.rpc("advance_combat_turn", {
            _battle_id: battle.id,
            _character_id: characterId,
            _mana_regeneration_settings: manaRegenerationSettingsForTurn as unknown as Json,
          });
      if (error) {
        toast.error("Não foi possível avançar o turno: " + error.message);
        return;
      }
      setPendingContinuousTurn(null);
      void qc.invalidateQueries({queryKey:["battle-continuous-instances",battle.id]});
      void dispatchCustomAbilityScriptEvents(battle.id).then(() => {
        scheduleCombatRefresh(qc, ["battle-effects"], ["character-active-effects"], ["character-abilities"]);
      });

      const confirmedTurn = Number(nextTurn);
      // Cooldowns are part of character_abilities, not the battle snapshot. Refresh them
      // immediately after the server confirms the turn instead of waiting for the
      // coalesced Realtime batch below.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["character-abilities"] }),
        qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
        qc.invalidateQueries({ queryKey: ["battle-character-transformations"] }),
        qc.invalidateQueries({ queryKey: ["character-transformations"] }),
      ]);

      if (Number.isFinite(confirmedTurn)) {
        // Stop an older Realtime-triggered read from overwriting this newly confirmed counter.
        await qc.cancelQueries({ queryKey: ["battles"] });
        qc.setQueryData<BattlesData>(["battles", userId, isMaster], (current) => {
          if (!current) return current;
          return current.map((cachedBattle) => {
            if (cachedBattle.id !== battle.id) return cachedBattle;
            if (characterId === null) {
              return {
                ...cachedBattle,
                turn_count: Math.max(Number(cachedBattle.turn_count ?? 0), confirmedTurn),
              };
            }
            return {
              ...cachedBattle,
              battle_participants: cachedBattle.battle_participants.map((participant) => {
                const participantCharacterId = (participant.characters as { id?: string } | null)?.id;
                if (participantCharacterId !== characterId) return participant;
                return {
                  ...participant,
                  turn_count: Math.max(Number(participant.turn_count ?? 0), confirmedTurn),
                };
              }),
            };
          });
        });
      }

      if (characterId) {
        const fighter = turnFighters[0];
        toast.success("Turno individual de " + fighter.name + " avançado para " + nextTurn + ".");
        noteActivity("turn", "Turno individual de " + fighter.name + " avançado para " + nextTurn + ".");
      } else {
        toast.success("Turno " + nextTurn + " avançado.");
        noteActivity("turn", "Turno geral avançado para " + nextTurn + ".");
      }

      // Share a debounced batch with Realtime. The local counter is instant; this background
      // refresh reconciles effects, Mana, cooldowns, and any concurrent changes from other users.
      scheduleCombatRefresh(
        qc,
        ["battles"],
        ["battle-effects"],
        ["character-active-effects"],
        ["character-abilities-battle"],
        ["character-abilities"],
        ["battle-character-public-states"],
        ["battle-character-transformations"],
      );
    } finally {
      setAdvancingTurnKeys((current) => {
        const next = new Set(current);
        next.delete(turnKey);
        return next;
      });
    }
  }

  async function addEffect(characterId: string, effect: Omit<BattleEffect, "id" | "battle_id" | "character_id">) {
    const raw = effect.effect_data && typeof effect.effect_data === "object" && !Array.isArray(effect.effect_data)
      ? effect.effect_data as Record<string, unknown> : {};
    const modifiers = effect.effect_type === "status" ? parseAttributeStatusModifiers(raw.attribute_modifiers) : [];
    const clean = { ...raw }; delete clean.attribute_modifiers;
    const rows = modifiers.length ? modifiers.map((modifier) => ({
      ...effect,
      name: effect.name + " · " + (defs.find((def) => def.key === modifier.attribute_key)?.label ?? modifier.attribute_key),
      attribute_key: modifier.attribute_key,
      value_mode: modifier.value_mode,
      amount: modifier.amount,
      effect_data: clean,
      battle_id: battle.id,
      character_id: characterId,
    })) : [{ ...effect, battle_id: battle.id, character_id: characterId }];
    const { error } = await supabase.from("battle_effects").insert(rows);
    if (error) { toast.error(error.message); return; }
    toast.success("Efeito aplicado: " + effect.name);
    noteActivity("effect", "Efeito " + effect.name + " aplicado a " + (fighters.find((fighter) => fighter.id === characterId)?.name ?? "personagem") + ".");
    await qc.invalidateQueries({ queryKey: ["battle-effects", battle.id] });
    await qc.invalidateQueries({ queryKey: ["character-active-effects"] });
  }

  const update = async (patch: { current_character_id?: string | null; target_character_id?: string | null; active?: boolean; name?: string }) => {
    const { error } = await supabase.from("battles").update(patch).eq("id", battle.id);
    if (error) {
      toast.error(error.message);
      return;
    }

    await qc.invalidateQueries({ queryKey: ["battles"] });
    if (patch.active === false) {
      // The database clears Demônio Interno's per-character state when combat ends.
      // Refresh cached ability state so the finished battle no longer displays old heat.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["character-abilities"] }),
        qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
        qc.invalidateQueries({ queryKey: ["battle-character-public-states"] }),
      ]);
      toast.success("Batalha encerrada; superaquecimento do Demônio Interno reiniciado.");
    }
  };


  function setManaRegen(fighter: Fighter, patch: Partial<{ mode: "percent" | "fixed"; amount: string }>) {
    setManaRegenSettings((current) => ({
      ...current,
      [fighter.id]: {
        mode: current[fighter.id]?.mode ?? fighter.mana_regen_mode ?? "fixed",
        amount: current[fighter.id]?.amount ?? String(fighter.mana_regen_amount ?? 40),
        ...patch,
      },
    }));
  }

  async function saveManaRegen(fighter: Fighter, enabled: boolean, settings?: {mode: "percent" | "fixed"; amount: string}) {
    if (!isMaster || !battle.active || savingManaRegen.has(fighter.id)) return;
    const amount = settings ? Number(settings.amount) : Number(fighter.mana_regen_amount ?? 40);
    const mode = settings?.mode ?? fighter.mana_regen_mode ?? "fixed";
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000000 || settings?.amount.trim() === "") {
      toast.error("Informe um valor de regeneração entre 0 e 1.000.000.");
      return;
    }
    setSavingManaRegen((current) => new Set(current).add(fighter.id));
    try {
      const { error } = await db.rpc("configure_battle_mana_regeneration", {
        _battle_id: battle.id,
        _character_id: fighter.id,
        _enabled: enabled,
        _mode: mode,
        _amount: amount,
      });
      if (error) throw error;
      if (settings) {
        setManaRegenSettings((current) => {
          const next = { ...current };
          delete next[fighter.id];
          return next;
        });
        toast.success("Regeneração de Mana de " + fighter.name + " salva.");
      } else {
        toast.success("Regeneração por turno " + (enabled ? "ativada" : "desativada") + " para " + fighter.name + ".");
      }
      await qc.invalidateQueries({ queryKey: ["battles"] });
    } catch (error) {
      toast.error("Não foi possível configurar a regeneração: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setSavingManaRegen((current) => {
        const next = new Set(current);
        next.delete(fighter.id);
        return next;
      });
    }
  }

  // Apply only the configured per-turn Mana regeneration; no turn counter,
  // cooldown, DoT, duration, or other turn-bound mechanics are processed.
  async function regenerateManaOnly(fighter: Fighter) {
    if (!isMaster || !battle.active || !fighter.mana_regen_enabled ||
        savingManaRegen.has(fighter.id) || advancingTurnKeys.size > 0 ||
        regeneratingManaInFlight.current.has(fighter.id)) return;

    if (blocked(fighter.id, "no_regen_mana") || blocked(fighter.id, "no_mana")) {
      toast.error("A regeneração de Mana está bloqueada por um efeito ativo.");
      return;
    }

    const manaAttribute = fighter.character_attributes.find((attr) => attr.attribute_key === "mana");
    if (!manaAttribute) {
      toast.error("Este personagem não possui o atributo Mana.");
      return;
    }

    const configuredAmount = Number(fighter.mana_regen_amount ?? 40);
    if (!Number.isFinite(configuredAmount) || configuredAmount < 0) {
      toast.error("A configuração de regeneração de Mana é inválida.");
      return;
    }

    const maxMana = Math.max(0, val(fighter, "mana"));
    const currentMana = Number(manaAttribute.current_value ?? 0);
    if (currentMana >= maxMana) {
      toast.info(fighter.name + " já está com a Mana máxima.");
      return;
    }

    // Use the saved setting and the same buff/debuff and passive modifiers as
    // the turn regeneration. Percentage bases are rounded up before modifiers.
    const baseRegen = fighter.mana_regen_mode === "percent"
      ? Math.ceil(maxMana * configuredAmount / 100)
      : Math.floor(configuredAmount);
    const adjustedRegen = regenValue(fighter.id, "mana", baseRegen);
    const nextMana = Math.min(maxMana, Math.max(0, currentMana + adjustedRegen));
    if (nextMana <= currentMana) {
      toast.info("Nenhuma Mana será regenerada com a configuração e os efeitos atuais.");
      return;
    }

    regeneratingManaInFlight.current.add(fighter.id);
    setRegeneratingManaIds((current) => new Set(current).add(fighter.id));
    try {
      // Compare the previously observed Mana to avoid overwriting a newer
      // resource change from another master, ability, or turn advancement.
      const { data, error } = await supabase.from("character_attributes")
        .update({ current_value: nextMana, updated_at: new Date().toISOString() })
        .eq("character_id", fighter.id)
        .eq("attribute_key", "mana")
        .eq("current_value", currentMana)
        .select("current_value");
      if (error) throw error;
      if (!data?.length) {
        toast.error("A Mana foi alterada por outra ação. Valores atualizados; tente novamente.");
        return;
      }

      const gained = Number(data[0].current_value) - currentMana;
      toast.success(fighter.name + " regenerou " + gained + " de Mana, sem avançar o turno.");
      noteActivity("effect", fighter.name + " regenerou " + gained + " de Mana (sem avançar turno).");
    } catch (error) {
      toast.error("Não foi possível regenerar a Mana: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      await qc.invalidateQueries({ queryKey: ["battles"] });
      scheduleCombatRefresh(qc, ["battle-character-public-states"], ["character", fighter.id]);
      regeneratingManaInFlight.current.delete(fighter.id);
      setRegeneratingManaIds((current) => {
        const next = new Set(current);
        next.delete(fighter.id);
        return next;
      });
    }
  }

  const actor = fighters.find((f) => f.id === battle.current_character_id);
  const targets = fighters.filter((f) => selectedTargetIds.includes(f.id) && f.id !== actor?.id);

  // Reset also when another connected master changes the turn; never reuse the prior attacker's targets.
  useEffect(() => {
    setSelectedTargetIds([]);
  }, [battle.current_character_id]);

  function changeCurrentActor(characterId: string | null) {
    if (characterId === battle.current_character_id) return;
    setSelectedTargetIds([]);
    void update({ current_character_id: characterId, target_character_id: null });
  }

  function toggleTarget(id: string) {
    if (!actor || actor.id === id) return;
    const next = selectedTargetIds.includes(id)
      ? selectedTargetIds.filter((selectedId) => selectedId !== id)
      : [...selectedTargetIds, id];
    setSelectedTargetIds(next);
    void update({ target_character_id: next[0] ?? null });
  }

  const visibleFighters = fighters.filter((fighter) => {
    const nameMatch = (fighter.name + " " + (fighter.player_name ?? "")).toLocaleLowerCase("pt-BR")
      .includes(fighterSearch.trim().toLocaleLowerCase("pt-BR"));
    if (!nameMatch) return false;
    if (fighterFilter === "targets") return selectedTargetIds.includes(fighter.id);
    if (fighterFilter === "effects") return effects.some((effect) => effect.character_id === fighter.id);
    if (fighterFilter === "critical") {
      if (!isMaster && fighter.owner_id !== userId) return false;
      const hp = fighter.character_attributes.find((attr) => attr.attribute_key === "hp")?.current_value ?? 0;
      return hp / Math.max(1, val(fighter, "hp")) <= 0.25;
    }
    return true;
  });
  const visibleToUser = fighters.filter((fighter) => isMaster || fighter.owner_id === userId);
  const criticalFighters = visibleToUser.filter((fighter) => {
    const hp = fighter.character_attributes.find((attr) => attr.attribute_key === "hp")?.current_value ?? 0;
    return hp / Math.max(1, val(fighter, "hp")) <= 0.25;
  });
  const dotEffects = effects.filter((effect) => effect.effect_type === "damage_over_time");
  const mindControlEffects = effects.filter((effect) => effect.effect_type === "mind_control");

  if (!defs) return null;
  return (
    <div className="grimorio-combat relative space-y-4 pb-28 md:pb-8">
      {previewPortrait && (
        <CombatPortraitViewer
          key={previewPortrait.path ?? previewPortrait.name}
          portrait={previewPortrait}
          onClose={() => setPreviewPortrait(null)}
        />
      )}
      <header className="grimorio-combat-hero panel relative space-y-3 overflow-hidden border-gold/45 p-3 shadow-lg sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.19em] text-muted-foreground"><span className={cn("h-2 w-2 rounded-full", battle.active ? "bg-emerald-400 shadow-[0_0_9px_rgba(52,211,153,.75)]" : "bg-zinc-500")} /> Combate {battle.active ? "em andamento" : "encerrado"}</p>
            <div className="flex items-center gap-2"><Crown className="h-5 w-5 shrink-0 text-gold/80" /><h2 className="truncate font-display text-2xl text-gold sm:text-3xl">{battle.name}</h2></div>
            <p className="text-xs text-muted-foreground">Turno <strong className="text-foreground">{battle.turn_count ?? 0}</strong><span className="mx-1.5 text-gold/50">·</span>{fighters.length} combatentes{actor ? <> <span className="mx-1.5 text-gold/50">·</span> Vez de <strong className="text-gold">{actor.name}</strong></> : ""}</p>
          </div>
          <div className="flex items-center gap-2">
            {isMaster && <Button size="sm" variant="outline" onClick={() => { setCombatTab("summary"); setBattleAdminOpen(true); }} aria-label="Gerenciar batalha no resumo"><Settings2 className="mr-1 h-4 w-4" /> Gerenciar</Button>}
            {isMaster && <Button size="sm" disabled={!battle.active || advancingTurnKeys.has("__global__")} onClick={() => void advanceCombatTurn(null)}>
              <RotateCw className="mr-1 h-4 w-4" /> {advancingTurnKeys.has("__global__") ? "Avançando..." : "Turno geral"}
            </Button>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          <span className="rounded-full border border-gold/25 bg-[#100d0b] px-2.5 py-1">{effects.length} efeito(s) visíveis</span>
          <span className="rounded-full border border-gold/25 bg-[#100d0b] px-2.5 py-1">{dotEffects.length} DoT(s)</span>
          {mindControlEffects.length > 0 && <span className="rounded-full border border-violet-500/50 px-2 py-1 text-violet-400">{mindControlEffects.length} controlado(s)</span>}
        </div>
      </header>
      {isMaster && continuousInstances.length > 0 && <details className="panel border-gold/30 p-3 sm:p-4">
        <summary className="min-h-10 cursor-pointer font-display text-sm font-semibold text-gold">
          <Repeat2 className="mr-2 inline h-4 w-4"/> Vínculos e efeitos contínuos ativos ({continuousInstances.length})
        </summary>
        <p className="mb-3 mt-2 text-xs text-muted-foreground">Interrompa uma mordida, agarrão ou canalização. As penalidades residuais permanecerão pelo tempo configurado.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {continuousInstances.map(instance=>(
            <div key={instance.id} className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-gold/20 bg-background/50 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{instance.name}</p>
                <p className="text-xs text-muted-foreground">{fighters.find(f=>f.id===instance.caster_character_id)?.name??"Origem"} → {fighters.find(f=>f.id===instance.target_character_id)?.name??"Alvo"} · {instance.rule.actions.length ? `${instance.ticks} acúmulo(s)` : `${instance.ticks} turno(s) de vínculo (sem efeitos)`}</p>
              </div>
              <div className="flex shrink-0 flex-col gap-1.5 sm:flex-row">
                {(["interrupt","dispel"] as const).map(mode=>(
                  <Button key={mode} size="sm" variant="outline"
                    className={mode==="dispel"?"min-h-10 border-red-500/40 text-red-300":"min-h-10 border-amber-500/35 text-amber-300"}
                    disabled={stoppingContinuous!==null}
                    onClick={()=>{void (async()=>{
                      if(mode==="dispel" && !window.confirm("Dissipar completamente "+instance.name+"? Isso também remove penalidades e DoTs vinculados."))return;
                      setStoppingContinuous(instance.id);
                      const {error}=await db.rpc("control_continuous_effect",{_id:instance.id,_mode:mode});
                      setStoppingContinuous(null);
                      if(error){toast.error("Não foi possível "+(mode==="dispel"?"dissipar":"interromper")+": "+error.message);return;}
                      toast.success(mode==="dispel"?"Vínculo dissipado e penalidades removidas.":"Vínculo interrompido; resíduos preservados.");
                      await Promise.all([
                        qc.invalidateQueries({queryKey:["battle-continuous-instances",battle.id]}),
                        qc.invalidateQueries({queryKey:["battle-effects"]}),
                        qc.invalidateQueries({queryKey:["character-active-effects"]}),
                      ]);
                    })();}}>
                    {stoppingContinuous===instance.id?"Processando...":mode==="dispel"?"Dissipar":"Soltar"}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </details>}
      {isMaster && pendingContinuousTurn && <ContinuousTurnDialog
        key={pendingContinuousTurn.characterId??"global"}
        items={pendingContinuousTurn.items}
        title={pendingContinuousTurn.title}
        fighterNames={Object.fromEntries(fighters.map(f=>[f.id,f.name]))}
        casterAttributes={Object.fromEntries(fighters.map(f=>[
          f.id,Object.fromEntries((defs??[]).map(def=>[def.key,val(f,def.key)])),
        ]))}
        damageTypes={transformationDamageTypes}
        busy={advancingTurnKeys.has(pendingContinuousTurn.characterId??"__global__")}
        onCancel={()=>setPendingContinuousTurn(null)}
        onConfirm={(choices)=>{void advanceCombatTurn(pendingContinuousTurn.characterId,choices);}}
      />}
      <AlertDialog
        open={pendingEndTransformation !== null}
        onOpenChange={(open) => {
          if (!open && !endingTransformationFor) setPendingEndTransformation(null);
        }}
      >
        <AlertDialogContent className="w-[calc(100%-2rem)] max-w-md gap-5 overflow-hidden rounded-2xl border border-gold/45 bg-[#140e0b] p-5 text-foreground shadow-[0_24px_90px_rgba(0,0,0,.85)] sm:p-6">
          <AlertDialogHeader className="items-center space-y-3 text-center sm:text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-gold/35 bg-gold/10 shadow-[0_0_28px_rgba(231,183,93,.12)]">
              <Sparkles className="h-7 w-7 text-gold" aria-hidden="true" />
            </div>
            <AlertDialogTitle className="font-display text-xl font-bold text-gold sm:text-2xl">
              Encerrar transformação?
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2 text-center text-sm leading-relaxed text-muted-foreground">
              <span className="block">
                <span className="font-semibold text-foreground">{pendingEndTransformation?.characterName}</span>
                {" deixará a forma "}
                <span className="font-semibold text-gold">{pendingEndTransformation?.transformationName}</span>.
              </span>
              <span className="block">
                Os bônus e efeitos ativos dessa transformação serão retirados. Os efeitos de encerramento configurados serão aplicados.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-xl border border-gold/20 bg-gold/5 px-3 py-2.5 text-center text-xs text-muted-foreground">
            <Hourglass className="mr-1 inline h-3.5 w-3.5 text-gold" aria-hidden="true" />
            A recarga continua normalmente após destransformar.
          </div>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row sm:gap-3">
            <AlertDialogCancel
              disabled={endingTransformationFor !== null}
              className="mt-0 min-h-11 flex-1 border-gold/25 bg-transparent text-foreground hover:bg-gold/10 hover:text-gold"
            >
              Manter transformação
            </AlertDialogCancel>
            <Button
              type="button"
              className="min-h-11 flex-1 bg-gold font-semibold text-[#160f0b] hover:bg-gold/85"
              disabled={endingTransformationFor !== null}
              onClick={() => void endTransformation()}
            >
              <Sparkles className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {endingTransformationFor ? "Destransformando..." : "Destransformar"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <CombatNavigation active={combatTab} onSelect={setCombatTab} />
      <div className={cn("gap-4", (combatTab === "fighters" || combatTab === "actions") && "xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:items-start")}>
      {(combatTab === "fighters" || combatTab === "actions") && <section className={cn("min-w-0 space-y-3", combatTab !== "fighters" && "hidden xl:block")} aria-label="Combatentes da batalha">
        <div className="panel flex flex-col gap-3 border-gold/25 p-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Buscar combatente" placeholder="Buscar personagem ou jogador..." value={fighterSearch} onChange={(event) => setFighterSearch(event.target.value)} className="pl-9" />
          </div>
          <select aria-label="Filtrar combatentes" className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={fighterFilter} onChange={(event) => setFighterFilter(event.target.value as typeof fighterFilter)}>
            <option value="all">Todos</option>
            <option value="targets">Alvos marcados</option>
            <option value="effects">Com efeitos visíveis</option>
            <option value="critical">HP crítico (até 25%)</option>
          </select>
          {isMaster && <Button size="sm" className="min-h-10" onClick={() => setCombatTab("actions")}><Zap className="mr-1 h-4 w-4" /> Ações rápidas</Button>}
        </div>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-2">
        {visibleFighters.map((f) => {
          const isActor = f.id === actor?.id;
          const isTarget = selectedTargetIds.includes(f.id) && f.id !== actor?.id;
          const isOwnFighter = isMaster || f.owner_id === userId;
          const isExpanded = expandedFighterIds.has(f.id);
          const fighterEffects = effects.filter((effect) => effect.character_id === f.id);
          const fighterDots = fighterEffects.filter((effect) => effect.effect_type === "damage_over_time").length;
          // Count the same passive ability effects listed under Efeitos ativos.
          // These are display-only and are NOT added to the battle damage pipeline.
          const { buffs: fighterBuffs, debuffs: fighterDebuffs } =
            combatEffectBadgeCounts(fighterEffects, passiveEffectsForDisplay(abilitiesOf(f.id)));
          const fighterSpecial = fighterEffects.filter((effect) => ["stun", "invincible", "magic_prohibition", "no_mana", "mind_control", "invisibility"].includes(effect.effect_type));
          const hp = f.character_attributes.find((a) => a.attribute_key === "hp");
          const mana = f.character_attributes.find((a) => a.attribute_key === "mana");
          const hpMaximum = isOwnFighter ? val(f, "hp") : 0;
          const manaMaximum = isOwnFighter ? val(f, "mana") : 0;
          const hpCurrent = isOwnFighter ? hp?.current_value ?? 0 : 0;
          const manaCurrent = isOwnFighter ? mana?.current_value ?? 0 : 0;
          const publicState = publicStateByCharacter.get(f.id);
          const characterTransformStates = transformStateFor(f.id);
          const activeTransformationState = characterTransformStates.find((state) => state.active);
          const activeTransformation = activeTransformationState
            ? transformationCatalog.find((transformation) => transformation.id === activeTransformationState.transformation_id)
            : undefined;
          const activeTransformationRemaining = activeTransformationState?.active_duration_remaining
            ?? activeTransformation?.duration_turns
            ?? 0;
          const transformationImage = activeTransformationState?.image_path || f.photo_path;
          const availableTransformations = availableTransformationsFor(f);
          return (
            <article key={f.id} className={cn(
              "grimorio-fighter-card panel group min-w-0 space-y-3 border-gold/25 p-3 transition-colors",
              isActor && "!border-gold ring-1 ring-gold/75 shadow-[0_0_0_1px_rgba(231,183,93,.20),0_12px_30px_rgba(0,0,0,.35)]",
              isTarget && "!border-blood ring-1 ring-blood shadow-[0_0_22px_rgba(188,57,67,.13)]",
            )}>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label={`Ampliar imagem de ${f.name}`}
                  aria-haspopup="dialog"
                  title={`Ver imagem de ${f.name} em tamanho maior`}
                  onClick={() => setPreviewPortrait({ name: f.name, path: transformationImage })}
                  className="shrink-0 cursor-zoom-in rounded-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <Portrait path={transformationImage} name={f.name} className="h-12 w-11 rounded-lg border border-gold/40 shadow-[0_0_0_2px_rgba(231,183,93,.06)]" />
                </button>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="truncate font-display text-base font-semibold text-gold">{f.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{f.player_name || "NPC"}</div>
                  {isActor && <div className="flex items-center gap-1 text-[11px] font-semibold text-gold"><Swords className="h-3 w-3" /> Na vez · primeiro da lista</div>}
                  {isTarget && <div className="flex items-center gap-1 text-[11px] font-semibold text-red-400"><Crosshair className="h-3 w-3" /> Alvo selecionado</div>}
                </div>
              </div>

              {isOwnFighter
                ? <Bar label="HP" cur={hpCurrent} max={hpMaximum} tone="bg-blood" />
                : <HiddenResourceState label="HP" value={publicState?.hp_state ?? "Carregando..."} />}
              {isOwnFighter
                ? <Bar label="Mana" cur={manaCurrent} max={manaMaximum} tone="bg-arcane" />
                : <HiddenResourceState label="Mana" value={publicState?.mana_state ?? "Carregando..."} />}

              {activeTransformationState && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-emerald-500">Transformado: {activeTransformation?.name ?? "Transformação ativa"}</div>
                    <div className="text-[11px] text-muted-foreground">Termina em {activeTransformationRemaining} turno(s)</div>
                  </div>
                  {isOwnFighter && <Button
                    size="sm" variant="outline" className="min-h-9 border-emerald-500/40 text-emerald-300"
                    disabled={!battle.active || !!activatingTransformationFor || !!endingTransformationFor}
                    onClick={() => requestEndTransformation(f.id, activeTransformationState.transformation_id)}
                  >
                    {endingTransformationFor===f.id ? "Encerrando..." : "Destransformar"}
                  </Button>}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                {isOwnFighter && <span className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-emerald-300">Buffs {fighterBuffs}</span>}
                {isOwnFighter && <span className="rounded-md border border-red-500/20 bg-red-500/10 px-2 py-1 text-red-300">Debuffs {fighterDebuffs}</span>}
                {isOwnFighter && fighterDots > 0 && <span className="rounded-md bg-orange-500/10 px-2 py-1 text-orange-400">DoTs {fighterDots}</span>}
                {fighterSpecial.map((effect) => <span key={effect.id} className="rounded-md border border-border px-2 py-1 text-muted-foreground">
                  {effect.effect_type === "invincible" ? "Invencível" : effect.effect_type === "magic_prohibition" ? "Sem magia" : effect.effect_type === "no_mana" ? "Sem mana" : effect.effect_type === "mind_control" ? "Controle mental" : effect.effect_type === "invisibility" ? "Invisível" : "Stun"}
                </span>)}
              </div>
              {isMaster && florinPetals.filter((state) => state.character_id === f.id).map((state) => (
                <FlorinPetalsControl key={state.ability_id}
                  state={state} battleId={battle.id} active={battle.active} />
              ))}
              {isMaster && (
                <label className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors",
                  f.mana_regen_enabled ? "border-purple-400/45 bg-purple-500/10" : "border-border bg-background/40",
                  (!battle.active || savingManaRegen.has(f.id)) && "cursor-not-allowed opacity-60",
                )}>
                  <input
                    type="checkbox"
                    aria-label={`Regenerar Mana por Turno de ${f.name}`}
                    className="h-4 w-4 shrink-0 accent-[#e8b95a]"
                    checked={!!f.mana_regen_enabled}
                    disabled={!battle.active || savingManaRegen.has(f.id)}
                    onChange={(event) => void saveManaRegen(f, event.target.checked)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-foreground">Regenerar Mana por Turno</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {savingManaRegen.has(f.id) ? "Salvando..." : (
                        (f.mana_regen_enabled ? "Ativo" : "Desligado") + " · +" + Number(f.mana_regen_amount ?? 40) +
                        (f.mana_regen_mode === "percent" ? "% da Mana máxima" : " Mana fixa") + " por turno"
                      )}
                    </span>
                  </span>
                  <Droplets aria-hidden="true" className={cn("h-4 w-4 shrink-0", f.mana_regen_enabled ? "text-purple-300" : "text-muted-foreground")} />
                </label>
              )}
              {isMaster && (
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-9 w-full border-purple-400/35 text-purple-200 hover:bg-purple-500/10"
                  aria-label={`Regenerar apenas a Mana de ${f.name} sem avançar o turno`}
                  title={f.mana_regen_enabled
                    ? "Aplica somente a regeneração de Mana configurada, sem avançar turnos ou efeitos."
                    : "Ative Regenerar Mana por Turno para usar este botão."}
                  disabled={!battle.active || !f.mana_regen_enabled || savingManaRegen.has(f.id) ||
                    regeneratingManaIds.has(f.id) || advancingTurnKeys.size > 0}
                  onClick={() => void regenerateManaOnly(f)}
                >
                  <Droplets className="mr-2 h-4 w-4" />
                  {regeneratingManaIds.has(f.id) ? "Regenerando Mana..." : "Regenerar Mana agora (sem avançar turno)"}
                </Button>
              )}
              <Sheet open={isExpanded} onOpenChange={(open) => setExpandedFighterIds((current) => {
                const next = new Set(current);
                if (open) next.add(f.id); else next.delete(f.id);
                return next;
              })}>
                <SheetContent side="bottom" className="h-[93dvh] max-h-[93dvh] rounded-t-2xl border-gold/45 bg-[#100c0a] px-4 pb-3 pt-6 shadow-[0_-15px_60px_rgba(0,0,0,.8)] sm:mx-auto sm:max-w-5xl sm:px-6">
                  <SheetHeader className="pr-8 text-left">
                    <SheetTitle className="font-display text-xl text-gold">{f.name}</SheetTitle>
                    <SheetDescription>{f.player_name || "NPC"} · Atributos, habilidades, efeitos, transformações e recursos</SheetDescription>
                  </SheetHeader>
                  <div role="tablist" aria-label={"Detalhes de " + f.name} className="mt-4 flex gap-1.5 overflow-x-auto border-b border-gold/25 pb-2">
                    {([
                      ["status", "Status"],
                      ["abilities", "Habilidades"],
                      ...((isMaster || isOwnFighter) ? [["summons", "Invocações"], ["inventory", "Inventário"]] : []),
                      ["transformations", "Transformações"],
                      ...(isMaster ? [["effects", "Recursos e efeitos"]] : []),
                      ["activeEffects", "Efeitos ativos"],
                    ] as Array<["status" | "abilities" | "summons" | "transformations" | "effects" | "activeEffects" | "inventory", string]>).map(([key, label]) =>
                      <button key={key} type="button" role="tab" aria-selected={detailTab === key}
                        onClick={() => setDetailTab(key)}
                        className={cn("shrink-0 rounded-lg border border-transparent px-3 py-2.5 text-xs font-semibold transition-colors", detailTab === key ? "border-gold/35 bg-gold/15 text-gold" : "text-muted-foreground hover:border-gold/15 hover:bg-gold/5 hover:text-foreground")}>{label}</button>)}
                  </div>
                  <div className="mt-2 h-[calc(93dvh-11rem)] space-y-4 overflow-y-auto overscroll-contain pb-10 pr-1">
              {detailTab === "transformations" && (isOwnFighter || isMaster) && availableTransformations.length > 0 && (
                <div className="space-y-2 rounded-md border border-border p-2">
                  <div className="text-xs font-semibold text-gold">Transformações</div>
                  <div className="space-y-2">
                    {availableTransformations.map((transformation) => {
                      const state = characterTransformStates.find((item) => item.transformation_id === transformation.id);
                      const isActive = state?.active === true;
                      const isCoolingDown = (state?.cooldown_remaining ?? 0) > 0;
                      const anotherActive = !!activeTransformationState && !isActive;
                      const disabled = !battle.active || activatingTransformationFor === f.id || !!activatingTransformationFor || isActive || isCoolingDown || anotherActive;
                      const detailKey = `${f.id}:${transformation.id}`;
                      const detailsOpen = expandedTransformationDetailsIds.has(detailKey);
                      const rawModifiers = transformation.modifiers;
                      const modifierEntries = rawModifiers && typeof rawModifiers === "object" && !Array.isArray(rawModifiers)
                        ? Object.entries(rawModifiers as Record<string, unknown>).map(([key, value]) => [key, Number(value)] as const).filter(([, value]) => Number.isFinite(value) && value !== 0)
                        : [];
                      const activationEffects = parseAbilityEffects(transformation.effects);
                      const endingEffects = parseAbilityEffects(transformation.end_effects);
                      const grantedAbilities = transformationAbilityGrants.filter((grant) => grant.transformation_id === transformation.id);
                      return (
                        <div key={transformation.id} className="space-y-2 rounded border border-border/70 p-2">
                          <div className="flex flex-wrap items-center gap-2">
                            {isOwnFighter && !isActive && <Button
                              size="sm"
                              variant="outline"
                              disabled={disabled || !!endingTransformationFor}
                              onClick={() => void activateTransformation(f.id, transformation.id)}
                            >
                              <Sparkles className="mr-1 h-3.5 w-3.5" />
                              {isCoolingDown ? `${transformation.name} · ${state?.cooldown_remaining}T` : activatingTransformationFor === f.id ? "Ativando…" : transformation.name}
                            </Button>}
                            {isOwnFighter && isActive && <Button
                              size="sm" variant="outline"
                              className="min-h-11 border-emerald-500/40 text-emerald-300"
                              disabled={!battle.active || !!activatingTransformationFor || !!endingTransformationFor}
                              onClick={() => requestEndTransformation(f.id, transformation.id)}
                            >
                              {endingTransformationFor===f.id ? "Encerrando..." : "Destransformar"}
                            </Button>}
                            {isMaster && <Button
                              size="sm" variant="outline" className="min-h-11 border-gold/40 text-gold"
                              disabled={disabled}
                              onClick={() => setAdvancedTransformation({ characterId: f.id, characterName: f.name, template: transformation })}
                            >
                              <Settings2 className="mr-1.5 h-4 w-4" /> Opções avançadas
                            </Button>}
                            <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setExpandedTransformationDetailsIds((current) => {
                              const next = new Set(current);
                              if (next.has(detailKey)) next.delete(detailKey); else next.add(detailKey);
                              return next;
                            })}>
                              {detailsOpen ? <ChevronUp className="mr-1 h-3.5 w-3.5" /> : <ChevronDown className="mr-1 h-3.5 w-3.5" />}
                              {detailsOpen ? "Ocultar detalhes" : "Ver mais detalhes"}
                            </Button>
                          </div>
                          {(transformation as typeof transformation & {source_inventory_item_id?:string|null}).source_inventory_item_id && <span className="rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-300">💎 Acessório: {battleInventoryOrigins.find(item => item.id === (transformation as typeof transformation & {source_inventory_item_id?:string|null}).source_inventory_item_id)?.item_templates?.name ?? "Equipamento"}</span>}
                          {detailsOpen && <div className="space-y-3 rounded bg-muted/30 p-3 text-xs">
                            <div className="space-y-1">
                              <div className="font-semibold text-gold">{transformation.name}</div>
                              <div className="text-muted-foreground">Duração: {transformation.duration_turns} turno(s) · Recarga: {transformation.cooldown_turns} turno(s) · Custo: {transformation.mana_cost > 0 ? `${transformation.mana_cost} Mana` : "sem custo de Mana"}</div>
                              {transformation.description && <p className="whitespace-pre-wrap text-muted-foreground">{transformation.description}</p>}
                            </div>
                            <div className="space-y-1.5">
                              <div className="font-semibold">Atributos e status concedidos</div>
                              {modifierEntries.length ? modifierEntries.map(([key, value]) => {
                                const label = key === "body" ? "Corpo" : key === "sanity" ? "Sanidade" : defs?.find((definition) => definition.key === key)?.label ?? key;
                                return <div key={key} className={value > 0 ? "text-emerald-500" : "text-destructive"}>{value > 0 ? "+" : ""}{value}{key === "body" || key === "sanity" ? "%" : ""} {label}</div>;
                              }) : <p className="text-muted-foreground">Nenhum modificador de atributo.</p>}
                            </div>
                            <div className="space-y-1.5">
                              <div className="font-semibold">Efeitos ao ativar</div>
                              {activationEffects.length ? activationEffects.map((effect, index) => <p key={index} className="text-muted-foreground">
                                {effectSummary(effect, defs ?? [], transformationDamageTypes, races ?? [])} · Em si mesmo{effect.modify_on_activate ? " · Modificar ao ativar" : ""}{effect.effect_type === "healing" && effect.healing_timing !== "per_turn" ? "" : " · durante a transformação"}
                              </p>) : <p className="text-muted-foreground">Nenhum efeito de ativação.</p>}
                            </div>
                            <div className="space-y-1.5">
                              <div className="font-semibold">Efeitos ao terminar</div>
                              {endingEffects.length ? endingEffects.map((effect, index) => <p key={index} className="text-muted-foreground">
                                {effectSummary(effect, defs ?? [], transformationDamageTypes, races ?? [])} · Em si mesmo{effect.effect_type === "healing" && effect.healing_timing !== "per_turn" ? "" : ` · ${effect.until_combat_end ? "até o fim do combate" : `${effect.duration} turno(s)`}`}
                              </p>) : <p className="text-muted-foreground">Nenhum efeito de encerramento.</p>}
                            </div>
                            <div className="space-y-1.5">
                              <div className="font-semibold">Habilidades concedidas</div>
                              {grantedAbilities.length ? grantedAbilities.map((grant) => {
                                const ability = transformationAbilityCatalog.find((item) => item.id === grant.ability_id);
                                return <p key={grant.ability_id} className="text-muted-foreground"><span className="font-medium text-foreground">{ability?.name ?? "Habilidade indisponível"}</span>{grant.only_while_transformed ? " · só enquanto transformado" : " · permanece concedida enquanto possuir a transformação"}</p>;
                              }) : <p className="text-muted-foreground">Nenhuma habilidade concedida.</p>}
                            </div>
                          </div>}
                        </div>
                      );
                    })}
                  </div>
                  {activeTransformationState && <p className="text-[11px] text-muted-foreground">A transformação é encerrada automaticamente aos 0 turnos, ou manualmente com Destransformar.</p>}
                </div>
              )}

              {detailTab === "transformations" && availableTransformations.length === 0 && <p className="rounded border border-border p-4 text-sm text-muted-foreground">Este personagem não possui transformações disponíveis.</p>}
              {isExpanded && (
                <>
                  {detailTab === "status" && <>
                  {isOwnFighter && defs.filter((d) => d.key !== "hp" && d.key !== "mana" && d.show_bar).map((d) => {
                    const attr = f.character_attributes.find((a) => a.attribute_key === d.key);
                    return <Bar key={d.key} label={d.label} cur={attr?.current_value ?? val(f, d.key)} max={val(f, d.key)} tone="bg-sky-500" />;
                  })}
                  </>}
                  {detailTab === "abilities" && <>
                  <CharacterAbilitiesPanel characterId={f.id} characterName={f.name} mode="combat"
                    canUse={isMaster && battle.active} showActiveEffects={isOwnFighter} battleId={battle.id}
                    individualTurn={f.participant_turn_count ?? 0}
                    targets={fighters.map((target) => ({ id: target.id, name: target.name }))}
                    stunnedTargetIds={effects.filter((effect) => effect.effect_type === "stun"
                      && Number(effect.duration) > 0).map((effect) => effect.character_id)}
                    getAttributeValue={(characterId, attributeKey) => {
                      const target = fighters.find((fighter) => fighter.id === characterId);
                      return target ? val(target, attributeKey) : 0;
                    }} />
                  </>}
                  {detailTab === "inventory" && (isMaster || isOwnFighter) && (
                    <InventoryPanel characterId={f.id} master={isMaster} combat />
                  )}
                  {detailTab === "summons" && (isMaster || isOwnFighter) && (
                    <SummonCombatPanel
                      characterId={f.id}
                      characterName={f.name}
                      battleId={battle.id}
                      master={isMaster && battle.active}
                      visible={isMaster || isOwnFighter}
                      showEmptyState
                    />
                  )}
                  {detailTab === "status" && <>
                  {isOwnFighter && <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded border border-border p-2"><span className="text-muted-foreground">Corpo</span><div className="font-semibold">{f.body}%</div></div>
                    <div className="rounded border border-border p-2"><span className="text-muted-foreground">Sanidade</span><div className="font-semibold">{f.sanity}%</div></div>
                  </div>}
                  {isOwnFighter && <div className="grid grid-cols-2 gap-2 text-xs">
                    {defs.filter((d) => !d.show_bar && !["hp", "mana"].includes(d.key)).map((d) => (
                      <div key={d.key} className="rounded border border-border p-2"><span className="text-muted-foreground">{d.label}</span><div className="font-semibold">{val(f, d.key)}</div></div>
                    ))}
                  </div>}
                  </>}
                  {detailTab === "activeEffects" && <ActiveCombatEffectsPanel
                    effects={effects.filter((e) => e.character_id === f.id)}
                    passiveEffects={passiveEffectsForDisplay(abilitiesOf(f.id))}
                    defs={defs}
                    getSource={(effect) => {
                    if (effect.source_race_id) return "Raça: " + (races?.find((r) => r.id === effect.source_race_id)?.name ?? "raça");
                    if (effect.source_class_id) return "Classe: " + (classes?.find((c) => c.id === effect.source_class_id)?.name ?? "classe");
                    if (effect.source_virtue_id) return "Virtude: " + (virtues?.find((v) => v.id === effect.source_virtue_id)?.name ?? "virtude");
                    if (effect.source_character_ability_id) {
                      const assignment = battleAbilities.find((ability) => ability.id === effect.source_character_ability_id) as (typeof battleAbilities[number] & {source_inventory_item_id?:string|null}) | undefined;
                      const item = battleInventoryOrigins.find(entry => entry.id === assignment?.source_inventory_item_id);
                      if(item) return "Acessório: " + (item.item_templates?.name ?? "equipamento");
                      return "Habilidade: " + (assignment?.name ?? "habilidade");
                    }
                    return effect.is_sheet_permanent ? "Ficha" : "Aplicação manual ou combate";
                  }} />}
                  {detailTab === "effects" && isMaster && <CombatResourceEditor fighter={f} battleId={battle.id} damageSources={fighters.map(({ id, name }) => ({ id, name }))} val={val} effects={effects.filter(e => e.character_id === f.id)} defs={defs} onAddEffect={(effect) => void addEffect(f.id, effect)} onRemoveEffect={async (id) => { const { data, error } = await supabase.rpc("remove_manual_character_effect", { _effect_id: id }); if (error) toast.error(error.message); else if (data !== true) toast.error("Este efeito não foi removido."); await qc.invalidateQueries({ queryKey: ["battle-effects", battle.id] }); await qc.invalidateQueries({ queryKey: ["character-active-effects"] }); await qc.invalidateQueries({ queryKey: ["battles"] }); }} hpRegenBlocked={blocked(f.id, "no_regen_hp")} manaRegenBlocked={blocked(f.id, "no_regen_mana") || blocked(f.id, "no_mana")} manaRegenMode={manaRegenSettings[f.id]?.mode ?? f.mana_regen_mode ?? "fixed"} manaRegenAmount={manaRegenSettings[f.id]?.amount ?? String(f.mana_regen_amount ?? 40)} manaRegenEnabled={!!f.mana_regen_enabled} manaRegenSaving={savingManaRegen.has(f.id)} onManaRegenModeChange={(mode) => setManaRegen(f, { mode })} onManaRegenAmountChange={(amount) => setManaRegen(f, { amount })} onManaRegenSave={() => void saveManaRegen(f, !!f.mana_regen_enabled, manaRegenSettings[f.id] ?? {mode:f.mana_regen_mode ?? "fixed",amount:String(f.mana_regen_amount ?? 40)})} />}
                  {detailTab === "status" && <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2">
                    <span className="text-xs text-muted-foreground">Turnos individuais: {f.participant_turn_count ?? 0}</span>
                    {isMaster && <Button size="sm" variant="outline" disabled={!battle.active || advancingTurnKeys.has("__global__") || advancingTurnKeys.has(f.id)} onClick={() => void advanceCombatTurn(f.id)}><RotateCw className="mr-1 h-3.5 w-3.5" /> {advancingTurnKeys.has(f.id) ? "Avançando..." : "Avançar turno"}</Button>}
                  </div>}
                </>
              )}

                  </div>
                </SheetContent>
              </Sheet>
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                {isMaster && (
                  <>
                    <Button size="sm" className="flex-1" variant={isActor ? "default" : "outline"} onClick={() => changeCurrentActor(f.id)}>
                      <Swords className="mr-1 h-3.5 w-3.5" /> Vez
                    </Button>
                    <Button size="sm" className="flex-1" variant={isTarget ? "destructive" : "outline"} disabled={isActor} onClick={() => toggleTarget(f.id)}>
                      <Crosshair className="mr-1 h-3.5 w-3.5" /> {isTarget ? "Remover alvo" : "Selecionar alvo"}
                    </Button>
                    <Button size="sm" variant="outline" className="min-h-9 flex-1 px-2" aria-label={`Avançar turno individual de ${f.name}`}
                      disabled={!battle.active || advancingTurnKeys.has("__global__") || advancingTurnKeys.has(f.id)}
                      onClick={() => void advanceCombatTurn(f.id)}>
                      <RotateCw className={cn("mr-1 h-3.5 w-3.5", advancingTurnKeys.has(f.id) && "animate-spin")} />
                      {advancingTurnKeys.has(f.id) ? "Avançando..." : "Avançar turno"}
                    </Button>
                  </>
                )}
                <Button size="sm" variant="ghost" className={isMaster ? "" : "ml-auto"} onClick={() => {
                  if (!isExpanded) setDetailTab("status");
                  setExpandedFighterIds((current) => {
                  const next = new Set(current);
                  if (next.has(f.id)) next.delete(f.id);
                  else next.add(f.id);
                  return next;
                  });
                }}>
                  {isExpanded ? <ChevronUp className="mr-1 h-3.5 w-3.5" /> : <ChevronDown className="mr-1 h-3.5 w-3.5" />}
                  {isExpanded ? "Fechar" : "Detalhes"}
                </Button>
              </div>
            </article>
          );
        })}
        </div>
        {visibleFighters.length === 0 && <p className="panel p-6 text-center text-sm text-muted-foreground">Nenhum combatente encontrado com esses filtros.</p>}
      </section>}
      {(combatTab === "fighters" || combatTab === "actions") && <section className={cn("min-w-0 space-y-4", combatTab !== "actions" && "hidden xl:block")} aria-label="Ações de combate">
        {isMaster ? <>
          <div className="panel space-y-3 border-gold/30 p-4">
            <div className="flex items-center gap-2"><span className="rounded-lg border border-gold/30 bg-gold/10 p-2"><Zap className="h-5 w-5 text-gold" /></span><div><p className="text-[10px] uppercase tracking-widest text-muted-foreground">Mesa do mestre</p><h3 className="font-display text-lg text-gold">Central de ações</h3></div></div>
            <div className="grid grid-cols-3 gap-2" role="group" aria-label="Tipo de ação">
              {([["combat", "Dano / testes"], ["abilities", "Habilidades"], ["dots", "DoTs"]] as const).map(([key, label]) => (
                <button key={key} type="button" onClick={() => setActionMode(key)}
                  aria-pressed={actionMode === key}
                  className={cn("min-h-11 rounded-md border px-1 py-2 text-xs font-semibold sm:text-sm",
                    actionMode === key ? "border-gold bg-gold/15 text-gold" : "border-border text-muted-foreground hover:bg-muted")}>{label}</button>
              ))}
            </div>
            <label className="block space-y-1 text-sm">
              <span className="text-muted-foreground">Quem está agindo?</span>
              <select className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={actor?.id ?? ""} onChange={(event) => changeCurrentActor(event.target.value || null)}>
                <option value="">Selecione um combatente</option>
                {fighters.map((fighter) => <option key={fighter.id} value={fighter.id}>{fighter.name}</option>)}
              </select>
            </label>
            <div>
              <p className="mb-2 text-sm text-muted-foreground">Alvos do ataque ({targets.length})</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                {fighters.filter((fighter) => fighter.id !== actor?.id).map((fighter) => (
                  <button key={fighter.id} type="button" disabled={!actor} aria-pressed={selectedTargetIds.includes(fighter.id)}
                    onClick={() => toggleTarget(fighter.id)}
                    className={cn("min-h-11 truncate rounded-md border p-2 text-left text-sm transition-colors disabled:opacity-50",
                      selectedTargetIds.includes(fighter.id) ? "border-blood bg-blood/10 text-foreground" : "border-border hover:border-gold/50")}>
                    <Crosshair className="mr-1 inline h-3.5 w-3.5" /> {fighter.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {actionMode === "abilities" && actor && <div className="panel space-y-3 p-4">
              <h3 className="font-display text-lg text-gold">Habilidades de {actor.name}</h3>
              <CharacterAbilitiesPanel characterId={actor.id} characterName={actor.name} mode="combat"
                canUse={battle.active} showActiveEffects battleId={battle.id}
                individualTurn={actor.participant_turn_count ?? 0}
                targets={fighters.map((fighter) => ({ id: fighter.id, name: fighter.name }))}
                stunnedTargetIds={effects.filter((effect) => effect.effect_type === "stun" && Number(effect.duration) > 0).map((effect) => effect.character_id)}
                getAttributeValue={(characterId, attributeKey) => {
                  const fighter = fighters.find((item) => item.id === characterId);
                  return fighter ? val(fighter, attributeKey) : 0;
                }} />
            </div>}
          {actionMode === "combat" && actor && <Actions battleId={battle.id} actor={actor} targets={targets} fighters={fighters} defs={defs}
              val={val} effects={effects} abilitiesOf={abilitiesOf}
              onDamageApplied={(targetName, total) => noteActivity("damage", targetName + " recebeu " + total + " de dano manual.")} />}
          {actionMode !== "dots" && !actor && <p className="panel p-5 text-sm text-muted-foreground">Escolha quem está agindo para habilitar ataques, testes, habilidades e controle mental.</p>}
          {actionMode === "dots" && <div className="panel space-y-3 p-4">
            <h3 className="font-display text-lg text-gold">Aplicar DoTs cadastrados</h3>
            <DamageOverTimeManager mode="combat" battleId={battle.active ? battle.id : null}
              fighters={fighters.map((fighter) => ({ id: fighter.id, name: fighter.name }))} active={!!battle.active} />
          </div>}
        </> : <p className="panel p-5 text-sm text-muted-foreground">As ações de combate são controladas pelo mestre. Abra Detalhes em Combatentes para consultar sua ficha, seus efeitos e habilidades.</p>}
      </section>}
      </div>
      {combatTab === "summary" && <section className="space-y-4" aria-label="Resumo da batalha">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {([
            ["Combatentes", String(fighters.length)],
            ["HP crítico", String(criticalFighters.length)],
            ["DoTs visíveis", String(dotEffects.length)],
            ["Controles mentais", String(mindControlEffects.length)],
          ] as const).map(([label, value]) => (
            <div key={label} className="panel p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 font-display text-3xl text-gold tabular-nums">{value}</p></div>
          ))}
        </div>
        <div className="panel space-y-3 p-4">
          <div className="flex items-center gap-2"><ShieldAlert className="h-5 w-5 text-gold" /><h3 className="font-display text-lg text-gold">Visão tática</h3></div>
          <p className="text-xs text-muted-foreground">Os jogadores só veem os valores numéricos e efeitos de suas próprias fichas.</p>
          {fighters.map((fighter) => {
            const isOwn = isMaster || fighter.owner_id === userId;
            const hp = fighter.character_attributes.find((attr) => attr.attribute_key === "hp")?.current_value ?? 0;
            const hpMax = isOwn ? val(fighter, "hp") : 0;
            const fighterDots = effects.filter((effect) => effect.character_id === fighter.id && effect.effect_type === "damage_over_time").length;
            return <div key={fighter.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
              <div className="min-w-0"><p className="truncate font-semibold">{fighter.name}{actor?.id === fighter.id ? " · Na vez" : ""}</p>
                <p className="text-xs text-muted-foreground">{isOwn ? "HP " + hp + " / " + hpMax : "HP " + (publicStateByCharacter.get(fighter.id)?.hp_state ?? "Indisponível")}{fighterDots > 0 ? " · " + fighterDots + " DoT(s)" : ""}</p></div>
              <Button size="sm" variant="outline" onClick={() => {
                setFighterSearch("");
                setFighterFilter("all");
                setCombatTab("fighters");
                setExpandedFighterIds(new Set([fighter.id]));
              }}>Detalhes</Button>
            </div>;
          })}
          {fighters.length === 0 && <p className="text-sm text-muted-foreground">Não há combatentes nesta batalha.</p>}
        </div>
        {isMaster && <details className="panel p-4" open={battleAdminOpen} onToggle={(event) => setBattleAdminOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer font-semibold text-gold"><Settings2 className="mr-2 inline h-4 w-4" /> Configurar batalha, participantes e encerramento</summary>
          <div className="mt-4"><BattleAdmin battle={battle} fighters={fighters} onUpdate={update} /></div>
        </details>}
      </section>}
      {combatTab === "activity" && <section className="panel space-y-3 p-4" aria-label="Atividade recente deste dispositivo">
        <h3 className="font-display text-lg text-gold"><ScrollText className="mr-2 inline h-5 w-5" /> Atividade nesta sessão</h3>
        <p className="text-xs text-muted-foreground">Registro local dos danos manuais, turnos, efeitos adicionados e transformações executados aqui. Não é um histórico completo nem fica salvo no banco de dados.</p>
        {combatActivity.length === 0 ? <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Ainda não há ações registradas neste dispositivo.</p> : (
          <ol className="space-y-2">
            {combatActivity.map((entry) => <li key={entry.id} className="flex gap-3 rounded-md border border-border p-3 text-sm">
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{entry.at}</span>
              <span>{entry.label}</span>
            </li>)}
          </ol>
        )}
      </section>}
      {isMaster && advancedTransformation && defs && <TransformationAdvancedActivationDialog
        key={advancedTransformation.template.id + ":" + advancedTransformation.characterId}
        transformation={advancedTransformation.template}
        characterName={advancedTransformation.characterName}
        defs={defs}
        busy={!!activatingTransformationFor}
        onCancel={() => setAdvancedTransformation(null)}
        onConfirm={(overrides) => activateTransformation(
          advancedTransformation.characterId,
          advancedTransformation.template.id,
          overrides,
        )}
      />}
      <CombatNavigation active={combatTab} onSelect={setCombatTab} mobile />
    </div>
  );
}



function activeEffectDetails(effect: BattleEffect, defs: AttributeDef[], damageTypes: { id: string; name: string }[]) {
  const amount = Number(effect.amount) || 0;
  const sign = effect.polarity === "buff" ? "+" : "−";
  const value = effect.value_mode === "percent" ? amount + "%" : amount + " pontos";
  const attribute = defs.find((definition) => definition.key === effect.attribute_key)?.label ?? effect.attribute_key ?? "atributo";
  switch (effect.effect_type) {
    case "status": return `Modifica ${attribute}: ${sign}${value}. O valor é considerado nos atributos do personagem enquanto o efeito estiver ativo.`;
    case "regeneration": return `Modifica a regeneração de ${effect.attribute_key === "hp" ? "HP" : "Mana"} em ${sign}${value} por turno.`;
    case "damage_over_time": return damageOverTimeSummary(effect, damageTypes);
    case "damage_reduction": return damageReductionSummary(effect, damageTypes);
    case "healing": return periodicHealingSummary(effect);
    case "damage_dealt": return `Modifica o dano causado (${effect.damage_scope === "physical" ? "físico" : effect.damage_scope === "magical" ? "mágico" : "qualquer categoria"}) em ${sign}${effect.value_mode === "percent" ? amount + "%" : amount + " fixos"}.`;
    case "damage_vulnerability": return "Vulnerabilidade: receber o tipo de dano configurado pode ativar outros efeitos neste personagem.";
    case "debuff_relief": return `Alívio de debuffs: reduz a intensidade numérica dos efeitos negativos em ${amount}%.`;
    case "dot_resistance": return `Resistência a DoTs: reduz ${String((effect.effect_data as Record<string, Json> | undefined)?.dot_resistance_mode ?? "damage") === "duration" ? "a duração" : "o dano"} em ${effect.value_mode === "percent" ? amount + "%" : amount + " fixos"}.`;
    case "dot_immunity": return "Imune à aplicação de efeitos de dano por turno (DoTs) conforme a configuração.";
    case "no_regen_hp": return "Impede a regeneração de HP enquanto durar o efeito.";
    case "no_regen_mana": return "Impede a regeneração de Mana enquanto durar o efeito.";
    case "no_mana": return "Sem Mana: a Mana é zerada e habilidades mágicas ou que dependam dela são bloqueadas.";
    case "magic_prohibition": return "Proibição de magia: impede o uso de habilidades classificadas como mágicas.";
    case "invincible": return "Invencível: bloqueia o dano recebido enquanto este efeito estiver ativo.";
    case "healing_blocked": return "Bloqueio de cura: impede receber cura de habilidades conforme as regras do efeito.";
    case "mana_used": return `Modifica o custo de Mana de habilidades em ${effect.polarity === "buff" ? "−" : "+"}${effect.value_mode === "percent" ? amount + "%" : amount + " Mana"}.`;
    case "stun": return "Stun: efeito de atordoamento, considerado nos testes de ataque.";
    case "mind_control": return "Controle mental: o personagem está sendo controlado pela origem indicada no efeito.";
    case "mental_control_immunity": return "Imunidade contra tentativas de controle mental.";
    case "mental_control_chance": return `Aumenta a potência do controle mental em ${effect.value_mode === "percent" ? amount + "%" : amount + " pontos"}.`;
    case "mental_control_resistance": return `Aumenta a resistência a controle mental em ${effect.value_mode === "percent" ? amount + "%" : amount + " pontos"}.`;
    case "invisibility": return "Invisibilidade: personagem marcado como invisível enquanto este efeito estiver ativo.";
    default: return "Efeito ativo neste personagem.";
  }
}

type VisibleCombatEffect = BattleEffect & {
  passiveDefinition?: AbilityEffectDefinition;
  passiveAbilityName?: string;
};

function ActiveCombatEffectsPanel({ effects, passiveEffects, defs, getSource }: {
  effects: BattleEffect[];
  passiveEffects: PassiveEffectDisplay[];
  defs: AttributeDef[];
  getSource: (effect: BattleEffect) => string;
}) {
  const [filter, setFilter] = useState<"all" | "buff" | "debuff" | "dots">("all");
  const { data: damageTypes = [] } = useDamageTypes();
  const { data: effectRaces = [] } = useRaces();

  // Passive ability effects already contribute to game calculations through
  // character_abilities. Project them only for display: never write them to
  // battle_effects or add them to the list used by damage/turn calculations.
  const passiveCards: VisibleCombatEffect[] = unregisteredPassiveEffectsForDisplay(passiveEffects, effects)
    .map(({ id, abilityId, abilityName, effect }) => ({
      id,
      battle_id: null,
      character_id: "",
      name: effect.name,
      effect_type: (effect.effect_type === "mana_regeneration" ? "regeneration" : effect.effect_type) as BattleEffect["effect_type"],
      attribute_key: effect.attribute_key,
      polarity: effect.polarity,
      value_mode: effect.value_mode,
      amount: effect.amount,
      duration: 1,
      duration_scope: "individual",
      until_combat_end: false,
      is_sheet_permanent: true,
      source_character_ability_id: abilityId,
      passiveDefinition: effect,
      passiveAbilityName: abilityName,
    }));
  const allEffects: VisibleCombatEffect[] = [...effects, ...passiveCards];
  const visible = allEffects.filter((effect) => {
    if (filter === "dots") return effect.effect_type === "damage_over_time";
    if (filter === "all") return true;
    return effect.polarity === filter;
  });
  return (
    <section className="space-y-3" aria-label="Visualização dos efeitos ativos">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gold/20 pb-3">
        <div className="flex items-center gap-2.5">
          <span className="rounded-lg border border-gold/30 bg-gold/10 p-2"><Sparkles className="h-5 w-5 text-gold" /></span>
          <div>
            <h3 className="font-display text-lg text-gold">Efeitos ativos <span className="text-muted-foreground">({allEffects.length})</span></h3>
            <p className="text-xs text-muted-foreground">Descrição, origem e duração de cada efeito.</p>
          </div>
        </div>
        <select aria-label="Filtrar efeitos ativos" className="min-h-10 rounded-md border border-input bg-background px-3 text-sm" value={filter}
          onChange={(event) => setFilter(event.target.value as typeof filter)}>
          <option value="all">Todos os efeitos</option>
          <option value="buff">Buffs</option>
          <option value="debuff">Debuffs</option>
          <option value="dots">DoTs</option>
        </select>
      </div>
      {visible.length === 0 && <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {allEffects.length === 0 ? "Nenhum efeito ativo neste personagem." : "Nenhum efeito corresponde ao filtro."}
      </p>}
      {visible.map((effect) => {
        const isDot = effect.effect_type === "damage_over_time";
        const positive = effect.polarity === "buff" && !isDot;
        const permanent = !!(effect.source_class_id || effect.source_race_id || effect.source_virtue_id || effect.is_sheet_permanent);
        const durationText = effect.passiveDefinition ? "Permanente (passivo)" : permanent ? "Permanente" : effect.until_combat_end ? "Até o fim do combate" : effect.duration + " turno(s)";
        const EffectIcon = isDot ? Droplets : positive ? ShieldCheck : Skull;
        const source = getSource(effect) + (effect.passiveDefinition && effect.passiveAbilityName && getSource(effect).startsWith("Acessório:")
          ? " · Habilidade: " + effect.passiveAbilityName
          : "");
        return (
          <article key={effect.id} className={cn(
            "grimorio-effects-card relative grid min-w-0 gap-3 overflow-hidden p-3 transition-colors sm:grid-cols-[3rem_minmax(0,1fr)_minmax(7.75rem,auto)] sm:gap-4 sm:p-4",
            isDot ? "!border-orange-500/55 bg-orange-950/20" : positive
              ? "!border-emerald-500/55 bg-emerald-950/20" : "!border-red-500/55 bg-red-950/20",
          )}>
            <div className={cn(
              "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border shadow-[inset_0_0_15px_rgba(255,255,255,.035)]",
              isDot ? "border-orange-500/45 bg-orange-600/10 text-orange-400" : positive
                ? "border-emerald-500/45 bg-emerald-600/10 text-emerald-400" : "border-red-500/45 bg-red-600/10 text-red-400",
            )}><EffectIcon className="h-6 w-6" aria-hidden="true" /></div>
            <div className="min-w-0 space-y-2">
              <div>
                <h4 className={cn("break-words text-sm font-bold sm:text-base", isDot ? "text-orange-300" : positive ? "text-emerald-300" : "text-red-300")}>{effect.name}</h4>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <span className={cn("rounded-md border px-2 py-0.5 text-[11px] font-semibold",
                    isDot ? "border-orange-500/30 bg-orange-500/15 text-orange-300" : positive
                      ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300" : "border-red-500/30 bg-red-500/15 text-red-300")}>
                    {isDot ? "DoT" : positive ? "Positivo" : "Negativo"}
                  </span>
                  <span className="rounded-md border border-gold/15 bg-black/20 px-2 py-0.5 text-[11px] capitalize text-muted-foreground">
                    {effect.effect_type.replace(/_/g, " ")}
                  </span>
                  {effect.passiveDefinition && (
                    <span className="rounded-md border border-gold/35 bg-gold/10 px-2 py-0.5 text-[11px] font-semibold text-gold">
                      Passivo de habilidade
                    </span>
                  )}
                </div>
              </div>
              <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-[#cbbfac] sm:text-sm">
                {effect.passiveDefinition
                  ? effectSummary(effect.passiveDefinition, defs, damageTypes, effectRaces)
                  : activeEffectDetails(effect, defs, damageTypes)}
              </p>
            </div>
            <div className="flex flex-row flex-wrap gap-x-4 gap-y-2 border-t border-gold/15 pt-2 text-xs text-muted-foreground sm:flex-col sm:justify-center sm:gap-3 sm:border-l sm:border-t-0 sm:pl-3 sm:pt-0">
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Duração</p>
                <p className="flex items-center gap-1.5 font-semibold text-foreground"><Hourglass className="h-3.5 w-3.5 shrink-0 text-gold" /> {durationText}</p>
                {effect.passiveDefinition
                  ? <span className="text-[10px] text-muted-foreground">Enquanto a habilidade estiver concedida à ficha</span>
                  : !permanent && !effect.until_combat_end && <span className="text-[10px] text-muted-foreground">{effect.duration_scope === "global" ? "Turno global" : "Turno individual"}</span>}
              </div>
              <div className="min-w-0">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Origem</p>
                <p className="break-words font-medium text-[#e6cc9f]">{source}</p>
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}

function CombatResourceEditor({ fighter, battleId, damageSources, val, effects, defs, onAddEffect, onRemoveEffect, hpRegenBlocked, manaRegenBlocked, manaRegenMode, manaRegenAmount, manaRegenEnabled, manaRegenSaving, onManaRegenModeChange, onManaRegenAmountChange, onManaRegenSave }: { fighter: Fighter; battleId: string; damageSources: Array<{ id: string; name: string }>; val: (f: Fighter, k: string) => number; effects: BattleEffect[]; defs: AttributeDef[]; onAddEffect: (effect: Omit<BattleEffect, "id" | "battle_id" | "character_id">) => void; onRemoveEffect: (id: string) => void; hpRegenBlocked: boolean; manaRegenBlocked: boolean; manaRegenMode: "percent" | "fixed"; manaRegenAmount: string; manaRegenEnabled: boolean; manaRegenSaving: boolean; onManaRegenModeChange: (mode: "percent" | "fixed") => void; onManaRegenAmountChange: (amount: string) => void; onManaRegenSave: () => void }) {
  const qc = useQueryClient();
  const { data: characterAbilities = [] } = useCharacterAbilities(fighter.id);
  const [hpDelta, setHpDelta] = useState("10");
  const [manaDelta, setManaDelta] = useState("10");
  const [manualManaAmount, setManualManaAmount] = useState("10");
  const [sanityDelta, setSanityDelta] = useState("10");
  const [bodyDelta, setBodyDelta] = useState("10");
  const [hpRegenMode, setHpRegenMode] = useState<"percent" | "fixed">("percent");
  const [hpRegenAmount, setHpRegenAmount] = useState("10");
  const [busy, setBusy] = useState(false);
  const [effectName, setEffectName] = useState("");
  const [effectType, setEffectType] = useState<BattleEffect["effect_type"]>("status");
  const [effectAttr, setEffectAttr] = useState("hp");
  const [statusAttributes, setStatusAttributes] = useState<AttributeStatusModifier[]>([{ attribute_key: "hp", value_mode: "fixed", amount: 10 }]);
  const [effectPolarity, setEffectPolarity] = useState<"buff" | "debuff">("buff");
  const [effectMode, setEffectMode] = useState<"percent" | "fixed">("fixed");
  const [effectDamageScope, setEffectDamageScope] = useState<"any" | "physical" | "magical">("any");
  const [reductionScope, setReductionScope] = useState<"physical" | "magical">("physical");
  const [reductionTypeIds, setReductionTypeIds] = useState<string[]>([]);
  const [reductionMagicLevels, setReductionMagicLevels] = useState<("baixa" | "media" | "alta")[]>([]);
  const { data: damageTypes = [] } = useDamageTypes();
  const [effectAmount, setEffectAmount] = useState("10");
  const [effectDuration, setEffectDuration] = useState("2");
  const [effectUntilCombatEnd, setEffectUntilCombatEnd] = useState(false);
  const [effectRemoveOnAttack, setEffectRemoveOnAttack] = useState(false);
  const [dotImmunityScope, setDotImmunityScope] = useState<"all" | "physical" | "magical" | "specific">("all");
  const [dotImmunityTemplateIds, setDotImmunityTemplateIds] = useState<string[]>([]);
  const [dotResistanceScope, setDotResistanceScope] = useState<"all" | "physical" | "magical" | "specific">("all");
  const [dotResistanceTemplateIds, setDotResistanceTemplateIds] = useState<string[]>([]);
  const [dotResistanceMode, setDotResistanceMode] = useState<"damage" | "duration">("damage");
  const [dotResistanceValueMode, setDotResistanceValueMode] = useState<"fixed" | "percent">("percent");
  const { data: dotTemplates = [] } = useDotTemplates();
  const [expandedEffectId, setExpandedEffectId] = useState<string | null>(null);


  async function regenerateHp() {
    const attr = fighter.character_attributes.find((a) => a.attribute_key === "hp");
    if (!attr) { toast.error("Atributo HP não encontrado"); return; }
    const amount = Number(hpRegenAmount);
    if (!Number.isFinite(amount) || amount < 0) { toast.error("Informe uma regeneração de HP válida"); return; }
    const maximum = val(fighter, "hp");
    const regen = hpRegenMode === "percent" ? Math.ceil(maximum * amount / 100) : Math.floor(amount);
    const regenEffects = effects.filter(e => e.effect_type === "regeneration" && e.attribute_key === "hp");
    const passiveRegen = passiveRegenerationModifiers(characterAbilities, "hp");
    const fixedRegen = passiveRegen.fixed + regenEffects.filter(e => e.value_mode === "fixed").reduce((n,e) => n + (e.polarity === "buff" ? 1 : -1) * Number(e.amount), 0);
    const percentRegen = passiveRegen.percent + regenEffects.filter(e => e.value_mode === "percent").reduce((n,e) => n + (e.polarity === "buff" ? 1 : -1) * Number(e.amount), 0);
    const adjustedRegen = hpRegenBlocked ? 0 : Math.max(0, Math.floor(regen * (1 + percentRegen / 100) + fixedRegen));
    const next = Math.min(maximum, (attr.current_value ?? 0) + adjustedRegen);
    setBusy(true);
    try {
      const { error } = await supabase.from("character_attributes").update({ current_value: next, updated_at: new Date().toISOString() }).eq("character_id", fighter.id).eq("attribute_key", "hp");
      if (error) { toast.error(error.message); return; }
      toast.success("HP de " + fighter.name + ": " + attr.current_value + " → " + next);
      await qc.invalidateQueries({ queryKey: ["battles"] });
    } finally { setBusy(false); }
  }

  async function regenerateMana() {
    if (manaRegenBlocked) {
      toast.error("A regeneração de Mana está bloqueada por um efeito ativo");
      return;
    }
    const attr = fighter.character_attributes.find((a) => a.attribute_key === "mana");
    if (!attr) { toast.error("Atributo Mana não encontrado"); return; }
    const amount = Number(manualManaAmount);
    if (!Number.isFinite(amount) || amount <= 0) { toast.error("Informe uma quantidade positiva de Mana"); return; }
    const maximum = val(fighter, "mana");
    const regenEffects = effects.filter(e => e.effect_type === "regeneration" && e.attribute_key === "mana");
    const passiveRegen = passiveRegenerationModifiers(characterAbilities, "mana");
    const fixedRegen = passiveRegen.fixed + regenEffects.filter(e => e.value_mode === "fixed").reduce((n,e) => n + (e.polarity === "buff" ? 1 : -1) * Number(e.amount), 0);
    const percentRegen = passiveRegen.percent + regenEffects.filter(e => e.value_mode === "percent").reduce((n,e) => n + (e.polarity === "buff" ? 1 : -1) * Number(e.amount), 0);
    const adjustedRegen = Math.max(0, Math.floor(amount * (1 + percentRegen / 100) + fixedRegen));
    const next = Math.min(maximum, (attr.current_value ?? 0) + adjustedRegen);
    setBusy(true);
    try {
      const { error } = await supabase.from("character_attributes").update({ current_value: next, updated_at: new Date().toISOString() }).eq("character_id", fighter.id).eq("attribute_key", "mana");
      if (error) { toast.error(error.message); return; }
      toast.success("Mana de " + fighter.name + ": " + attr.current_value + " → " + next);
      await qc.invalidateQueries({ queryKey: ["battles"] });
    } finally { setBusy(false); }
  }

  async function fillMana() {
    const attr = fighter.character_attributes.find((a) => a.attribute_key === "mana");
    if (!attr) { toast.error("Atributo Mana não encontrado"); return; }
    const maximum = val(fighter, "mana");
    if ((attr.current_value ?? 0) >= maximum) {
      toast.info(fighter.name + " já está com a Mana cheia");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.from("character_attributes").update({ current_value: maximum, updated_at: new Date().toISOString() }).eq("character_id", fighter.id).eq("attribute_key", "mana");
      if (error) { toast.error(error.message); return; }
      toast.success("Mana de " + fighter.name + " restaurada ao máximo: " + maximum);
      await qc.invalidateQueries({ queryKey: ["battles"] });
    } finally { setBusy(false); }
  }

  async function changePercent(field: "sanity" | "body", deltaText: string, direction: 1 | -1) {
    const delta = Number(deltaText);
    if (!Number.isFinite(delta) || delta <= 0) { toast.error("Informe uma quantidade positiva"); return; }
    setBusy(true);
    try {
      const current = field === "sanity" ? fighter.sanity : fighter.body;
      const next = Math.max(0, Math.min(100, current + delta * direction));
      const { error } = await supabase.from("characters").update({ [field]: next }).eq("id", fighter.id);
      if (error) { toast.error(error.message); return; }
      toast.success((field === "sanity" ? "Sanidade" : "Corpo") + ": " + current + "% → " + next + "%");
      await qc.invalidateQueries({ queryKey: ["battles"] });
    } finally { setBusy(false); }
  }

  async function changeHp(direction: 1 | -1) {
    const delta = Number(hpDelta);
    const attr = fighter.character_attributes.find((attribute) => attribute.attribute_key === "hp");
    if (!attr) { toast.error("Atributo HP não encontrado"); return; }
    const current = Number(attr.current_value ?? 0);
    const next = calculateManualCombatHp(current, val(fighter, "hp"), delta, direction);
    if (next === null) {
      toast.error("Informe uma quantidade inteira de HP entre 1 e 1.000.000");
      return;
    }
    if (next === current) {
      toast.info(direction > 0 ? fighter.name + " já está no HP máximo" : fighter.name + " já está com 0 HP");
      return;
    }
    setBusy(true);
    try {
      // Alteração manual de HP pelo mestre, sem tratar como regeneração,
      // dano de habilidade ou mitigação.
      const { error } = await supabase.from("character_attributes")
        .update({ current_value: next, updated_at: new Date().toISOString() })
        .eq("character_id", fighter.id).eq("attribute_key", "hp");
      if (error) { toast.error(error.message); return; }
      toast.success("HP de " + fighter.name + ": " + current + " → " + next);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["battles"] }),
        qc.invalidateQueries({ queryKey: ["character", fighter.id] }),
      ]);
    } finally { setBusy(false); }
  }

  async function changeMana() {
    const delta = Number(manaDelta);
    if (!Number.isFinite(delta) || delta <= 0) { toast.error("Informe uma quantidade positiva"); return; }
    const attr = fighter.character_attributes.find((a) => a.attribute_key === "mana");
    if (!attr) { toast.error("Atributo Mana não encontrado"); return; }
    setBusy(true);
    try {
      const next = Math.max(0, Math.min(val(fighter, "mana"), attr.current_value - delta));
      const { error } = await supabase.from("character_attributes").update({ current_value: next, updated_at: new Date().toISOString() }).eq("character_id", fighter.id).eq("attribute_key", "mana");
      if (error) { toast.error(error.message); return; }
      toast.success("Mana: " + attr.current_value + " → " + next);
      await qc.invalidateQueries({ queryKey: ["battles"] });
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-2">
      <div className="text-xs font-semibold text-muted-foreground">Recursos do personagem (mestre)</div>
      <div className="space-y-2">
        <details className="rounded-md border border-border">
          <summary className="cursor-pointer select-none px-3 py-3 text-sm font-semibold hover:text-gold">Regeneração de mana</summary>
          <div className="space-y-2 border-t border-border p-3">
            <div className="text-xs font-medium">Regeneração de mana desta ficha</div>
            <div className="grid grid-cols-2 gap-2">
              <select aria-label="Modo de regeneração de mana" className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm" value={manaRegenMode} onChange={(e) => onManaRegenModeChange(e.target.value as "percent" | "fixed")}>
                <option value="percent">% da mana máxima</option><option value="fixed">Valor fixo</option>
              </select>
              <Input aria-label="Valor de regeneração de mana" type="number" min="0" value={manaRegenAmount} onChange={(e) => onManaRegenAmountChange(e.target.value)} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {manaRegenEnabled ? "Ativado no cartão deste combatente." : "Desligado. Marque Regenerar Mana por Turno no cartão do combatente."}
              </p>
              <Button size="sm" variant="outline" className="min-h-10" disabled={manaRegenSaving} onClick={onManaRegenSave}>
                {manaRegenSaving ? "Salvando..." : "Salvar regeneração"}
              </Button>
            </div>
            <div className="space-y-2 border-t border-border pt-3">
              <div className="text-xs font-medium">Regenerar Mana manualmente</div>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Input aria-label="Quantidade de Mana para regenerar manualmente" type="number" min="1" value={manualManaAmount} onChange={(e) => setManualManaAmount(e.target.value)} />
                <Button size="sm" disabled={busy || manaRegenBlocked} onClick={() => void regenerateMana()}><Plus className="mr-1 h-3 w-3" /> Regenerar</Button>
              </div>
              <Button className="w-full" size="sm" variant="outline" disabled={busy} onClick={() => void fillMana()}>Encher Mana até o máximo</Button>
            </div>
            {manaRegenBlocked && <div className="text-xs text-destructive">Regeneração de Mana bloqueada. O preenchimento completo continua disponível para o mestre.</div>}
          </div>
        </details>
        <details className="rounded-md border border-border">
          <summary className="cursor-pointer select-none px-3 py-3 text-sm font-semibold hover:text-gold">Regeneração de HP</summary>
          <div className="space-y-2 border-t border-border p-3">
            <div className="text-xs font-medium">Regenerar HP desta ficha</div>
            <div className="grid grid-cols-2 gap-2">
              <select aria-label="Modo de regeneração de HP" className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm" value={hpRegenMode} onChange={(e) => setHpRegenMode(e.target.value as "percent" | "fixed")}>
                <option value="percent">% do HP máximo</option><option value="fixed">Valor fixo</option>
              </select>
              <Input aria-label="Valor de regeneração de HP" type="number" min="0" value={hpRegenAmount} onChange={(e) => setHpRegenAmount(e.target.value)} />
            </div>
            <Button size="sm" disabled={busy || hpRegenBlocked} onClick={() => void regenerateHp()}><Plus className="mr-1 h-3 w-3" /> Regenerar HP</Button>
            {hpRegenBlocked && <div className="text-xs text-destructive">Regeneração de HP bloqueada.</div>}
          </div>
        </details>
      </div>
      <details className="rounded-md border border-border">
        <summary className="cursor-pointer select-none px-3 py-3 text-sm font-semibold hover:text-gold">Alterar HP, Mana, Sanidade e Corpo</summary>
        <div className="border-t border-border p-3">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <Input aria-label="Quantidade de HP para alterar" type="number" min="1" max="1000000" step="1"
              value={hpDelta} onChange={(e) => setHpDelta(e.target.value)} />
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="outline" disabled={busy}
                aria-label={"Reduzir HP de " + fighter.name}
                onClick={() => void changeHp(-1)}>
                <Minus className="mr-1 h-3 w-3" /> HP
              </Button>
              <Button size="sm" variant="outline" disabled={busy}
                aria-label={"Aumentar HP de " + fighter.name}
                onClick={() => void changeHp(1)}>
                <Plus className="mr-1 h-3 w-3" /> HP
              </Button>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <Input aria-label="Quantidade de mana a reduzir" type="number" min="1" value={manaDelta} onChange={(e) => setManaDelta(e.target.value)} />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void changeMana()}><Minus className="mr-1 h-3 w-3" /> − Mana</Button>
        <Input aria-label="Quantidade de sanidade para alterar" type="number" min="1" value={sanityDelta} onChange={(e) => setSanityDelta(e.target.value)} />
        <div className="flex gap-1">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void changePercent("sanity", sanityDelta, -1)}><Minus className="mr-1 h-3 w-3" /> Sanidade</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void changePercent("sanity", sanityDelta, 1)}><Plus className="mr-1 h-3 w-3" /> Sanidade</Button>
        </div>
        <Input aria-label="Quantidade de corpo para alterar" type="number" min="1" value={bodyDelta} onChange={(e) => setBodyDelta(e.target.value)} />
        <div className="flex gap-1">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void changePercent("body", bodyDelta, -1)}><Minus className="mr-1 h-3 w-3" /> Corpo</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void changePercent("body", bodyDelta, 1)}><Plus className="mr-1 h-3 w-3" /> Corpo</Button>
        </div>
      </div>
        </div>
      </details>
      <details className="rounded-md border border-red-500/25">
        <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2 px-3 py-3 text-sm font-semibold text-red-300 hover:bg-red-500/5 hover:text-red-200">
          <Swords className="h-4 w-4 shrink-0" aria-hidden="true" /> Aplicar dano em {fighter.name}
        </summary>
        <div className="space-y-2 border-t border-border p-2 sm:p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Formulário completo de dano para este personagem: físico, mágico, híbrido, verdadeiro,
            críticos, golpes múltiplos, defesas, mitigação, efeitos e DoTs.
          </p>
          <DamageApplier
            target={{ id: fighter.id, name: fighter.name }}
            battleId={battleId}
            sources={damageSources}
          />
        </div>
      </details>
      <details className="rounded-md border border-border">
        <summary className="cursor-pointer select-none px-3 py-3 text-sm font-semibold hover:text-gold">Efeitos ativos e aplicar efeito ({effects.length})</summary>
        <div className="space-y-2 border-t border-border p-3">
        <div className="text-xs font-semibold text-muted-foreground">Efeitos ativos — toque/clique em um efeito para ver os detalhes</div>
        {effects.length === 0 ? <p className="text-xs text-muted-foreground">Nenhum efeito ativo.</p> : <div className="flex flex-wrap gap-2">
          {effects.map(effect => {
            const details = [
              effect.effect_type === "status" ? `${effect.polarity === "buff" ? "Buff" : "Debuff"} de ${defs.find(d => d.key === effect.attribute_key)?.label ?? effect.attribute_key} (${effect.value_mode === "percent" ? `${effect.polarity === "debuff" ? "-" : "+"}${effect.amount}%` : `${effect.polarity === "debuff" ? "-" : "+"}${effect.amount} pontos`})` :
              effect.effect_type === "regeneration" ? `${effect.polarity === "buff" ? "Buff" : "Debuff"} de regeneração de ${effect.attribute_key === "hp" ? "HP" : "Mana"}: ${effect.value_mode === "percent" ? `${effect.polarity === "debuff" ? "-" : "+"}${effect.amount}%` : `${effect.polarity === "debuff" ? "-" : "+"}${effect.amount} fixos`}` :
              effect.effect_type === "damage_over_time" ? damageOverTimeSummary(effect, damageTypes) : effect.effect_type === "debuff_relief" ? `Alívio de Debuff: reduz intensidade em ${effect.amount}%` : effect.effect_type === "dot_resistance" ? `Resistência a DoTs: ${String((effect.effect_data as Record<string, Json> | undefined)?.dot_resistance_mode ?? "damage") === "duration" ? "reduz duração" : "reduz dano"} em ${effect.amount}${effect.value_mode === "percent" ? "%" : " fixos"}` :
              effect.effect_type === "damage_vulnerability" ? "Vulnerabilidade de Dano: aplica efeitos ao receber dano compatível" :
              effect.effect_type === "healing" ? periodicHealingSummary(effect) : effect.effect_type === "invincible" ? "Invencível: não recebe nenhum dano enquanto estiver ativo" : effect.effect_type === "healing_blocked" ? "Bloqueio de Cura: impede receber curas de habilidades" : effect.effect_type === "no_regen_hp" ? "Impede regeneração de HP" :
              effect.effect_type === "no_regen_mana" ? "Impede regeneração de Mana" : effect.effect_type === "no_mana" ? "Sem Mana: Mana zerada e habilidades mágicas/que usam Mana bloqueadas" : effect.effect_type === "damage_reduction" ? damageReductionSummary(effect, damageTypes) : effect.effect_type === "mana_used" ? `Mana usada ${effect.polarity === "buff" ? "−" : "+"}${effect.value_mode === "percent" ? `${effect.amount}%` : `${effect.amount} Mana`}` : effect.effect_type === "damage_dealt" ? `${effect.polarity === "buff" ? "Buff" : "Debuff"} de dano ${effect.damage_scope === "physical" ? "físico" : effect.damage_scope === "magical" ? "mágico" : "qualquer dano"}: ${effect.polarity === "debuff" ? "-" : "+"}${effect.value_mode === "percent" ? `${effect.amount}%` : `${effect.amount} de dano`}` : effect.effect_type === "magic_prohibition" ? "Proibição de magia: não pode usar habilidades que consomem Mana" : effect.effect_type === "mind_control" ? "Controle Mental: " + effect.name : effect.effect_type === "mental_control_immunity" ? "Imune a Controle Mental" : effect.effect_type === "mental_control_chance" ? "Potência de Controle Mental: " + (effect.value_mode === "percent" ? effect.amount + "% de redução" : effect.amount + " fixos de redução") : effect.effect_type === "mental_control_resistance" ? "Resistência a Controle Mental: " + (effect.value_mode === "percent" ? effect.amount + "% de resistência extra" : effect.amount + " fixos extras") : effect.effect_type === "dot_immunity" ? "Imunidade a DoTs" : effect.effect_type === "invisibility" ? "Invisibilidade (visual)" : "Stun (apenas visual)"
            ];
            const expanded = expandedEffectId === effect.id;
            return <div key={effect.id} className="w-full rounded-md border border-border bg-muted/30 p-2">
              <div className="flex items-start gap-2">
                <button type="button" aria-expanded={expanded} onClick={() => setExpandedEffectId(expanded ? null : effect.id)} className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded px-1 py-1 text-left text-xs hover:text-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold">
                  <span className="min-w-0"><span className="font-medium">{effect.name}</span><span className="ml-2 text-muted-foreground">({effect.source_class_id ? "permanente (classe)" : effect.source_race_id ? "permanente (raça)" : effect.source_virtue_id ? "permanente (virtude)" : effect.is_sheet_permanent ? "permanente na ficha" : effect.until_combat_end ? "até o fim do combate" : `${effect.duration} turno(s)`})</span></span>
                  <span aria-hidden="true" className="shrink-0 text-muted-foreground">{expanded ? "−" : "+"}</span>
                </button>
                {!effect.source_race_id && !effect.source_class_id && !effect.source_virtue_id && <button type="button" aria-label={`Remover efeito ${effect.name}`} title="Remover efeito" onClick={() => onRemoveEffect(effect.id)} className="rounded px-2 py-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"><span className="text-sm leading-none">×</span></button>}
              </div>
              {expanded && <div className="mt-2 border-t border-border pt-2 text-xs" role="status">
                <div className="font-semibold">{effect.name}</div>
                <div className="mt-1">{details}</div>
                <div className="mt-1 text-muted-foreground">{effect.source_class_id ? "Efeito permanente concedido pela classe; não é removido por cura nem pelo avanço de turnos." : effect.source_race_id ? "Efeito permanente concedido pela raça; não é removido por cura nem pelo avanço de turnos." : effect.source_virtue_id ? "Efeito permanente concedido pela virtude; não é removido por cura nem pelo avanço de turnos." : effect.is_sheet_permanent ? "Efeito permanente na ficha; não é removido por limpeza, ataques ou fim de combate. Só o mestre pode removê-lo." : effect.until_combat_end ? "Permanece ativo até o combate ser encerrado." : `Duração restante: ${effect.duration} turno(s). Diminui quando o turno individual deste personagem avança ou no avanço do turno geral.`}</div>
              </div>}
            </div>;
          })}
        </div>}
        <Input placeholder="Nome do efeito" value={effectName} onChange={e => setEffectName(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={effectType} onChange={e => { const type = e.target.value as BattleEffect["effect_type"]; setEffectType(type); if(type === "regeneration") setEffectAttr("hp"); if(type === "magic_prohibition" || type === "no_mana" || type === "healing_blocked") setEffectPolarity("debuff"); if(["invincible","damage_reduction","mental_control_immunity","mental_control_chance","mental_control_resistance","dot_immunity","dot_resistance","invisibility"].includes(type)) setEffectPolarity("buff"); if(type === "mental_control_chance" || type === "mental_control_resistance") { setEffectMode("percent"); setEffectAmount("50"); } if(type === "dot_resistance") { setEffectMode("percent"); setEffectAmount("25"); setDotResistanceScope("all"); setDotResistanceTemplateIds([]); setDotResistanceMode("damage"); setDotResistanceValueMode("percent"); } if(type === "invincible" || type === "damage_reduction") { setEffectPolarity("buff"); setReductionScope("physical"); setReductionTypeIds(damageTypes[0] ? [damageTypes[0].id] : []); setReductionMagicLevels(["baixa"]); } }}>
            <option value="status">Buff/debuff de status</option><option value="regeneration">Buff/debuff de regeneração</option><option value="no_regen_hp">Não regenera HP</option><option value="no_regen_mana">Não regenera Mana</option><option value="no_mana">Sem Mana (debuff)</option><option value="damage_dealt">Dano Causado</option><option value="damage_reduction">Mitigação de Dano</option><option value="magic_prohibition">Proibição de magia (debuff)</option><option value="invincible">Invencível — não recebe dano</option><option value="healing_blocked">Bloqueio de Cura (debuff)</option><option value="mental_control_immunity">Imune a Controle Mental</option><option value="mental_control_chance">Potência de Controle Mental</option><option value="mental_control_resistance">Resistência a Controle Mental</option><option value="dot_immunity">Imunidade a DoTs</option><option value="dot_resistance">Resistência a DoTs</option><option value="invisibility">Invisibilidade (visual)</option><option value="stun">Stun (visual)</option>
          </select>
          {effectType === "regeneration" && <select className="min-h-11 rounded-md border border-input bg-background px-2 text-sm" value={effectAttr} onChange={e => setEffectAttr(e.target.value)}><option value="hp">HP</option><option value="mana">Mana</option></select>}
          {effectType === "status" && <div className="col-span-2 space-y-2 rounded-lg border border-gold/30 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-gold">Atributos deste Buff/Debuff ({statusAttributes.length})</span>
              <select aria-label="Buff ou debuff de atributos" className="min-h-11 rounded-md border border-input bg-background px-2 text-xs" value={effectPolarity} onChange={e => setEffectPolarity(e.target.value as "buff" | "debuff")}>
                <option value="buff">Buff (+)</option><option value="debuff">Debuff (−)</option>
              </select>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {statusAttributes.map((item) => (
                <div key={item.attribute_key} className="min-w-0 space-y-2 rounded-md border border-border p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 break-words text-xs font-semibold">{defs.find(d => d.key === item.attribute_key)?.label ?? item.attribute_key}</span>
                    <Button size="sm" variant="ghost" className="min-h-9 text-red-300" disabled={statusAttributes.length <= 1}
                      aria-label={"Remover " + item.attribute_key}
                      onClick={() => setStatusAttributes(items => items.filter(v => v.attribute_key !== item.attribute_key))}>
                      <Minus className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <select className="min-h-11 min-w-0 rounded-md border border-input bg-background px-2 text-xs" aria-label={"Modo de " + item.attribute_key}
                      value={item.value_mode} onChange={e => setStatusAttributes(items => items.map(v => v.attribute_key === item.attribute_key ? { ...v, value_mode: e.target.value as "fixed" | "percent" } : v))}>
                      <option value="fixed">Fixo</option><option value="percent">%</option>
                    </select>
                    <Input type="number" min={0} max={1000000} step="any" inputMode="decimal" aria-label={"Valor de " + item.attribute_key}
                      value={item.amount} onChange={e => setStatusAttributes(items => items.map(v => v.attribute_key === item.attribute_key ? { ...v, amount: Math.max(0, Math.min(1000000, Number(e.target.value) || 0)) } : v))}/>
                  </div>
                </div>
              ))}
            </div>
            <select value="" aria-label="Adicionar atributo ao efeito" className="min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
              onChange={e => { if (e.target.value) setStatusAttributes(items => [...items, { attribute_key: e.target.value, value_mode: "fixed", amount: 10 }]); }}>
              <option value="">+ Adicionar atributo…</option>
              {defs.filter(d => !statusAttributes.some(v => v.attribute_key === d.key)).map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
            <Button size="sm" variant="outline" className="min-h-10" disabled={defs.every(d => statusAttributes.some(v => v.attribute_key === d.key))}
              onClick={() => setStatusAttributes(items => [...items, ...defs.filter(d => !items.some(v => v.attribute_key === d.key)).map(d => ({ attribute_key: d.key, amount: 10, value_mode: "fixed" as const }))])}>
              <Plus className="mr-1 h-4 w-4"/> Todos os atributos
            </Button>
          </div>}
          {effectType === "damage_dealt" && <label className="col-span-2 space-y-1 text-xs font-medium"><span>Tipo de dano afetado</span><select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={effectDamageScope} onChange={e => setEffectDamageScope(e.target.value as "any" | "physical" | "magical")}><option value="physical">Físico</option><option value="magical">Mágico</option><option value="any">Qualquer dano</option></select></label>}
          {effectType === "damage_reduction" && <>
            <label className="col-span-2 space-y-1 text-xs font-medium"><span>Categoria a mitigar</span><select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={reductionScope} onChange={e => setReductionScope(e.target.value as "physical" | "magical")}><option value="physical">Físico</option><option value="magical">Mágico</option></select></label>
            {reductionScope === "magical" && <>
              <fieldset className="col-span-2 space-y-2 text-xs">
                <legend className="font-medium">Tipo mágico</legend>
                <label className="flex items-center gap-2 rounded-md border border-border px-2 py-2">
                  <input type="radio" name={`mitigacao-tipos-manual-${fighter.id}`} checked={reductionTypeIds.length === 0} onChange={() => setReductionTypeIds([])} />
                  Todos os tipos
                </label>
                <p className="text-muted-foreground">{reductionTypeIds.length === 0 ? "A redução afeta todos os tipos mágicos cadastrados." : `${reductionTypeIds.length} tipo(s) selecionado(s).`}</p>
                {damageTypes.length === 0
                  ? <p className="text-amber-500">Nenhum tipo mágico cadastrado.</p>
                  : <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {damageTypes.map(type => (
                        <label key={type.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-2">
                          <input type="checkbox" checked={reductionTypeIds.includes(type.id)} onChange={e => setReductionTypeIds(current => e.target.checked ? [...current, type.id] : current.filter(id => id !== type.id))} />
                          {type.name}
                        </label>
                      ))}
                    </div>}
              </fieldset>
              <fieldset className="col-span-2 space-y-2 text-xs">
                <legend className="font-medium">Grau da magia</legend>
                <label className="flex items-center gap-2 rounded-md border border-border px-2 py-2">
                  <input type="radio" name={`mitigacao-graus-manual-${fighter.id}`} checked={reductionMagicLevels.length === 0} onChange={() => setReductionMagicLevels([])} />
                  Todos os graus
                </label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {([["baixa", "Baixa"], ["media", "Média"], ["alta", "Alta"]] as const).map(([level, label]) => (
                    <label key={level} className="flex items-center gap-2 rounded-md border border-border px-2 py-2">
                      <input type="checkbox" checked={reductionMagicLevels.includes(level)} onChange={e => setReductionMagicLevels(current => e.target.checked ? [...current, level] : current.filter(selected => selected !== level))} />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            </>}
            <p className="col-span-2 text-xs text-muted-foreground">Aplica-se depois da defesa correspondente. A redução fixa vem primeiro e a porcentagem depois.</p>
          </>}
          {(effectType === "regeneration" || effectType === "damage_dealt" || effectType === "damage_reduction" || effectType === "mental_control_chance" || effectType === "mental_control_resistance") && <>{!["damage_reduction","mental_control_chance","mental_control_resistance"].includes(effectType) && <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={effectPolarity} onChange={e => setEffectPolarity(e.target.value as "buff" | "debuff")}><option value="buff">Buff</option><option value="debuff">Debuff</option></select>}<select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={effectMode} onChange={e => setEffectMode(e.target.value as "percent" | "fixed")}><option value="percent">Porcentagem</option><option value="fixed">Pontos fixos</option></select></>}
          {(effectType === "regeneration" || effectType === "damage_dealt" || effectType === "damage_reduction" || effectType === "mental_control_chance" || effectType === "mental_control_resistance") && <label className="col-span-2 space-y-1 text-xs font-medium"><span>Valor do efeito ({effectMode === "percent" ? "%" : effectType === "damage_dealt" ? "dano fixo" : effectType === "damage_reduction" ? "dano reduzido fixo" : "pontos fixos"})</span><Input aria-label="Valor do efeito em porcentagem ou pontos fixos" type="number" min="0" value={effectAmount} onChange={e => setEffectAmount(e.target.value)} /></label>}
          <label className="col-span-2 space-y-1 text-xs font-medium"><span>Duração do efeito</span><select aria-label="Duração do efeito" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={effectUntilCombatEnd ? "until_combat_end" : "turns"} onChange={e => setEffectUntilCombatEnd(e.target.value === "until_combat_end")}><option value="turns">Por turnos</option><option value="until_combat_end">Até o fim do combate</option></select></label>
          {effectType === "dot_resistance" && <fieldset className="col-span-2 space-y-2 rounded-md border border-border p-3">
             <legend className="text-xs font-semibold">Resistência a DoTs</legend>
             {([[ "all", "Todos os DoTs" ], [ "physical", "Todos os DoTs físicos" ], [ "magical", "Todos os DoTs mágicos" ], [ "specific", "DoTs específicos" ]] as const).map(([scope,label]) => <label key={scope} className="flex items-center gap-2 text-xs"><input type="radio" name={"manual-dot-resistance-" + fighter.id} checked={dotResistanceScope === scope} onChange={() => setDotResistanceScope(scope)} />{label}</label>)}
             {dotResistanceScope === "specific" && <div className="grid gap-2 sm:grid-cols-2">{dotTemplates.map((dot) => <label key={dot.id} className="flex items-center gap-2 rounded border border-border p-2 text-xs"><input type="checkbox" checked={dotResistanceTemplateIds.includes(dot.id)} onChange={(event) => setDotResistanceTemplateIds((current) => event.target.checked ? [...new Set([...current,dot.id])] : current.filter((id) => id !== dot.id))} /><span>{dot.name} <span className="text-muted-foreground">({dot.damage_kind === "physical" ? "físico" : "mágico"})</span></span></label>)}</div>}
             <div className="grid gap-2 sm:grid-cols-2">
               <label className="space-y-1 text-xs font-medium">Reduzir<select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={dotResistanceMode} onChange={(event) => setDotResistanceMode(event.target.value as "damage" | "duration")}><option value="damage">Dano por turno</option><option value="duration">Duração em turnos</option></select></label>
               <label className="space-y-1 text-xs font-medium">Tipo de valor<select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={dotResistanceValueMode} onChange={(event) => { const mode = event.target.value as "fixed" | "percent"; setDotResistanceValueMode(mode); setEffectMode(mode); }}><option value="fixed">Fixo</option><option value="percent">Porcentagem</option></select></label>
             </div>
             <p className="text-xs text-muted-foreground">A resistência é aplicada quando o DoT entra na ficha. Valores percentuais reduzem o dano ou a duração na porcentagem escolhida.</p>
           </fieldset>}{effectType === "dot_immunity" && <fieldset className="col-span-2 space-y-2"><legend className="text-xs font-semibold">Quais DoTs são bloqueados?</legend>{([["all","Todos os DoTs"],["physical","Somente DoTs físicos"],["magical","Somente DoTs mágicos"],["specific","Selecionar DoTs específicos"]] as const).map(([scope,label]) => <label key={scope} className="flex items-center gap-2 text-xs"><input type="radio" name={"manual-dot-immunity-" + fighter.id} checked={dotImmunityScope === scope} onChange={() => setDotImmunityScope(scope)} />{label}</label>)}{dotImmunityScope === "specific" && <div className="grid gap-2 sm:grid-cols-2">{dotTemplates.map((dot) => <label key={dot.id} className="flex items-center gap-2 rounded border border-border p-2 text-xs"><input type="checkbox" checked={dotImmunityTemplateIds.includes(dot.id)} onChange={(event) => setDotImmunityTemplateIds((current) => event.target.checked ? [...new Set([...current,dot.id])] : current.filter((id) => id !== dot.id))} /><span>{dot.name} <span className="text-muted-foreground">({dot.damage_kind === "physical" ? "físico" : "mágico"})</span></span></label>)}</div>}</fieldset>}
          <label className="col-span-2 flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={effectRemoveOnAttack} onChange={e => setEffectRemoveOnAttack(e.target.checked)} /><span><span className="font-medium">Remover ao atacar</span><span className="block text-muted-foreground">Termina quando este personagem usa uma habilidade ou causa dano com um ataque.</span></span></label>
          {!effectUntilCombatEnd && <label className="col-span-2 space-y-1 text-xs font-medium"><span>Duração (quantos turnos)</span><Input aria-label="Duração em turnos" type="number" min="1" value={effectDuration} onChange={e => setEffectDuration(e.target.value)} /></label>}
          <p className="col-span-2 text-xs text-muted-foreground">Ao avançar um turno individual, só os efeitos desse personagem perdem 1 turno; ao avançar o turno geral, os efeitos dos personagens perdem 1 turno. Efeitos configurados até o fim do combate não perdem duração por turno.</p>
        </div>
        <Button size="sm" onClick={() => {
          const duration = effectUntilCombatEnd ? 1 : Math.floor(Number(effectDuration));
          const amount = Number(effectAmount);
          const needsAttribute = effectType === "status" || effectType === "regeneration";
          const needsAmount = effectType !== "status" && (needsAttribute || effectType === "damage_dealt" || effectType === "damage_reduction" || effectType === "mental_control_chance" || effectType === "mental_control_resistance" || effectType === "dot_resistance");
          if (!effectName.trim() || (!effectUntilCombatEnd && (duration < 1 || !Number.isFinite(duration))) || (needsAmount && (!Number.isFinite(amount) || amount < 0))) {
            toast.error("Preencha o nome, uma duração e um valor válidos.");
            return;
          }
          if (effectType === "damage_reduction" && reductionScope === "magical" && damageTypes.length === 0) {
            toast.error("Cadastre ao menos um tipo mágico antes de criar esta mitigação.");
            return;
          }
          if (effectType === "dot_resistance" && dotResistanceScope === "specific" && dotResistanceTemplateIds.length === 0) {
             toast.error("Selecione pelo menos um DoT específico para a resistência.");
             return;
           }
           if (effectType === "dot_immunity" && dotImmunityScope === "specific" && dotImmunityTemplateIds.length === 0) {
            toast.error("Selecione pelo menos um DoT específico para bloquear.");
            return;
          }
          onAddEffect({
            name: effectName.trim(),
            effect_type: effectType,
            attribute_key: effectType === "status" ? statusAttributes[0]?.attribute_key ?? effectAttr : needsAttribute ? effectAttr : null,
            damage_scope: effectType === "damage_dealt" ? effectDamageScope : "any",
            damage_reduction_scope: effectType === "damage_reduction" ? reductionScope : "physical",
            damage_reduction_type_id: null,
            damage_reduction_magic_level: null,
            damage_reduction_type_ids: effectType === "damage_reduction" && reductionScope === "magical" ? reductionTypeIds : null,
            damage_reduction_magic_levels: effectType === "damage_reduction" && reductionScope === "magical" ? reductionMagicLevels : null,
            polarity: ["magic_prohibition","no_mana","healing_blocked"].includes(effectType) ? "debuff" : ["damage_reduction","invincible","mental_control_immunity","mental_control_chance","mental_control_resistance","dot_immunity","dot_resistance","invisibility"].includes(effectType) ? "buff" : effectPolarity,
            value_mode: effectType === "status" ? statusAttributes[0]?.value_mode ?? "fixed" : effectType === "magic_prohibition" || effectType === "no_mana" ? "fixed" : effectMode,
            amount: effectType === "status" ? statusAttributes[0]?.amount ?? 0 : needsAmount ? amount : 0,
            duration,
            until_combat_end: effectUntilCombatEnd,
            duration_scope: "global",
            effect_data: {
              remove_on_attack: effectRemoveOnAttack,
              ...(effectType === "status" ? { attribute_modifiers: statusAttributes } : {}),
              ...(effectType === "dot_immunity" ? { dot_immunity_scope: dotImmunityScope, dot_immunity_template_ids: dotImmunityTemplateIds } : {}),
              ...(effectType === "dot_resistance" ? { dot_resistance_scope: dotResistanceScope, dot_resistance_template_ids: dotResistanceTemplateIds, dot_resistance_mode: dotResistanceMode, dot_resistance_value_mode: dotResistanceValueMode, dot_resistance_amount: amount } : {}),
            } as Json,
          });
          setEffectName("");
          setStatusAttributes([{ attribute_key: "hp", value_mode: "fixed", amount: 10 }]);
          setEffectUntilCombatEnd(false);
          setEffectRemoveOnAttack(false);
          setDotImmunityScope("all");
          setDotImmunityTemplateIds([]);
           setDotResistanceScope("all");
           setDotResistanceTemplateIds([]);
           setDotResistanceMode("damage");
           setDotResistanceValueMode("percent");
        }}><Plus className="mr-1 h-3 w-3" /> Aplicar efeito</Button>
        </div>
      </details>
    </div>
  );
}

function Bar({ label, cur, max, tone }: { label: string; cur: number; max: number; tone: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs"><span className="text-muted-foreground">{label}</span><span className="tabular">{cur} / {max}</span></div>
      <StatBar value={cur} max={max} tone={tone} />
    </div>
  );
}

function BattleAdmin({ battle, fighters, onUpdate }: {
  battle: BattleRow; fighters: Fighter[];
  onUpdate: (p: { active?: boolean; name?: string }) => Promise<void>;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(battle.name);
  const [participantsBusy, setParticipantsBusy] = useState(false);
  const { data: all } = useQuery({
    queryKey: ["characters-min"],
    queryFn: async () => {
      const { data, error } = await supabase.from("characters")
        .select("id,name")
        // Summoned clones belong only to their current battle. They must never
        // appear in the list of reusable, permanent character sheets.
        .eq("is_summon_snapshot", false)
        .order("name");
      if (error) throw error;
      return data;
    },
  });
  const inIds = new Set(fighters.map((f) => f.id));
  const refresh = () => qc.invalidateQueries({ queryKey: ["battles"] });
  async function toggleParticipant(id: string, checked: boolean) {
    if (participantsBusy) return;
    setParticipantsBusy(true);
    try {
      if (checked) {
        const { error } = await supabase.from("battle_participants").insert({
          battle_id: battle.id, character_id: id, sort_order: fighters.length,
        });
        if (error) throw error;
        toast.success("Personagem adicionado à batalha.");
      } else {
        const { error } = await supabase.from("battle_participants")
          .delete().eq("battle_id", battle.id).eq("character_id", id);
        if (error) throw error;
        if (battle.current_character_id === id || battle.target_character_id === id) {
          const { error: resetError } = await supabase.from("battles").update({
            current_character_id: battle.current_character_id === id ? null : battle.current_character_id,
            target_character_id: battle.target_character_id === id ? null : battle.target_character_id,
          }).eq("id", battle.id);
          if (resetError) throw resetError;
        }
        toast.success("Personagem removido da batalha.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível alterar os participantes.");
    } finally {
      await refresh();
      setParticipantsBusy(false);
    }
  }
  async function del() {
    if (!confirm("Excluir esta batalha?")) return;
    const { error } = await supabase.from("battles").delete().eq("id", battle.id);
    if (error) { toast.error(error.message); return; }
    await refresh();
  }
  return (
    <div className="panel space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="max-w-xs" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== battle.name && onUpdate({ name })} />
        <Button size="sm" variant="outline" onClick={() => onUpdate({ active: !battle.active })}>
          {battle.active ? "Encerrar batalha" : "Reabrir batalha"}
        </Button>
        <Button size="sm" variant="ghost" onClick={del}><Trash2 className="mr-1 h-4 w-4" /> Excluir</Button>
      </div>
      <div className="space-y-2">
        <div>
          <h3 className="text-sm font-semibold text-gold">Participantes da batalha ({fighters.length})</h3>
          <p className="text-xs text-muted-foreground">
            As fichas que já participam continuam visíveis. Pesquise pelo nome para incluir outras,
            sem carregar todos os personagens na tela.
          </p>
        </div>
        <SearchableGrantPicker
          options={(all ?? []).map((character) => ({ id: character.id, name: character.name }))}
          selectedIds={inIds}
          selectedLabel="Fichas selecionadas"
          emptyLabel="Nenhuma ficha permanente foi adicionada."
          addLabel="Adicionar ficha à batalha"
          searchPlaceholder="Buscar personagem para adicionar…"
          disabled={participantsBusy}
          onToggle={(id, checked) => void toggleParticipant(id, checked)}
        />
        {fighters.some((fighter) => !(all ?? []).some((character) => character.id === fighter.id)) && (
          <p className="text-xs text-muted-foreground">
            As invocações que participam desta batalha aparecem nos cards de Combatentes.
          </p>
        )}
      </div>
    </div>
  );
}


type Roll = { title: string; lines: { who: string; dice: string; detail: string }[] };

function MindControlPanel({ battleId, actor, fighters, selectedTargets, effects, abilitiesOf, val }: {
  battleId: string;
  actor: Fighter;
  fighters: Fighter[];
  selectedTargets: Fighter[];
  effects: BattleEffect[];
  abilitiesOf: (fighterId: string) => Array<{ passive_effects?: Array<{ effect_type: string; polarity: string; value_mode: string; amount: number }> }>;
  val: (f: Fighter, k: string) => number;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selections, setSelections] = useState<Record<string, { selected: boolean; controlled: boolean; duration: string }>>({});
  const candidates = fighters.filter((fighter) => fighter.id !== actor.id);
  const activeFor = (characterId: string) => effects.filter((effect) => effect.character_id === characterId && Number(effect.duration) > 0);
  const passiveFor = (characterId: string) => abilitiesOf(characterId).flatMap((ability) => ability.passive_effects ?? []);
  const immune = (target: Fighter) =>
    activeFor(target.id).some((effect) => effect.effect_type === "mental_control_immunity") ||
    passiveFor(target.id).some((effect) => effect.effect_type === "mental_control_immunity");

  function resistanceFor(target: Fighter) {
    const controllerModifiers = [
      ...activeFor(actor.id).filter((effect) => effect.effect_type === "mental_control_chance"),
      ...passiveFor(actor.id).filter((effect) => effect.effect_type === "mental_control_chance"),
    ];
    const targetModifiers = [
      ...activeFor(target.id).filter((effect) => effect.effect_type === "mental_control_resistance"),
      ...passiveFor(target.id).filter((effect) => effect.effect_type === "mental_control_resistance"),
    ];
    const amount = (effect: { amount: number }) => Math.max(0, Number(effect.amount) || 0);
    // Os percentuais se acumulam multiplicativamente, em vez de serem somados.
    const remainingFraction = controllerModifiers
      .filter((effect) => effect.value_mode === "percent")
      .reduce((factor, effect) => factor * (1 - Math.min(95, amount(effect)) / 100), 1);
    const fixedReduction = Math.floor(controllerModifiers
      .filter((effect) => effect.value_mode !== "percent")
      .reduce((sum, effect) => sum + amount(effect), 0));
    const base = Math.max(0, Math.floor(val(target, "mental") / 10));
    const afterPower = Math.max(0, Math.floor(base * remainingFraction) - fixedReduction);
    const resistanceMultiplier = Math.min(10, targetModifiers
      .filter((effect) => effect.value_mode === "percent")
      .reduce((factor, effect) => factor * (1 + Math.min(500, amount(effect)) / 100), 1));
    const fixedResistance = Math.floor(targetModifiers
      .filter((effect) => effect.value_mode !== "percent")
      .reduce((sum, effect) => sum + amount(effect), 0));
    const modifier = Math.max(0, Math.floor(afterPower * resistanceMultiplier) + fixedResistance);
    const sides = 20 + Math.floor(modifier / 20) * 10;
    return {
      base,
      afterPower,
      modifier,
      sides,
      die: "1d" + sides + "+" + modifier,
      multiplier: resistanceMultiplier,
      fixedResistance,
      immune: immune(target),
    };
  }

  function showDialog() {
    const next: Record<string, { selected: boolean; controlled: boolean; duration: string }> = {};
    for (const target of candidates) {
      next[target.id] = {
        selected: selectedTargets.some((selected) => selected.id === target.id),
        controlled: false,
        duration: "2",
      };
    }
    setSelections(next);
    setOpen(true);
  }

  async function confirmResults() {
    const chosen = candidates
      .filter((target) => selections[target.id]?.selected)
      .map((target) => {
        const selection = selections[target.id];
        return {
          target_id: target.id,
          controlled: selection?.controlled === true,
          duration: Number(selection?.duration ?? 2),
        };
      });
    if (chosen.length === 0) {
      toast.error("Selecione pelo menos um alvo para Controle Mental.");
      return;
    }
    for (const selection of chosen) {
      const target = candidates.find((fighter) => fighter.id === selection.target_id)!;
      if (selection.controlled && immune(target)) {
        toast.error(target.name + " está imune a Controle Mental.");
        return;
      }
      if (selection.controlled && (!Number.isInteger(selection.duration) || selection.duration < 1 || selection.duration > 1000)) {
        toast.error("A duração do Controle Mental deve ser um inteiro entre 1 e 1000 turnos.");
        return;
      }
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("apply_mind_control_effects", {
        _battle_id: battleId,
        _controller_character_id: actor.id,
        _target_selections: chosen as unknown as Json,
      });
      if (error) throw error;
      const count = Number(data ?? 0);
      toast.success(count > 0 ? "Controle Mental aplicado a " + count + " alvo(s)." : "Nenhum controle confirmado; nenhum efeito foi aplicado.");
      setOpen(false);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["battle-effects", battleId] }),
        qc.invalidateQueries({ queryKey: ["battles"] }),
        qc.invalidateQueries({ queryKey: ["character-active-effects"] }),
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível aplicar Controle Mental.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={showDialog} disabled={!candidates.length || busy}>
          <Brain className="mr-1 h-4 w-4" /> Controle Mental
        </Button>
        <span className="text-xs text-muted-foreground">Resistência: 1d20 + Força Mental ÷ 10; o dado escala com o modificador.</span>
      </div>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-3" role="presentation">
          <section role="dialog" aria-modal="true" aria-labelledby="mind-control-title" className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-border bg-background p-4 shadow-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="mind-control-title" className="flex items-center gap-2 text-xl text-gold"><Brain className="h-5 w-5" /> Controle Mental — {actor.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">Marque os alvos, confira os dados para resistir e confirme separadamente quais foram controlados. O resultado final é decidido pelo mestre.</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>Fechar</Button>
            </div>
            <div className="mt-4 space-y-3">
              {candidates.map((target) => {
                const state = selections[target.id] ?? { selected: false, controlled: false, duration: "2" };
                const resistance = resistanceFor(target);
                return (
                  <div key={target.id} className={"rounded-lg border p-3 " + (state.selected ? "border-gold/60 bg-gold/5" : "border-border")}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                      <label className="flex min-w-0 flex-1 items-start gap-2">
                        <input type="checkbox" className="mt-1" checked={state.selected} disabled={busy} onChange={(event) => setSelections((current) => ({
                          ...current,
                          [target.id]: { ...state, selected: event.target.checked, controlled: event.target.checked ? state.controlled : false },
                        }))} />
                        <span><span className="font-semibold">{target.name}</span><span className="block text-xs text-muted-foreground">Força Mental: {val(target, "mental")} → modificador base +{resistance.base}</span></span>
                      </label>
                      <div className="sm:min-w-40">
                        <div className="text-xs text-muted-foreground">Dado para resistir</div>
                        <div className="font-display text-2xl text-gold">{resistance.die}</div>
                      </div>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {resistance.immune
                        ? "Imunidade ativa: este alvo não pode receber Controle Mental."
                        : "Modificador após Potência de Controle Mental: +" + resistance.afterPower + "; resistência percentual ×" + resistance.multiplier.toFixed(2) + "; resistência fixa +" + resistance.fixedResistance + ". Em +20 o dado passa a 1d30; a cada +20 adicionais, ganha mais 10 faces."}
                    </div>
                    {state.selected && (
                      <div className="mt-3 grid gap-3 border-t border-border/70 pt-3 sm:grid-cols-[1fr_160px]">
                        <label className="flex items-start gap-2 text-sm">
                          <input type="checkbox" className="mt-1" checked={state.controlled} disabled={busy || resistance.immune} onChange={(event) => setSelections((current) => ({
                            ...current,
                            [target.id]: { ...state, controlled: event.target.checked },
                          }))} />
                          <span><span className="font-medium">O mestre confirma que foi controlado</span><span className="block text-xs text-muted-foreground">Só marcar esta opção aplicará o efeito.</span></span>
                        </label>
                        {state.controlled && (
                          <label className="space-y-1 text-xs font-medium">
                            Duração do controle (turnos)
                            <Input type="number" min={1} max={1000} step={1} value={state.duration} disabled={busy} onChange={(event) => setSelections((current) => ({
                              ...current,
                              [target.id]: { ...state, duration: event.target.value },
                            }))} />
                          </label>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex flex-col-reverse justify-end gap-2 sm:flex-row">
              <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancelar</Button>
              <Button onClick={() => void confirmResults()} disabled={busy || !candidates.some((target) => selections[target.id]?.selected)}>
                {busy ? "Aplicando controle..." : "Confirmar resultados e aplicar efeitos"}
              </Button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function Actions({ battleId, actor, targets, fighters, defs, val, effects, abilitiesOf, onDamageApplied }: {
  battleId: string;
  actor: Fighter;
  targets: Fighter[];
  fighters: Fighter[];
  defs: AttributeDef[];
  val: (f: Fighter, k: string) => number;
  effects: BattleEffect[];
  abilitiesOf: (fighterId: string) => Array<{ passive_effects?: Array<{ effect_type: string; polarity: string; value_mode: string; amount: number }> }>;
  onDamageApplied?: (targetName: string, damage: number) => void;
}) {
  const [roll, setRoll] = useState<Roll | null>(null);
  const [testKey, setTestKey] = useState("strength");
  const [dodgeFromId, setDodgeFromId] = useState(() => targets[0]?.id ?? fighters.find((f) => f.id !== actor.id)?.id ?? "");
  const label = (k: string) => defs.find((d) => d.key === k)?.label ?? k;
  const dodgeFrom = fighters.find((f) => f.id === dodgeFromId && f.id !== actor.id);
  const testable = defs;

  function attack() {
    const aAtk = val(actor, "atk_speed");
    const lines = targets.flatMap((target) => {
      const tSpeed = val(target, "speed");
      const stunned = hasActiveStun(target.id, effects);
      return [
        {
          who: `${actor.name} → ${target.name} (ataque)`,
          dice: dice(attackDiceModifier(aAtk, tSpeed, stunned)),
          detail: `(${label("atk_speed")} ${aAtk} − ${label("speed")} ${tSpeed}) ÷ 10${stunned ? " +1 (Stun no alvo)" : ""}`,
        },
        {
          who: `${target.name} (esquiva)`,
          dice: dice(diceMod(tSpeed, aAtk)),
          detail: `(${label("speed")} ${tSpeed} − ${label("atk_speed")} ${aAtk}) ÷ 10`,
        },
      ];
    });
    setRoll({ title: `${actor.name} ataca ${targets.length} alvo(s)`, lines });
  }

  function test() {
    const a = val(actor, testKey);
    const lines = targets.flatMap((target) => {
      const t = val(target, testKey);
      const targetSpeed = val(target, "speed");
      const actorAttackSpeed = val(actor, "atk_speed");
      return [
        {
          who: `${actor.name} — ${label(testKey)} vs ${target.name}`,
          dice: dice(diceMod(a, t)),
          detail: `(${a} − ${t}) ÷ 10`,
        },
        {
          who: `${target.name} — resposta de ${label(testKey)}`,
          dice: dice(diceMod(t, a)),
          detail: `(${t} − ${a}) ÷ 10`,
        },
        {
          who: `${target.name} (esquiva)`,
          dice: dice(diceMod(targetSpeed, actorAttackSpeed)),
          detail: `(${label("speed")} ${targetSpeed} − ${label("atk_speed")} do atacante ${actorAttackSpeed}) ÷ 10`,
        },
      ];
    });
    setRoll({ title: `Teste de ${label(testKey)} contra os alvos selecionados`, lines });
  }

  function testDodge() {
    if (!dodgeFrom) {
      toast.error("Selecione de quem deseja esquivar");
      return;
    }
    const mySpeed = val(actor, "speed");
    const enemyAttackSpeed = val(dodgeFrom, "atk_speed");
    setRoll({
      title: `${actor.name} tenta esquivar de ${dodgeFrom.name}`,
      lines: [{
        who: `${actor.name} (esquiva)`,
        dice: dice(diceMod(mySpeed, enemyAttackSpeed)),
        detail: `(${label("speed")} ${mySpeed} − ${label("atk_speed")} de ${dodgeFrom.name} ${enemyAttackSpeed}) ÷ 10`,
      }],
    });
  }

  return (
    <div className="space-y-4">
      <div className="panel space-y-4 p-4">
        <h2 className="text-xl text-gold">Ações de {actor.name}</h2>
        <MindControlPanel battleId={battleId} actor={actor} fighters={fighters} selectedTargets={targets} effects={effects} abilitiesOf={abilitiesOf} val={val} />
        {targets.length > 0 && (
          <>
            <div className="rounded-md border border-border p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Alvos selecionados ({targets.length})</div>
              <div className="flex flex-wrap gap-2">
                {targets.map((t) => <span key={t.id} className="rounded-md border border-blood/50 px-2 py-1 text-sm">{t.name}</span>)}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={attack}><Swords className="mr-1 h-4 w-4" /> Atacar todos</Button>
              <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={testKey} onChange={(e) => setTestKey(e.target.value)}>
                {testable.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
              <Button variant="outline" onClick={test}><Dices className="mr-1 h-4 w-4" /> Teste contra todos</Button>
            </div>
          </>
        )}
        <div className="space-y-2 border-t border-border pt-4">
          <h3 className="flex items-center gap-2 text-lg text-gold"><Footprints className="h-5 w-5" /> Teste de esquiva único</h3>
          <p className="text-sm text-muted-foreground">A esquiva usa sua Velocidade menos a Velocidade de Ataque do inimigo, dividido por 10, com modificador mínimo 0.</p>
          <div className="flex flex-wrap gap-2">
            <select className="h-9 min-w-48 rounded-md border border-input bg-background px-2 text-sm" value={dodgeFromId} onChange={(e) => setDodgeFromId(e.target.value)}>
              <option value="">Selecione um inimigo</option>
              {fighters.filter((f) => f.id !== actor.id).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <Button variant="outline" onClick={testDodge}><Footprints className="mr-1 h-4 w-4" /> Testar esquiva</Button>
          </div>
        </div>
        {roll && (
          <div className="space-y-2 rounded-md border border-gold/40 p-3">
            <div className="font-display text-gold">{roll.title}</div>
            {roll.lines.map((line, i) => (
              <div key={`${line.who}-${i}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 py-1 last:border-0">
                <div>
                  <div className="text-sm">{line.who}</div>
                  <div className="text-xs text-muted-foreground">{line.detail} (modificador mínimo 0)</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="tabular font-display text-2xl text-gold">{line.dice}</span>
                  <Button size="icon" variant="ghost" aria-label={`Copiar ${line.dice} de ${line.who}`} onClick={() => { navigator.clipboard.writeText(line.dice); toast.success("Copiado"); }}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {targets.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-xl text-gold">Aplicar dano por alvo</h2>
          <p className="text-sm text-muted-foreground">Cada alvo tem campos próprios para quantidade e valores de dano; aplicar em um alvo não altera os outros.</p>
          {targets.map((target) => <details key={target.id} className="panel p-3">
            <summary className="cursor-pointer rounded-md py-2 font-semibold text-gold">Aplicar dano em {target.name}</summary>
            <div className="mt-3">
              <DamageApplier target={target} battleId={battleId}
                sources={fighters.filter((fighter) => fighter.id !== target.id).map((fighter) => ({ id: fighter.id, name: fighter.name }))}
                defaultSourceCharacterId={actor.id}
                onDamageApplied={(result) => onDamageApplied?.(target.name, result.totalDamage)} />
            </div>
          </details>)}
        </div>
      )}
    </div>
  );
}
