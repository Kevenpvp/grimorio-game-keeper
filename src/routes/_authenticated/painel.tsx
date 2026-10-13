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
  const { data: mine, isLoading } = useQuery({
    queryKey: ["my-character", userId],
    queryFn: async () => {
      const { data, error } = await supabase.from("characters").select("id").eq("owner_id", userId).limit(1).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  if (isLoading) return <p className="text-muted-foreground">Carregando…</p>;
  if (!mine)
    return (
      <div className="panel mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl text-gold">Nenhuma ficha vinculada</h1>
        <p className="mt-2 text-sm text-muted-foreground">Peça ao mestre para vincular seu personagem à sua conta.</p>
      </div>
    );
  return <PlayerSheet id={mine.id} />;
}

function PlayerSheet({ id }: { id: string }) {
  const { data } = useCharacter(id);
  const { data: defs } = useDefs();
  useCharacterLive(id);
  if (!data?.character || !defs) return <p className="text-muted-foreground">Carregando…</p>;
  return (
    <div className="space-y-6">
      <CharacterSheetView character={data.character} attrs={data.attrs} defs={defs} />
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
  const { data: list, isLoading } = useQuery({
    queryKey: ["characters"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("characters")
        .select("*, character_attributes(attribute_key,current_value,max_value,points)")
        .order("name");
      if (error) throw error;
      return data;
    },
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-3xl text-gold">Fichas da campanha</h1>
        <Button onClick={create}>
          <Plus className="mr-1 h-4 w-4" /> Nova ficha
        </Button>
      </div>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Buscar personagem ou jogador" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {isLoading ? (
        <p className="text-muted-foreground">Carregando…</p>
      ) : filtered.length === 0 ? (
        <p className="text-muted-foreground">Nenhuma ficha encontrada.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((c) => {
            const hp = c.character_attributes.find((a) => a.attribute_key === "hp");
            const mana = c.character_attributes.find((a) => a.attribute_key === "mana");
            return (
              <Link
                key={c.id}
                to="/ficha/$id"
                params={{ id: c.id }}
                className="panel flex gap-4 p-4 transition-transform hover:-translate-y-0.5 hover:border-gold/60"
              >
                <Portrait path={c.photo_path} name={c.name} className="h-24 w-20 shrink-0" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="truncate font-display text-lg text-gold">{c.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{c.player_name || "Sem jogador"}</div>
                  <MiniBar label="HP" cur={hp?.current_value ?? 0} max={hp?.max_value ?? 0} tone="bg-blood" />
                  <MiniBar label="Mana" cur={mana?.current_value ?? 0} max={mana?.max_value ?? 0} tone="bg-arcane" />
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
