import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Clock3, Minus, Plus, Sparkles, Trash2, WandSparkles, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useDefs } from "@/lib/sheets";
import { parseAbilityEffects, useAbilities, useCharacterAbilities, type Ability, type AbilityEffectDefinition, type CharacterAbility } from "@/lib/abilities";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import type { Json } from "@/integrations/supabase/types";

type TargetOption = { id: string; name: string };

function effectSummary(effect: AbilityEffectDefinition, defs: NonNullable<ReturnType<typeof useDefs>["data"]>) {
  const amount = effect.value_mode === "percent" ? `${effect.amount}%` : `${effect.amount} pontos`;
  const polarity = effect.polarity === "buff" ? "+" : "−";
  if (effect.effect_type === "status") return `${effect.name}: ${polarity}${amount} em ${defs.find((d) => d.key === effect.attribute_key)?.label ?? effect.attribute_key}`;
  if (effect.effect_type === "regeneration") return `${effect.name}: regeneração ${polarity}${amount} de ${effect.attribute_key === "mana" ? "Mana" : "HP"}`;
  if (effect.effect_type === "no_regen_hp") return `${effect.name}: bloqueia regeneração de HP`;
  if (effect.effect_type === "no_regen_mana") return `${effect.name}: bloqueia regeneração de Mana`;
  return `${effect.name}: Stun (visual)`;
}

