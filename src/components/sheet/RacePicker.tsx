import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Shield, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { traitMods, useDefs, useRaces, useVirtues, type AttributeDef, type Character, type Trait } from "@/lib/sheets";
import { useAbilities } from "@/lib/abilities";

export function ModsList({ race, defs, abilities = [] }: {
  race: Trait;
  defs: AttributeDef[];
  abilities?: { id: string; name: string }[];
}) {
  const mods = traitMods(race);
  const entries = defs.filter((d) => mods[d.key]);
  const body = mods.body ?? 0;
  const sanity = mods.sanity ?? 0;
  return (
    <div className="flex flex-wrap gap-1.5 text-xs">
      {entries.map((d) => (
        <span key={d.key} className={`tabular rounded px-2 py-0.5 bg-muted ${(mods[d.key] ?? 0) > 0 ? "text-gold" : "text-destructive"}`}>
          {(mods[d.key] ?? 0) > 0 ? "+" : ""}{mods[d.key]} {d.label}
        </span>
      ))}
      {body !== 0 && (
        <span className={`tabular rounded bg-muted px-2 py-0.5 ${body < 0 ? "text-destructive" : "text-gold"}`}>
          {body > 0 ? "+" : ""}{body}% Corpo inicial
        </span>
      )}
      {sanity !== 0 && (
        <span className={`tabular rounded bg-muted px-2 py-0.5 ${sanity < 0 ? "text-destructive" : "text-gold"}`}>
          {sanity > 0 ? "+" : ""}{sanity}% Sanidade inicial
        </span>
      )}
      {race.physical_bonus_points > 0 && (
        <span className="tabular rounded bg-muted px-2 py-0.5 text-gold">+{race.physical_bonus_points} pontos físicos</span>
      )}
      {race.bonus_points > 0 && (
        <span className="tabular rounded bg-muted px-2 py-0.5 text-gold">+{race.bonus_points} pontos livres</span>
      )}
      {abilities.map((ability) => (
        <span key={ability.id} className="rounded bg-gold/10 px-2 py-0.5 text-gold">
          Habilidade inicial: {ability.name}
        </span>
      ))}
      {!entries.length && body === 0 && sanity === 0 && !race.bonus_points && !race.physical_bonus_points && !abilities.length && (
        <span className="text-muted-foreground">Sem modificadores</span>
      )}
    </div>
  );
}

