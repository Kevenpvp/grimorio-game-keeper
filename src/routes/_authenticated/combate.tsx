import type { Json } from "@/integrations/supabase/types";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Crosshair, Dices, Plus, Swords, Trash2, Copy, Footprints, RotateCw, Minus, Brain, Activity } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";

import { computeValue, conditionAdjustedValue, physicalAttributePoints, traitMods, useDefs, useMe, useRaces, useVirtues, type AttributeDef } from "@/lib/sheets";
import { Portrait } from "@/components/sheet/CharacterSheetView";
import { StatBar } from "@/components/sheet/StatBar";
import { cn } from "@/lib/utils";
import { DamageApplier } from "@/components/combat/DamageApplier";
import { CharacterAbilitiesPanel } from "@/components/abilities/CharacterAbilities";
import { passiveEffectTypeActive, passiveRegenerationModifiers, passiveStatusModifiers, useBattleCharacterAbilities, useCharacterAbilities, useDamageTypes } from "@/lib/abilities";

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
type BattleEffect = { id: string; battle_id: string | null; character_id: string; name: string; effect_type: 'status' | 'regeneration' | 'mana_used' | 'no_regen_hp' | 'no_regen_mana' | 'magic_prohibition' | 'no_mana' | 'stun' | 'damage_dealt' | 'damage_reduction'; attribute_key: string | null; polarity: 'buff' | 'debuff'; value_mode: 'percent' | 'fixed'; amount: number; duration: number; duration_scope: 'individual' | 'global'; damage_scope?: 'any' | 'physical' | 'magical'; damage_reduction_scope?: 'physical' | 'magical'; damage_reduction_type_id?: string | null; damage_reduction_magic_level?: 'baixa' | 'media' | 'alta' | null; damage_reduction_type_ids?: string[] | null; damage_reduction_magic_levels?: ('baixa' | 'media' | 'alta')[] | null; source_character_ability_id?: string | null; effect_group_id?: string | null; is_end_effect?: boolean };
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