export function CharacterAbilitiesPanel({
  characterId, characterName, mode, canUse, battleId, targets = [],
}: {
  characterId: string;
  characterName: string;
  mode: "sheet" | "combat";
  canUse: boolean;
  battleId?: string;
  targets?: TargetOption[];
}) {
  const qc = useQueryClient();
  const { data: loadout, isLoading } = useCharacterAbilities(characterId);
  const { data: defs } = useDefs();
  const [targetId, setTargetId] = useState(characterId);
  const [busyId, setBusyId] = useState<string | null>(null);
  const targetOptions = useMemo(() => [
    { id: characterId, name: `${characterName} (si mesmo)` },
    ...targets.filter((target) => target.id !== characterId),
  ], [characterId, characterName, targets]);

  useEffect(() => {
    setTargetId(characterId);
  }, [characterId]);

  async function activate(ability: CharacterAbility) {
    if (!canUse || ability.is_passive || ability.cooldown_turns <= 0 || ability.cooldown_remaining > 0 || busyId) return;
    setBusyId(ability.id);
    const { error } = await supabase.rpc("activate_character_ability", {
      _character_ability_id: ability.id,
      _target_character_id: targetId || characterId,
      _battle_id: mode === "combat" ? battleId ?? null : null,
    });
    setBusyId(null);
    if (error) { toast.error(error.message); return; }
    toast.success(`${ability.name} ativada!${ability.mana_cost > 0 ? ` Mana gasta: ${ability.mana_cost}.` : ""}`);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["character-abilities", characterId] }),
      qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
      qc.invalidateQueries({ queryKey: ["battle-effects"] }),
      qc.invalidateQueries({ queryKey: ["battles"] }),
      qc.invalidateQueries({ queryKey: ["character", characterId] }),
    ]);
  }

  if (isLoading) return null;
  if (!loadout?.length) return null;

  return (
    <section className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-gold">
        <WandSparkles className="h-4 w-4" /> Habilidades
      </div>
      {mode === "combat" && canUse && targetOptions.length > 1 && (
        <label className="block space-y-1 text-xs">
          <span className="font-medium text-muted-foreground">Alvo da próxima habilidade</span>
          <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {targetOptions.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
          </select>
        </label>
      )}
      <div className="space-y-2">
        {loadout.map((ability) => (
          <article key={ability.id} className="rounded-md border border-border bg-muted/20 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{ability.name}</div>
                {ability.description && <p className="mt-1 text-xs text-muted-foreground">{ability.description}</p>}
                <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                  {ability.is_passive ? (
                    <span className="rounded bg-gold/10 px-2 py-1 text-gold"><Sparkles className="mr-1 inline h-3 w-3" /> Passiva · permanente</span>
                  ) : (
                    <span className={`rounded px-2 py-1 ${ability.cooldown_remaining > 0 ? "bg-muted text-muted-foreground" : "bg-emerald-500/10 text-emerald-500"}`}>
                      <Clock3 className="mr-1 inline h-3 w-3" /> {ability.cooldown_remaining > 0 ? `Cooldown: ${ability.cooldown_remaining} turno(s)` : "Pronta para usar"}
                    </span>
                  )}
                  {ability.mana_cost > 0 && <span className="rounded bg-muted px-2 py-1">Custo: {ability.mana_cost} Mana</span>}
                  {!ability.mana_cost && !ability.is_passive && <span className="rounded bg-muted px-2 py-1">Sem custo de Mana</span>}
                </div>
              </div>
              {canUse && !ability.is_passive && (
                <Button size="sm" disabled={busyId !== null || ability.cooldown_turns <= 0 || ability.cooldown_remaining > 0} onClick={() => void activate(ability)}>
                  <Zap className="mr-1 h-3.5 w-3.5" /> {busyId === ability.id ? "Ativando..." : "Ativar"}
                </Button>
              )}
            </div>
            {ability.effects.length > 0 && (
              <ul className="mt-2 space-y-1 border-t border-border pt-2 text-xs text-muted-foreground">
                {ability.effects.map((effect, index) => (
                  <li key={index}>{effectSummary(effect, defs ?? [])}{ability.is_passive ? " · permanente" : ` · ${effect.duration} turno(s)`}</li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

export function CharacterAbilitiesManager({ characterId }: { characterId: string }) {
  const qc = useQueryClient();
  const { data: allAbilities = [], isLoading: catalogLoading } = useAbilities();
  const { data: assigned = [], isLoading: assignedLoading } = useCharacterAbilities(characterId);
  const { data: defs } = useDefs();
  const assignedIds = new Set(assigned.map((ability) => ability.ability_id));
  const available = allAbilities.filter((ability) => !assignedIds.has(ability.id));

  async function give(ability: Ability) {
    const { error } = await supabase.from("character_abilities").insert({
      character_id: characterId,
      ability_id: ability.id,
      name: ability.name,
      description: ability.description,
      is_passive: ability.is_passive,
      cooldown_turns: ability.is_passive ? 0 : ability.cooldown_turns,
      cooldown_remaining: 0,
      mana_cost: ability.mana_cost,
      effects: ability.effects,
    });
    if (error) { toast.error(error.message); return; }
    toast.success(`${ability.name} adicionada à ficha`);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["character-abilities", characterId] }),
      qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
    ]);
  }

  if (!defs) return null;
  return (
    <section className="panel space-y-4 p-4 sm:p-5">
      <div>
        <h2 className="flex items-center gap-2 text-lg text-gold"><WandSparkles className="h-5 w-5" /> Habilidades da ficha</h2>
        <p className="mt-1 text-xs text-muted-foreground">Adicione habilidades do catálogo. Depois, personalize custo, cooldown e efeitos para este personagem.</p>
      </div>
      {catalogLoading || assignedLoading ? <p className="text-sm text-muted-foreground">Carregando habilidades…</p> : available.length > 0 ? (
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
      ) : (
        <p className="text-xs text-muted-foreground">{allAbilities.length ? "Todas as habilidades do catálogo já foram atribuídas." : "O mestre ainda não cadastrou habilidades."}</p>
      )}
      <div className="space-y-3">
        {assigned.map((ability) => <AssignedAbilityEditor key={ability.id} ability={ability} defs={defs} />)}
      </div>
    </section>
  );
}

function AssignedAbilityEditor({ ability, defs }: { ability: CharacterAbility; defs: NonNullable<ReturnType<typeof useDefs>["data"]> }) {
  const qc = useQueryClient();
  const [name, setName] = useState(ability.name);
  const [description, setDescription] = useState(ability.description ?? "");
  const [isPassive, setIsPassive] = useState(ability.is_passive);
  const [cooldown, setCooldown] = useState(String(ability.cooldown_turns));
  const [manaCost, setManaCost] = useState(String(ability.mana_cost));
  const [effects, setEffects] = useState<AbilityEffectDefinition[]>(ability.effects);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(ability.name);
    setDescription(ability.description ?? "");
    setIsPassive(ability.is_passive);
    setCooldown(String(ability.cooldown_turns));
    setManaCost(String(ability.mana_cost));
    setEffects(parseAbilityEffects(ability.effects));
  }, [ability]);

  async function save() {
    const cooldownTurns = isPassive ? 0 : Math.floor(Number(cooldown));
    const cost = Math.floor(Number(manaCost));
    if (!name.trim()) { toast.error("Informe o nome"); return; }
    if (!Number.isFinite(cost) || cost < 0) { toast.error("Custo de Mana inválido"); return; }
    if (!isPassive && (!Number.isFinite(cooldownTurns) || cooldownTurns < 1)) { toast.error("Habilidade ativa precisa ter cooldown de pelo menos 1 turno"); return; }
    setBusy(true);
    const { error } = await supabase.from("character_abilities").update({
      name: name.trim(),
      description: description.trim() || null,
      is_passive: isPassive,
      cooldown_turns: cooldownTurns,
      cooldown_remaining: isPassive ? 0 : Math.min(ability.cooldown_remaining, cooldownTurns),
      mana_cost: cost,
      effects: effects.map((effect) => ({ ...effect, duration: Math.max(1, effect.duration) })) as unknown as Json,
    }).eq("id", ability.id);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Habilidade desta ficha atualizada");
    await qc.invalidateQueries({ queryKey: ["character-abilities", ability.character_id] });
    await qc.invalidateQueries({ queryKey: ["character-abilities-battle"] });
  }

  async function setCooldownRemaining(next: number) {
    const value = Math.max(0, Math.min(ability.cooldown_turns, Math.floor(next)));
    const { error } = await supabase.from("character_abilities").update({ cooldown_remaining: value }).eq("id", ability.id);
    if (error) { toast.error(error.message); return; }
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
    toast.success("Habilidade removida da ficha");
  }

  return (
    <article className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><div className="font-semibold">{ability.name}</div><div className="text-xs text-muted-foreground">{ability.is_passive ? "Passiva" : `Cooldown atual: ${ability.cooldown_remaining}/${ability.cooldown_turns}`}</div></div>
        <Button size="icon" variant="ghost" aria-label="Remover habilidade desta ficha" onClick={() => void remove()}><Trash2 className="h-4 w-4" /></Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1"><Label>Nome nesta ficha</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="space-y-1"><Label>Custo de Mana</Label><Input type="number" min="0" value={manaCost} onChange={(e) => setManaCost(e.target.value)} /></div>
        {!isPassive && <div className="space-y-1"><Label>Cooldown máximo (turnos)</Label><Input type="number" min="1" value={cooldown} onChange={(e) => setCooldown(e.target.value)} /></div>}
        <div className="space-y-1 sm:col-span-2"><Label>Descrição para este jogador</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      </div>
      <AbilityEffectsEditor effects={effects} onChange={setEffects} isPassive={isPassive} defs={defs} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void save()}>{busy ? "Salvando..." : "Salvar valores desta ficha"}</Button>
        {!ability.is_passive && ability.cooldown_remaining > 0 && <Button size="sm" variant="outline" onClick={() => void setCooldownRemaining(Math.max(0, ability.cooldown_remaining - 1))}><Minus className="mr-1 h-3.5 w-3.5" /> Reduzir cooldown</Button>}
        {!ability.is_passive && ability.cooldown_remaining > 0 && <Button size="sm" variant="outline" onClick={() => void setCooldownRemaining(0)}><Check className="mr-1 h-3.5 w-3.5" /> Zerar cooldown</Button>}
      </div>
    </article>
  );
}
