import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ChevronsDown, ChevronsUp, Plus, Search, UserRound, UsersRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useCharacter, useCharacterLive, useDefs, useMe, type Character } from "@/lib/sheets";
import { CharacterSheetView, Portrait } from "@/components/sheet/CharacterSheetView";
import { StatBar } from "@/components/sheet/StatBar";
import { PointsDistribution } from "@/components/sheet/PointsDistribution";
import { PhysicalPointsDistribution } from "@/components/sheet/PhysicalPointsDistribution";
import { CharacterOriginOverview } from "@/components/sheet/CharacterOriginOverview";
import { CharacterAbilitiesPanel } from "@/components/abilities/CharacterAbilities";
import { SummonGrantsEditor } from "@/components/summons/Summons";
import { CharacterTransformationImages } from "@/components/transformations/CharacterTransformationImages";
import { groupCharactersByAccount } from "@/lib/group-characters-by-account";

export const Route = createFileRoute("/_authenticated/painel")({
  head: () => ({
    meta: [
      { title: "Painel — Grimório" },
      { name: "description", content: "Suas fichas de personagem." },
      { property: "og:title", content: "Painel — Grimório" },
      { property: "og:description", content: "Suas fichas de personagem." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Painel,
});

function Painel() {
  const { data: me, isLoading } = useMe();
  if (isLoading || !me) return <p className="text-muted-foreground">Carregando…</p>;
  return me.isMaster ? <MasterDashboard /> : <PlayerView userId={me.user.id} />;
}

function PlayerView({ userId }: { userId: string }) {
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const { data: mine = [], isLoading, error } = useQuery({
    queryKey: ["my-character", userId],
    queryFn: async () => {
      const { data, error } = await supabase.from("characters")
        .select("id,name,player_name")
        .eq("owner_id", userId)
        .eq("is_summon_snapshot", false)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  if (isLoading) return <p className="text-muted-foreground">Carregando…</p>;
  if (error) {
    return (
      <div className="panel mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl text-gold">Não foi possível carregar sua ficha</h1>
        <p className="mt-2 text-sm text-muted-foreground">Tente atualizar a página. Se o problema continuar, avise o mestre.</p>
      </div>
    );
  }
  if (mine.length === 0)
    return (
      <div className="panel mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl text-gold">Nenhuma ficha vinculada</h1>
        <p className="mt-2 text-sm text-muted-foreground">Peça ao mestre para vincular seu personagem à sua conta.</p>
      </div>
    );
  const selected = mine.find((character) => character.id === selectedCharacterId) ?? mine[0];
  return (
    <div className="min-w-0 space-y-5">
      {mine.length > 1 && (
        <section className="panel space-y-3 border-gold/30 p-3 sm:p-4" aria-label="Selecionar minha ficha">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-lg font-bold text-gold">Minhas fichas</h2>
            <span className="rounded-full border border-gold/25 px-3 py-1 text-xs text-muted-foreground">
              {mine.length} personagens vinculados
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {mine.map((character) => (
              <button key={character.id} type="button" aria-pressed={character.id === selected.id}
                className={character.id === selected.id
                  ? "min-h-14 min-w-0 rounded-xl border border-gold bg-gold/15 p-3 text-left shadow-[0_0_0_1px_rgba(231,183,93,.15)]"
                  : "min-h-14 min-w-0 rounded-xl border border-gold/20 bg-background/40 p-3 text-left transition-colors hover:border-gold/60"}
                onClick={() => setSelectedCharacterId(character.id)}>
                <span className="block truncate text-sm font-semibold text-gold">{character.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{character.player_name || "Personagem"}</span>
              </button>
            ))}
          </div>
          <Link to="/ficha/$id" params={{ id: selected.id }}
            className="inline-flex min-h-10 items-center text-sm font-medium text-gold underline underline-offset-4">
            Abrir ficha completa de {selected.name}
          </Link>
        </section>
      )}
      <PlayerSheet key={selected.id} id={selected.id} />
    </div>
  );
}

function PlayerSheet({ id }: { id: string }) {
  const { data } = useCharacter(id);
  const { data: defs } = useDefs();
  useCharacterLive(id);
  if (!data?.character || !defs) return <p className="text-muted-foreground">Carregando…</p>;
  return (
    <div className="space-y-6">
      <CharacterOriginOverview character={data.character} />
      <CharacterTransformationImages character={data.character} />
      <SummonGrantsEditor characterId={data.character.id} master={false} />
      <CharacterAbilitiesPanel characterId={data.character.id} characterName={data.character.name} mode="sheet" canUse />
      <CharacterSheetView character={data.character} attrs={data.attrs} defs={defs} />
      <PhysicalPointsDistribution character={data.character} attrs={data.attrs} defs={defs} />
      {data.character.available_points > 0 && (
        <PointsDistribution character={data.character} attrs={data.attrs} defs={defs} />
      )}
    </div>
  );
}

type DashboardCharacter = Pick<Character,
  "id" | "name" | "player_name" | "owner_id" | "photo_path" |
  "body" | "sanity" | "available_points" | "kills"
> & {
  character_attributes: Array<{ attribute_key: string; current_value: number | null }>;
};

type CharacterMaximum = { character_id: string; hp_max: number; mana_max: number };

function MasterDashboard() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  // Keep the library compact initially; any group can be opened independently.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const { data: defs } = useDefs();
  const {
    data: resourceMaxima = [],
    isLoading: maximaLoading,
    error: maximaError,
  } = useQuery<CharacterMaximum[]>({
    queryKey: ["master-character-resource-maxima"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("list_character_resource_maxima");
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 8000,
    refetchOnWindowFocus: true,
  });
  const maximaByCharacter = useMemo(
    () => new Map(resourceMaxima.map((item) => [item.character_id, item])),
    [resourceMaxima],
  );
  const { data: list = [], isLoading } = useQuery({
    queryKey: ["characters"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("characters")
        .select("*, character_attributes(attribute_key,current_value,max_value,points,bonus)")
        .eq("is_summon_snapshot", false)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 8000,
    refetchOnWindowFocus: true,
  });

  // Profiles are fetched only for accounts actually attached to a character.
  // The master can see the real account email; player_name is just a label.
  const ownerIds = useMemo(
    () => [...new Set(list.map((character) => character.owner_id)
      .filter((id): id is string => !!id))].sort(),
    [list],
  );
  const {
    data: profiles = [],
    isLoading: profilesLoading,
    error: profilesError,
  } = useQuery({
    queryKey: ["master-character-owner-profiles", ownerIds],
    enabled: ownerIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles")
        .select("id,email,display_name")
        .in("id", ownerIds);
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });
  const groups = useMemo(
    () => groupCharactersByAccount(list, profiles, q),
    [list, profiles, q],
  );
  // Searching by character, player, registered name or email reveals matching
  // cards even when their groups were previously collapsed.
  useEffect(() => {
    if (!q.trim()) return;
    setExpandedGroups((current) => {
      const next = new Set(current);
      for (const group of groups) next.add(group.id);
      return next;
    });
  }, [q, groups]);

  const toggleGroup = (id: string) => setExpandedGroups((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  async function create() {
    const { data, error } = await supabase.from("characters").insert({ name: "Novo personagem" }).select("id").single();
    if (error || !data) { toast.error("Não foi possível criar a ficha"); return; }
    if (defs?.length) {
      await supabase.from("character_attributes").insert(
        defs.map((d) => ({ character_id: data.id, attribute_key: d.key, current_value: 0, max_value: 0 })),
      );
    }
    navigate({ to: "/ficha/$id", params: { id: data.id } });
  }

  const allExpanded = groups.length > 0 && groups.every((group) => expandedGroups.has(group.id));

  return (
    <div className="space-y-6">
      <div className="grimorio-section-header flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[.21em] text-muted-foreground">Biblioteca de personagens</p>
          <h1 className="text-3xl text-gold">Fichas da campanha</h1>
        </div>
        <Button onClick={create}>
          <Plus className="mr-1 h-4 w-4" /> Nova ficha
        </Button>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Buscar ficha, jogador ou e-mail"
            className="pl-9"
            placeholder="Buscar personagem, jogador ou e-mail"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs text-muted-foreground">
            {groups.reduce((sum, group) => sum + group.characters.length, 0)} fichas · {groups.length} categorias
          </span>
          <Button type="button" variant="outline" size="sm" className="min-h-10"
            disabled={groups.length === 0 || allExpanded}
            onClick={() => setExpandedGroups((current) => new Set([...current, ...groups.map((group) => group.id)]))}>
            <ChevronsDown className="mr-1.5 h-4 w-4" /> Expandir todas
          </Button>
          <Button type="button" variant="outline" size="sm" className="min-h-10"
            disabled={groups.length === 0 || !groups.some((group) => expandedGroups.has(group.id))}
            onClick={() => setExpandedGroups(new Set())}>
            <ChevronsUp className="mr-1.5 h-4 w-4" /> Recolher todas
          </Button>
        </div>
      </div>
      {maximaError ? (
        <p role="alert" className="text-destructive">
          Não foi possível consultar a Mana e o HP máximos: {maximaError.message}
        </p>
      ) : isLoading || maximaLoading || (ownerIds.length > 0 && profilesLoading) ? (
        <p className="text-muted-foreground">Carregando fichas e contas vinculadas…</p>
      ) : (
        <>
          {profilesError && (
            <p role="alert" className="text-sm text-destructive">
              Não foi possível carregar os e-mails vinculados: {profilesError.message}
            </p>
          )}
          {groups.length === 0 ? (
            <p className="text-muted-foreground">Nenhuma ficha encontrada.</p>
          ) : (
            <div className="space-y-3">
              {groups.map((group) => {
                const expanded = expandedGroups.has(group.id);
                const title = group.isNpc ? "NPCs" : group.email ?? "Conta vinculada";
                const subtitle = group.isNpc
                  ? "Personagens sem conta de jogador vinculada"
                  : group.displayName ?? (group.email ? "Conta do jogador" : "E-mail indisponível");
                return (
                  <section key={group.id} className="panel min-w-0 overflow-hidden border-gold/25"
                    aria-label={group.isNpc ? "Fichas de NPCs" : `Fichas de ${title}`}>
                    <button type="button"
                      aria-expanded={expanded}
                      onClick={() => toggleGroup(group.id)}
                      className="flex min-h-16 w-full items-center gap-3 p-3 text-left transition-colors hover:bg-gold/5 sm:p-4">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-gold/25 bg-gold/10 text-gold">
                        {group.isNpc ? <UsersRound className="h-5 w-5" /> : <UserRound className="h-5 w-5" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block break-all font-display text-base font-semibold text-gold sm:text-lg">{title}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{subtitle}</span>
                      </span>
                      <span className="shrink-0 rounded-full border border-gold/20 bg-background/50 px-2.5 py-1 text-xs tabular-nums text-muted-foreground">
                        {group.characters.length} ficha{group.characters.length === 1 ? "" : "s"}
                      </span>
                      {expanded
                        ? <ChevronDown className="h-5 w-5 shrink-0 text-gold" />
                        : <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />}
                    </button>
                    {expanded && (
                      <div className="grid gap-3 border-t border-gold/20 p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-3">
                        {group.characters.map((character) => (
                          <CharacterLibraryCard
                            key={character.id}
                            character={character}
                            maximaByCharacter={maximaByCharacter}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CharacterLibraryCard({ character: c, maximaByCharacter }: {
  character: DashboardCharacter;
  maximaByCharacter: Map<string, CharacterMaximum>;
}) {
  const hp = c.character_attributes.find((attribute) => attribute.attribute_key === "hp");
  const mana = c.character_attributes.find((attribute) => attribute.attribute_key === "mana");
  const maxima = maximaByCharacter.get(c.id);
  const hpMax = Number(maxima?.hp_max ?? 0);
  const manaMax = Number(maxima?.mana_max ?? 0);
  return (
    <Link
      to="/ficha/$id"
      params={{ id: c.id }}
      className="grimorio-profile-card panel flex min-w-0 gap-3 p-3 transition-all duration-200 hover:-translate-y-0.5 sm:gap-4 sm:p-4"
    >
      <Portrait path={c.photo_path} name={c.name} className="h-20 w-16 shrink-0 sm:h-24 sm:w-20" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="truncate font-display text-lg text-gold">{c.name}</div>
        <div className="truncate text-xs text-muted-foreground">{c.player_name || "Sem jogador"}</div>
        <MiniBar label="HP" cur={hp?.current_value ?? 0} max={hpMax} tone="bg-blood" />
        <MiniBar label="Mana" cur={mana?.current_value ?? 0} max={manaMax} tone="bg-arcane" />
        <div className="tabular text-xs text-muted-foreground">
          Corpo {c.body}% · Sanidade {c.sanity}% · {c.available_points} pt{c.available_points === 1 ? "" : "s"} · {c.kills} abate{c.kills === 1 ? "" : "s"}
        </div>
      </div>
    </Link>
  );
}

function MiniBar({ label, cur, max, tone }: { label: string; cur: number; max: number; tone: string }) {
  return (
    <div>
      <div className="tabular flex justify-between text-xs"><span>{label}</span><span>{cur} / {max}</span></div>
      <StatBar value={cur} max={max} tone={tone} className="h-1.5" />
    </div>
  );
}