type Fighter = {
  id: string; name: string; player_name: string; photo_path: string | null; race_id: string | null; virtue_id: string | null; owner_id: string | null;
  race_physical_allocations: Json; virtue_physical_allocations: Json; race_physical_points_granted: number; virtue_physical_points_granted: number;
  body: number; sanity: number; participant_turn_count?: number;
  character_attributes: Attr[];
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

  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(() => {
    if (pendingCombatRefreshes.get(queryClient) !== batch) return;
    pendingCombatRefreshes.delete(queryClient);
    const keysToRefresh = [...batch.queryKeys.values()];
    void Promise.all(keysToRefresh.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  }, 150);
}

function useLiveBattles() {
  const qc = useQueryClient();
  useEffect(() => {
    const refreshBattles = () => scheduleCombatRefresh(qc, ["battles"]);
    const ch = supabase
      .channel("battles-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "battles" }, refreshBattles)
      .on("postgres_changes", { event: "*", schema: "public", table: "battle_participants" }, refreshBattles)
      .on("postgres_changes", { event: "*", schema: "public", table: "character_attributes" }, refreshBattles)
      .on("postgres_changes", { event: "*", schema: "public", table: "battle_effects" }, () => {
        scheduleCombatRefresh(qc, ["battles"], ["battle-effects"], ["character-active-effects"]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "character_abilities" }, () => {
        scheduleCombatRefresh(qc, ["character-abilities"], ["character-abilities-battle"]);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "abilities" }, () => {
        scheduleCombatRefresh(qc, ["abilities"]);
      })
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [qc]);
  return useQuery({
    queryKey: ["battles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("battles")
        .select("*, battle_participants(sort_order,turn_count, characters(id,name,player_name,photo_path,race_id,virtue_id,owner_id,race_physical_allocations,virtue_physical_allocations,race_physical_points_granted,virtue_physical_points_granted,body,sanity,character_attributes(attribute_key,current_value,max_value,points,bonus)))")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

function CombatPage() {
  const { data: me } = useMe();
  const { data: battles, isLoading } = useLiveBattles();
  const [sel, setSel] = useState<string | null>(null);
  const isMaster = !!me?.isMaster;
  const list = (battles ?? []).filter((b) => isMaster || b.active);
  const battle = list.find((b) => b.id === sel) ?? list[0];

  async function create() {
    const { data, error } = await supabase.from("battles").insert({ name: `Batalha ${list.length + 1}` }).select("id").single();
    if (error) { toast.error(error.message); return; }
    setSel(data.id);
  }

  if (isLoading || !me) return <p className="text-muted-foreground">Carregando…</p>;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-3xl text-gold"><Swords className="h-7 w-7" /> Modo de Combate</h1>
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

function BattleView({ battle, isMaster, userId }: { battle: BattleRow; isMaster: boolean; userId: string }) {
  const { data: defs } = useDefs();
  const { data: races } = useRaces();
  const { data: virtues } = useVirtues();
  const qc = useQueryClient();
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>(() => battle.target_character_id ? [battle.target_character_id] : []);
  const [manaRegenSettings, setManaRegenSettings] = useState<Record<string, { mode: "percent" | "fixed"; amount: string }>>({});
  const [advancingTurnKeys, setAdvancingTurnKeys] = useState<Set<string>>(() => new Set());
  const fighters = useMemo(
    () => battle.battle_participants.slice().sort((a, b) => a.sort_order - b.sort_order).map((p) => ({ ...(p.characters as Fighter), participant_turn_count: p.turn_count ?? 0 })).filter((f) => !!f.id),
    [battle],
  );
  const fighterIds = useMemo(() => fighters.map((fighter) => fighter.id), [fighters]);
  const { data: effects = [] } = useQuery({
    queryKey: ["battle-effects", battle.id, fighterIds],
    enabled: fighterIds.length > 0,
    queryFn: async () => {
      const [battleResult, standaloneResult] = await Promise.all([
        supabase.from("battle_effects").select("*").eq("battle_id", battle.id),
        supabase.from("battle_effects").select("*").is("battle_id", null).in("character_id", fighterIds),
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
    const combined = { ...traitMods(races?.find((r) => r.id === f.race_id)) };
    for (const [key, value] of Object.entries(traitMods(virtues?.find((v) => v.id === f.virtue_id)))) {
      combined[key] = (combined[key] ?? 0) + value;
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
    return noMana && key === "mana" ? 0 : key === "hp" ? Math.max(1, result) : conditionAdjustedValue(f, key, Math.max(0, result));
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
  async function advanceCombatTurn(characterId: string | null) {
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

      const manaRegenerationSettingsForTurn: Record<string, { mode: "percent" | "fixed"; amount: number }> = {};
      for (const fighter of turnFighters) {
        if (!fighter.character_attributes.some((attribute) => attribute.attribute_key === "mana")) continue;
        const setting = manaRegenSettings[fighter.id] ?? { mode: "percent" as const, amount: "0" };
        const amount = Number(setting.amount);
        if (!Number.isFinite(amount) || amount < 0) {
          toast.error("Informe uma regeneração de mana válida para " + fighter.name);
          return;
        }
        manaRegenerationSettingsForTurn[fighter.id] = { mode: setting.mode, amount };
      }

      const { data: nextTurn, error } = await supabase.rpc("advance_combat_turn", {
        _battle_id: battle.id,
        _character_id: characterId,
        _mana_regeneration_settings: manaRegenerationSettingsForTurn as unknown as Json,
      });
      if (error) {
        toast.error("Não foi possível avançar o turno: " + error.message);
        return;
      }

      const confirmedTurn = Number(nextTurn);
      if (Number.isFinite(confirmedTurn)) {
        // Stop an older Realtime-triggered read from overwriting this newly confirmed counter.
        await qc.cancelQueries({ queryKey: ["battles"] });
        qc.setQueryData<BattlesData>(["battles"], (current) => {
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
        toast.success("Turno individual de " + fighter.name + " avançado para " + nextTurn + "; regeneração configurada aplicada.");
      } else {
        toast.success("Turno " + nextTurn + ": regeneração configurada aplicada.");
      }

      // Share a debounced batch with Realtime. The local counter is instant; this background
      // refresh reconciles effects, Mana, cooldowns, and any concurrent changes from other users.
      scheduleCombatRefresh(
        qc,
        ["battles"],
        ["battle-effects"],
        ["character-active-effects"],
        ["character-abilities-battle"],
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
    const { error } = await supabase.from("battle_effects").insert({ ...effect, battle_id: battle.id, character_id: characterId });
    if (error) { toast.error(error.message); return; }
    toast.success("Efeito aplicado: " + effect.name);
    await qc.invalidateQueries({ queryKey: ["battle-effects", battle.id] });
    await qc.invalidateQueries({ queryKey: ["character-active-effects"] });
  }

  const update = async (patch: { current_character_id?: string | null; target_character_id?: string | null; active?: boolean; name?: string }) => {
    const { error } = await supabase.from("battles").update(patch).eq("id", battle.id);
    if (error) toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["battles"] });
  };


  function setManaRegen(fighterId: string, patch: Partial<{ mode: "percent" | "fixed"; amount: string }>) {
    setManaRegenSettings((current) => ({
      ...current,
      [fighterId]: { mode: current[fighterId]?.mode ?? "percent", amount: current[fighterId]?.amount ?? "0", ...patch },
    }));
  }

  const actor = fighters.find((f) => f.id === battle.current_character_id);
  const targets = fighters.filter((f) => selectedTargetIds.includes(f.id) && f.id !== actor?.id);

  function toggleTarget(id: string) {
    if (!actor || actor.id === id) return;
    const next = selectedTargetIds.includes(id)
      ? selectedTargetIds.filter((selectedId) => selectedId !== id)
      : [...selectedTargetIds, id];
    setSelectedTargetIds(next);
    void update({ target_character_id: next[0] ?? null });
  }

  if (!defs) return null;
  return (
    <div className="space-y-6">
      {isMaster && <BattleAdmin battle={battle} fighters={fighters} onUpdate={update} />}
      <div className="panel space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><div className="text-sm text-muted-foreground">Turnos transcorridos</div><div className="font-display text-2xl text-gold">{battle.turn_count ?? 0}</div></div>
          {isMaster && <Button disabled={!battle.active || advancingTurnKeys.has("__global__")} onClick={() => void advanceCombatTurn(null)}><RotateCw className="mr-2 h-4 w-4" /> {advancingTurnKeys.has("__global__") ? "Avançando..." : "Avançar turno geral"}</Button>}
        </div>

      </div>
      {!isMaster && <h2 className="text-xl text-gold">{battle.name}</h2>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {fighters.map((f) => {
          const isActor = f.id === actor?.id;
          const isTarget = selectedTargetIds.includes(f.id) && f.id !== actor?.id;
          const hp = f.character_attributes.find((a) => a.attribute_key === "hp");
          const mana = f.character_attributes.find((a) => a.attribute_key === "mana");
          return (
            <div key={f.id} className={cn("panel space-y-2 p-4", isActor && "border-gold ring-1 ring-gold", isTarget && "border-blood ring-1 ring-blood")}>
              <div className="flex gap-3">
                <Portrait path={f.photo_path} name={f.name} className="h-20 w-16 shrink-0" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="truncate font-display text-lg text-gold">{f.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{f.player_name || "NPC"}</div>
                  {isActor && <div className="text-xs font-semibold text-gold">⚔ Na vez</div>}
                  {isTarget && <div className="text-xs font-semibold text-blood">◎ Alvo selecionado</div>}
                </div>
              </div>
              <Bar label="HP" cur={hp?.current_value ?? 0} max={val(f, "hp")} tone="bg-blood" />
              {defs.filter((d) => d.key !== "hp" && d.key !== "mana" && d.show_bar).map((d) => {
                const attr = f.character_attributes.find((a) => a.attribute_key === d.key);
                return <Bar key={d.key} label={d.label} cur={attr?.current_value ?? val(f, d.key)} max={val(f, d.key)} tone="bg-sky-500" />;
              })}
              <Bar label="Mana" cur={mana?.current_value ?? 0} max={val(f, "mana")} tone="bg-arcane" />
              <CharacterAbilitiesPanel characterId={f.id} characterName={f.name} mode="combat"
                canUse={battle.active && (isMaster || f.owner_id === userId)} battleId={battle.id}
                targets={fighters.map((target) => ({ id: target.id, name: target.name }))} />
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded border border-border p-2"><span className="text-muted-foreground">Corpo</span><div className="font-semibold">{f.body}%</div></div>
                <div className="rounded border border-border p-2"><span className="text-muted-foreground">Sanidade</span><div className="font-semibold">{f.sanity}%</div></div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {defs.filter((d) => !d.show_bar && !["hp", "mana"].includes(d.key)).map((d) => (
                  <div key={d.key} className="rounded border border-border p-2"><span className="text-muted-foreground">{d.label}</span><div className="font-semibold">{val(f, d.key)}</div></div>
                ))}
              </div>
              {isMaster && <CombatResourceEditor fighter={f} val={val} effects={effects.filter(e => e.character_id === f.id)} defs={defs} onAddEffect={(effect) => void addEffect(f.id, effect)} onRemoveEffect={async (id) => { const { error } = await supabase.from("battle_effects").delete().eq("id", id); if (error) toast.error(error.message); await qc.invalidateQueries({ queryKey: ["battle-effects", battle.id] }); await qc.invalidateQueries({ queryKey: ["character-active-effects"] }); }} hpRegenBlocked={blocked(f.id, "no_regen_hp")} manaRegenBlocked={blocked(f.id, "no_regen_mana") || blocked(f.id, "no_mana")} manaRegenMode={manaRegenSettings[f.id]?.mode ?? "percent"} manaRegenAmount={manaRegenSettings[f.id]?.amount ?? "0"} onManaRegenModeChange={(mode) => setManaRegen(f.id, { mode })} onManaRegenAmountChange={(amount) => setManaRegen(f.id, { amount })} /> }
              <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2">
                <span className="text-xs text-muted-foreground">Turnos individuais: {f.participant_turn_count ?? 0}</span>
                {isMaster && <Button size="sm" variant="outline" disabled={!battle.active || advancingTurnKeys.has("__global__") || advancingTurnKeys.has(f.id)} onClick={() => void advanceCombatTurn(f.id)}><RotateCw className="mr-1 h-3.5 w-3.5" /> {advancingTurnKeys.has(f.id) ? "Avançando..." : "Avançar turno"}</Button>}
              </div>
              {isMaster && (
                <div className="flex gap-2 pt-1">
                  <Button size="sm" variant={isActor ? "default" : "outline"} onClick={() => {
                    const next = selectedTargetIds.filter((id) => id !== f.id);
                    setSelectedTargetIds(next);
                    void update({ current_character_id: f.id, target_character_id: next[0] ?? null });
                  }}>
                    <Swords className="mr-1 h-3.5 w-3.5" /> Vez
                  </Button>
                  <Button size="sm" variant={isTarget ? "destructive" : "outline"} disabled={isActor} onClick={() => toggleTarget(f.id)}>
                    <Crosshair className="mr-1 h-3.5 w-3.5" /> {isTarget ? "Remover alvo" : "Selecionar alvo"}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {isMaster && (actor ? (
        <Actions battleId={battle.id} actor={actor} targets={targets} fighters={fighters} defs={defs} val={val} />
      ) : (
        <p className="text-sm text-muted-foreground">Selecione a opção "Vez" de um personagem para abrir as ações e o teste de esquiva.</p>
      ))}
    </div>
  );
}


function CombatResourceEditor({ fighter, val, effects, defs, onAddEffect, onRemoveEffect, hpRegenBlocked, manaRegenBlocked, manaRegenMode, manaRegenAmount, onManaRegenModeChange, onManaRegenAmountChange }: { fighter: Fighter; val: (f: Fighter, k: string) => number; effects: BattleEffect[]; defs: AttributeDef[]; onAddEffect: (effect: Omit<BattleEffect, "id" | "battle_id" | "character_id">) => void; onRemoveEffect: (id: string) => void; hpRegenBlocked: boolean; manaRegenBlocked: boolean; manaRegenMode: "percent" | "fixed"; manaRegenAmount: string; onManaRegenModeChange: (mode: "percent" | "fixed") => void; onManaRegenAmountChange: (amount: string) => void }) {
  const qc = useQueryClient();
  const { data: characterAbilities = [] } = useCharacterAbilities(fighter.id);
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
  const [effectPolarity, setEffectPolarity] = useState<"buff" | "debuff">("buff");
  const [effectMode, setEffectMode] = useState<"percent" | "fixed">("fixed");
  const [effectDamageScope, setEffectDamageScope] = useState<"any" | "physical" | "magical">("any");
  const [reductionScope, setReductionScope] = useState<"physical" | "magical">("physical");
  const [reductionTypeIds, setReductionTypeIds] = useState<string[]>([]);
  const [reductionMagicLevels, setReductionMagicLevels] = useState<("baixa" | "media" | "alta")[]>([]);
  const { data: damageTypes = [] } = useDamageTypes();
  const [effectAmount, setEffectAmount] = useState("10");
  const [effectDuration, setEffectDuration] = useState("2");
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
        <summary className="cursor-pointer select-none px-3 py-3 text-sm font-semibold hover:text-gold">Alterar Mana, Sanidade e Corpo</summary>
        <div className="border-t border-border p-3">
      <div className="grid grid-cols-[1fr_auto] gap-2">
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
      <details className="rounded-md border border-border">
        <summary className="cursor-pointer select-none px-3 py-3 text-sm font-semibold hover:text-gold">Efeitos ativos e aplicar efeito ({effects.length})</summary>
        <div className="space-y-2 border-t border-border p-3">
        <div className="text-xs font-semibold text-muted-foreground">Efeitos ativos — toque/clique em um efeito para ver os detalhes</div>
        {effects.length === 0 ? <p className="text-xs text-muted-foreground">Nenhum efeito ativo.</p> : <div className="flex flex-wrap gap-2">
          {effects.map(effect => {
            const details = [
              effect.effect_type === "status" ? `${effect.polarity === "buff" ? "Buff" : "Debuff"} de ${defs.find(d => d.key === effect.attribute_key)?.label ?? effect.attribute_key} (${effect.value_mode === "percent" ? `${effect.polarity === "debuff" ? "-" : "+"}${effect.amount}%` : `${effect.polarity === "debuff" ? "-" : "+"}${effect.amount} pontos`})` :
              effect.effect_type === "regeneration" ? `${effect.polarity === "buff" ? "Buff" : "Debuff"} de regeneração de ${effect.attribute_key === "hp" ? "HP" : "Mana"}: ${effect.value_mode === "percent" ? `${effect.polarity === "debuff" ? "-" : "+"}${effect.amount}%` : `${effect.polarity === "debuff" ? "-" : "+"}${effect.amount} fixos`}` :
              effect.effect_type === "no_regen_hp" ? "Impede regeneração de HP" :
              effect.effect_type === "no_regen_mana" ? "Impede regeneração de Mana" : effect.effect_type === "no_mana" ? "Sem Mana: Mana zerada e habilidades mágicas/que usam Mana bloqueadas" : effect.effect_type === "damage_reduction" ? damageReductionSummary(effect, damageTypes) : effect.effect_type === "mana_used" ? `Mana usada ${effect.polarity === "buff" ? "−" : "+"}${effect.value_mode === "percent" ? `${effect.amount}%` : `${effect.amount} Mana`}` : effect.effect_type === "damage_dealt" ? `${effect.polarity === "buff" ? "Buff" : "Debuff"} de dano ${effect.damage_scope === "physical" ? "físico" : effect.damage_scope === "magical" ? "mágico" : "qualquer dano"}: ${effect.polarity === "debuff" ? "-" : "+"}${effect.value_mode === "percent" ? `${effect.amount}%` : `${effect.amount} de dano`}` : effect.effect_type === "magic_prohibition" ? "Proibição de magia: não pode usar habilidades que consomem Mana" : "Stun (apenas visual)"
            ];
            const expanded = expandedEffectId === effect.id;
            return <div key={effect.id} className="w-full rounded-md border border-border bg-muted/30 p-2">
              <div className="flex items-start gap-2">
                <button type="button" aria-expanded={expanded} onClick={() => setExpandedEffectId(expanded ? null : effect.id)} className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded px-1 py-1 text-left text-xs hover:text-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold">
                  <span className="min-w-0"><span className="font-medium">{effect.name}</span><span className="ml-2 text-muted-foreground">({effect.duration} turno(s))</span></span>
                  <span aria-hidden="true" className="shrink-0 text-muted-foreground">{expanded ? "−" : "+"}</span>
                </button>
                <button type="button" aria-label={`Remover efeito ${effect.name}`} title="Remover efeito" onClick={() => onRemoveEffect(effect.id)} className="rounded px-2 py-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"><span className="text-sm leading-none">×</span></button>
              </div>
              {expanded && <div className="mt-2 border-t border-border pt-2 text-xs" role="status">
                <div className="font-semibold">{effect.name}</div>
                <div className="mt-1">{details}</div>
                <div className="mt-1 text-muted-foreground">Duração restante: {effect.duration} turno(s). A duração diminui em qualquer avanço de turno, individual ou geral.</div>
              </div>}
            </div>;
          })}
        </div>}
        <Input placeholder="Nome do efeito" value={effectName} onChange={e => setEffectName(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={effectType} onChange={e => { const type = e.target.value as BattleEffect["effect_type"]; setEffectType(type); if(type === "regeneration") setEffectAttr("hp"); if(type === "magic_prohibition" || type === "no_mana") setEffectPolarity("debuff"); if(type === "damage_reduction") { setEffectPolarity("buff"); setReductionScope("physical"); setReductionTypeIds(damageTypes[0] ? [damageTypes[0].id] : []); setReductionMagicLevels(["baixa"]); } }}>
            <option value="status">Buff/debuff de status</option><option value="regeneration">Buff/debuff de regeneração</option><option value="no_regen_hp">Não regenera HP</option><option value="no_regen_mana">Não regenera Mana</option><option value="no_mana">Sem Mana (debuff)</option><option value="damage_dealt">Dano Causado</option><option value="damage_reduction">Mitigação de Dano</option><option value="magic_prohibition">Proibição de magia (debuff)</option><option value="stun">Stun (visual)</option>
          </select>
          {(effectType === "status" || effectType === "regeneration") && <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={effectAttr} onChange={e => setEffectAttr(e.target.value)}>{(effectType === "regeneration" ? [{key:"hp",label:"HP"},{key:"mana",label:"Mana"}] : defs.map(d => ({key:d.key,label:d.key === "hp" ? "HP máximo" : d.key === "mana" ? "Mana máxima" : d.label}))).map(d => <option key={d.key} value={d.key}>{d.label}</option>)}</select>}
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
          {(effectType === "status" || effectType === "regeneration" || effectType === "damage_dealt" || effectType === "damage_reduction") && <>{effectType !== "damage_reduction" && <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={effectPolarity} onChange={e => setEffectPolarity(e.target.value as "buff" | "debuff")}><option value="buff">Buff</option><option value="debuff">Debuff</option></select>}<select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={effectMode} onChange={e => setEffectMode(e.target.value as "percent" | "fixed")}><option value="percent">Porcentagem</option><option value="fixed">Pontos fixos</option></select></>}
          {(effectType === "status" || effectType === "regeneration" || effectType === "damage_dealt" || effectType === "damage_reduction") && <label className="col-span-2 space-y-1 text-xs font-medium"><span>Valor do efeito ({effectMode === "percent" ? "%" : effectType === "damage_dealt" ? "dano fixo" : effectType === "damage_reduction" ? "dano reduzido fixo" : "pontos fixos"})</span><Input aria-label="Valor do efeito em porcentagem ou pontos fixos" type="number" min="0" value={effectAmount} onChange={e => setEffectAmount(e.target.value)} /></label>}
          <label className="col-span-2 space-y-1 text-xs font-medium"><span>Duração (quantos turnos)</span><Input aria-label="Duração em turnos" type="number" min="1" value={effectDuration} onChange={e => setEffectDuration(e.target.value)} /></label>
          <p className="col-span-2 text-xs text-muted-foreground">Cada vez que qualquer turno for avançado, todos os efeitos ativos perdem 1 turno de duração.</p>
        </div>
        <Button size="sm" onClick={() => {
          const duration = Math.floor(Number(effectDuration));
          const amount = Number(effectAmount);
          const needsAttribute = effectType === "status" || effectType === "regeneration";
          const needsAmount = needsAttribute || effectType === "damage_dealt" || effectType === "damage_reduction";
          if (!effectName.trim() || duration < 1 || !Number.isFinite(duration) || (needsAmount && (!Number.isFinite(amount) || amount < 0))) {
            toast.error("Preencha o nome, uma duração e um valor válidos.");
            return;
          }
          if (effectType === "damage_reduction" && reductionScope === "magical" && damageTypes.length === 0) {
            toast.error("Cadastre ao menos um tipo mágico antes de criar esta mitigação.");
            return;
          }
          onAddEffect({
            name: effectName.trim(),
            effect_type: effectType,
            attribute_key: needsAttribute ? effectAttr : null,
            damage_scope: effectType === "damage_dealt" ? effectDamageScope : "any",
            damage_reduction_scope: effectType === "damage_reduction" ? reductionScope : "physical",
            damage_reduction_type_id: null,
            damage_reduction_magic_level: null,
            damage_reduction_type_ids: effectType === "damage_reduction" && reductionScope === "magical" ? reductionTypeIds : null,
            damage_reduction_magic_levels: effectType === "damage_reduction" && reductionScope === "magical" ? reductionMagicLevels : null,
            polarity: effectType === "magic_prohibition" || effectType === "no_mana" ? "debuff" : effectType === "damage_reduction" ? "buff" : effectPolarity,
            value_mode: effectType === "magic_prohibition" || effectType === "no_mana" ? "fixed" : effectMode,
            amount: needsAmount ? amount : 0,
            duration,
            duration_scope: "global",
          });
          setEffectName("");
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
  const { data: all } = useQuery({
    queryKey: ["characters-min"],
    queryFn: async () => {
      const { data, error } = await supabase.from("characters").select("id,name").order("name");
      if (error) throw error;
      return data;
    },
  });
  const inIds = new Set(fighters.map((f) => f.id));
  const refresh = () => qc.invalidateQueries({ queryKey: ["battles"] });
  async function add(id: string) {
    const { error } = await supabase.from("battle_participants").insert({ battle_id: battle.id, character_id: id, sort_order: fighters.length });
    if (error) toast.error(error.message);
    refresh();
  }
  async function remove(id: string) {
    const { error } = await supabase.from("battle_participants").delete().eq("battle_id", battle.id).eq("character_id", id);
    if (error) toast.error(error.message);
    if (battle.current_character_id === id || battle.target_character_id === id)
      await supabase.from("battles").update({
        current_character_id: battle.current_character_id === id ? null : battle.current_character_id,
        target_character_id: battle.target_character_id === id ? null : battle.target_character_id,
      }).eq("id", battle.id);
    refresh();
  }
  async function del() {
    if (!confirm("Excluir esta batalha?")) return;
    const { error } = await supabase.from("battles").delete().eq("id", battle.id);
    if (error) toast.error(error.message);
    refresh();
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
      <div>
        <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Fichas na batalha (clique para adicionar/remover)</div>
        <div className="flex flex-wrap gap-2">
          {(all ?? []).map((c) => (
            <Button key={c.id} size="sm" variant={inIds.has(c.id) ? "default" : "outline"} onClick={() => (inIds.has(c.id) ? remove(c.id) : add(c.id))}>
              {c.name}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}


type Roll = { title: string; lines: { who: string; dice: string; detail: string }[] };

function Actions({ battleId, actor, targets, fighters, defs, val }: {
  battleId: string;
  actor: Fighter;
  targets: Fighter[];
  fighters: Fighter[];
  defs: AttributeDef[];
  val: (f: Fighter, k: string) => number;
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
      return [
        {
          who: `${actor.name} → ${target.name} (ataque)`,
          dice: dice(diceMod(aAtk, tSpeed)),
          detail: `(${label("atk_speed")} ${aAtk} − ${label("speed")} ${tSpeed}) ÷ 10`,
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
          {targets.map((target) => <DamageApplier key={target.id} target={target} battleId={battleId} sources={fighters.filter((fighter) => fighter.id !== target.id).map((fighter) => ({ id: fighter.id, name: fighter.name }))} />)}
        </div>
      )}
    </div>
  );
}
