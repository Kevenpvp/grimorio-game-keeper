import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useCharacter, useCharacterLive, useDefs, useMe } from "@/lib/sheets";
import { CharacterSheetView, Portrait } from "@/components/sheet/CharacterSheetView";
import { StatBar } from "@/components/sheet/StatBar";
import { PointsDistribution } from "@/components/sheet/PointsDistribution";
import { PhysicalPointsDistribution } from "@/components/sheet/PhysicalPointsDistribution";
import { CharacterOriginOverview } from "@/components/sheet/CharacterOriginOverview";
import { CharacterAbilitiesPanel } from "@/components/abilities/CharacterAbilities";
import { SummonGrantsEditor } from "@/components/summons/Summons";
import { CharacterTransformationImages } from "@/components/transformations/CharacterTransformationImages";

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

function MasterDashboard() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const { data: defs } = useDefs();
  // Get the exact effective maximum from the server, rather than duplicating
  // RPG modifiers incompletely in the small dashboard cards.
  const {
    data: resourceMaxima = [],
    isLoading: maximaLoading,
    error: maximaError,
  } = useQuery<Array<{ character_id: string; hp_max: number; mana_max: number }>>({
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
  const { data: list, isLoading } = useQuery({
    queryKey: ["characters"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("characters")
        .select("*, character_attributes(attribute_key,current_value,max_value,points,bonus)")
        .eq("is_summon_snapshot", false)
        .order("name");
      if (error) throw error;
      return data;
    },
    refetchInterval: 8000,
    refetchOnWindowFocus: true,
  });

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return list ?? [];
    return (list ?? []).filter((c) => c.name.toLowerCase().includes(t) || c.player_name.toLowerCase().includes(t));
  }, [list, q]);

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

  return (
    <div className="space-y-6">
      <div className="grimorio-section-header flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><p className="text-[10px] font-semibold uppercase tracking-[.21em] text-muted-foreground">Biblioteca de personagens</p>
        <h1 className="text-3xl text-gold">Fichas da campanha</h1></div>
        <Button onClick={create}>
          <Plus className="mr-1 h-4 w-4" /> Nova ficha
        </Button>
      </div>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Buscar personagem ou jogador" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {maximaError ? (
        <p role="alert" className="text-destructive">Não foi possível consultar a Mana e o HP máximos: {maximaError.message}</p>
      ) : isLoading || maximaLoading ? (
        <p className="text-muted-foreground">Carregando…</p>
      ) : filtered.length === 0 ? (
        <p className="text-muted-foreground">Nenhuma ficha encontrada.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((c) => {
            const hp = c.character_attributes.find((a) => a.attribute_key === "hp");
            const mana = c.character_attributes.find((a) => a.attribute_key === "mana");
            const authoritativeMaxima = maximaByCharacter.get(c.id);
            const hpMax = Number(authoritativeMaxima?.hp_max ?? 0);
            const manaMax = Number(authoritativeMaxima?.mana_max ?? 0);
            return (
              <Link
                key={c.id}
                to="/ficha/$id"
                params={{ id: c.id }}
                className="grimorio-profile-card panel flex gap-4 p-4 transition-all duration-200 hover:-translate-y-0.5"
              >
                <Portrait path={c.photo_path} name={c.name} className="h-24 w-20 shrink-0" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="truncate font-display text-lg text-gold">{c.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{c.player_name || "Sem jogador"}</div>
                  <MiniBar label="HP" cur={hp?.current_value ?? 0} max={hpMax} tone="bg-blood" />
                  <MiniBar label="Mana" cur={mana?.current_value ?? 0} max={manaMax} tone="bg-arcane" />
                  <div className="tabular text-xs text-muted-foreground">Corpo {c.body}% · Sanidade {c.sanity}% · {c.available_points} pt{c.available_points === 1 ? "" : "s"} · {c.kills} abate{c.kills === 1 ? "" : "s"}</div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
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