/** The player drafts both traits locally, then confirms them in one database transaction. */
export function RacePicker({ character, isMaster }: { character: Character; isMaster: boolean }) {
  const qc = useQueryClient();
  const { data: races } = useRaces();
  const { data: virtues } = useVirtues();
  const { data: defs } = useDefs();
  const { data: abilities = [] } = useAbilities();
  const { data: raceAbilityRows = [] } = useQuery({
    queryKey: ["race-abilities"],
    queryFn: async () => {
      const { data, error } = await supabase.from("race_abilities").select("race_id,ability_id");
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: virtueAbilityRows = [] } = useQuery({
    queryKey: ["virtue-abilities-picker"],
    queryFn: async () => {
      const { data, error } = await supabase.from("virtue_abilities").select("virtue_id,ability_id");
      if (error) throw error;
      return data ?? [];
    },
  });
  const [busy, setBusy] = useState<"race" | "virtue" | null>(null);
  const [pendingRaceId, setPendingRaceId] = useState<string | null>(character.race_id);
  const [pendingVirtueId, setPendingVirtueId] = useState<string | null>(character.virtue_id);

  useEffect(() => {
    setPendingRaceId(character.race_id);
    setPendingVirtueId(character.virtue_id);
  }, [character.id, character.race_id, character.virtue_id]);

  if (!races || !virtues || !defs) return null;
  // Once a player has both traits, the GM is the only one allowed to change them.
  if (!isMaster && character.race_id && character.virtue_id) return null;

  async function refreshAfterConfirmation(message: string) {
    toast.success(message);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["character", character.id] }),
      qc.invalidateQueries({ queryKey: ["characters"] }),
      qc.invalidateQueries({ queryKey: ["my-character"] }),
      qc.invalidateQueries({ queryKey: ["character-abilities", character.id] }),
      qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
    ]);
    setBusy(null);
  }

  async function confirmRace() {
    if (!isMaster && !pendingRaceId) {
      toast.error("Selecione uma raça antes de confirmar");
      return;
    }
    if (pendingRaceId === character.race_id) return;

    setBusy("race");
    const { error } = await supabase.rpc("choose_character_race", {
      _character_id: character.id,
      _race_id: pendingRaceId,
    });
    if (error) {
      toast.error(error.message);
      setBusy(null);
      return;
    }
    await refreshAfterConfirmation("Raça confirmada!");
  }

  async function confirmVirtue() {
    if (!isMaster && !character.race_id) {
      toast.error("Confirme sua raça antes de escolher a virtude");
      return;
    }
    if (!isMaster && !pendingVirtueId) {
      toast.error("Selecione uma virtude antes de confirmar");
      return;
    }
    if (pendingVirtueId === character.virtue_id) return;

    setBusy("virtue");
    const { error } = await supabase.rpc("choose_character_virtue", {
      _character_id: character.id,
      _virtue_id: pendingVirtueId,
    });
    if (error) {
      toast.error(error.message);
      setBusy(null);
      return;
    }
    await refreshAfterConfirmation("Virtude confirmada!");
  }

  const raceOptions = races.length === 0;
  const virtueOptions = virtues.length === 0;

  return (
    <section className="panel space-y-5 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="rounded-lg bg-gold/10 p-2 text-gold"><Shield className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg text-gold">{isMaster ? "Raça e Virtude da ficha" : "Escolha sua Raça e Virtude"}</h2>
          <p className="text-xs text-muted-foreground">
            Confirme a Raça e a Virtude separadamente. Cada escolha é salva de forma independente.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">1. Raça</h3>
          <div className="flex items-center gap-2">
            {isMaster && pendingRaceId && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setPendingRaceId(null)}>Nenhuma</Button>}
            <Button size="sm" disabled={busy !== null || pendingRaceId === character.race_id || (!isMaster && !pendingRaceId) || (raceOptions && !pendingRaceId)} onClick={() => void confirmRace()}>
              <Check className="mr-1 h-3.5 w-3.5" /> {busy === "race" ? "Confirmando..." : "Confirmar raça"}
            </Button>
          </div>
        </div>
        {raceOptions ? <p className="text-sm text-muted-foreground">Nenhuma raça cadastrada ainda.</p> : (
          <div className="grid gap-3 sm:grid-cols-2">
            {races.map((race) => {
              const selected = pendingRaceId === race.id;
              const lockedForPlayer = !isMaster && !!character.race_id && race.id !== character.race_id;
              return (
                <article key={race.id} className={`rounded-lg border p-3 transition-colors ${selected ? "border-gold bg-gold/5" : "border-border"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold">{race.name}</div>
                      {race.description && <p className="mt-1 text-xs text-muted-foreground">{race.description}</p>}
                    </div>
                    <Button size="sm" variant={selected ? "default" : "outline"} className="shrink-0" disabled={busy !== null || lockedForPlayer} onClick={() => setPendingRaceId(race.id)}>
                      {selected ? <><Check className="mr-1 h-3.5 w-3.5" /> Selecionada</> : "Selecionar"}
                    </Button>
                  </div>
                  <div className="mt-2"><ModsList
                    race={race}
                    defs={defs}
                    abilities={abilities.filter((ability) => raceAbilityRows.some((row) => row.race_id === race.id && row.ability_id === ability.id))}
                  /></div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-gold" /> 2. Virtude</h3>
          <div className="flex items-center gap-2">
            {isMaster && pendingVirtueId && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setPendingVirtueId(null)}>Nenhuma</Button>}
            <Button size="sm" disabled={busy !== null || pendingVirtueId === character.virtue_id || (!isMaster && (!pendingVirtueId || !character.race_id)) || (virtueOptions && !pendingVirtueId)} onClick={() => void confirmVirtue()}>
              <Check className="mr-1 h-3.5 w-3.5" /> {busy === "virtue" ? "Confirmando..." : "Confirmar virtude"}
            </Button>
          </div>
        </div>
        {virtueOptions ? <p className="text-sm text-muted-foreground">Nenhuma virtude cadastrada ainda. Peça ao mestre para cadastrar uma.</p> : (
          <div className="grid gap-3 sm:grid-cols-2">
            {virtues.map((virtue) => {
              const selected = pendingVirtueId === virtue.id;
              const lockedForPlayer = !isMaster && !!character.virtue_id && virtue.id !== character.virtue_id;
              return (
                <article key={virtue.id} className={`rounded-lg border p-3 transition-colors ${selected ? "border-gold bg-gold/5" : "border-border"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold">{virtue.name}</div>
                      {virtue.description && <p className="mt-1 text-xs text-muted-foreground">{virtue.description}</p>}
                    </div>
                    <Button size="sm" variant={selected ? "default" : "outline"} className="shrink-0" disabled={busy || lockedForPlayer} onClick={() => setPendingVirtueId(virtue.id)}>
                      {selected ? <><Check className="mr-1 h-3.5 w-3.5" /> Selecionada</> : "Selecionar"}
                    </Button>
                  </div>
                  <div className="mt-2"><ModsList
                    race={virtue}
                    defs={defs}
                    abilities={abilities.filter((ability) => virtueAbilityRows.some((row) => row.virtue_id === virtue.id && row.ability_id === ability.id))}
                  /></div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <div className="border-t border-border pt-4 text-xs text-muted-foreground">
        Selecione e confirme a Raça no bloco acima e confirme a Virtude separadamente. Confirmar a Virtude não altera os pontos concedidos pela Raça.
      </div>
    </section>
  );
}
