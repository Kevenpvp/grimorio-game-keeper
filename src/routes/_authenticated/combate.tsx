import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Crosshair, Dices, Plus, Swords, Trash2, Copy, Footprints, RotateCw, Minus, Brain, Activity } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { computeValue, raceMods, useDefs, useMe, useRaces, type AttributeDef } from "@/lib/sheets";
import { Portrait } from "@/components/sheet/CharacterSheetView";
import { StatBar } from "@/components/sheet/StatBar";
import { cn } from "@/lib/utils";
import { DamageApplier } from "@/components/combat/DamageApplier";

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
type Fighter = {
  id: string; name: string; player_name: string; photo_path: string | null; race_id: string | null;
  body: number; sanity: number;
  character_attributes: Attr[];
};

/** Applied total of an attribute (points + race + buff/debuff). */
function totalOf(def: AttributeDef, a: Attr | undefined, mods: Record<string, number>) {
  const race = mods[def.key] ?? 0;
  const value = !def.accepts_points
    ? (a?.max_value ?? 0) + race + (a?.bonus ?? 0)
    : computeValue(def, (a?.points ?? 0) + race) + (a?.bonus ?? 0);
  // A racial penalty must never make a character's maximum HP zero or negative.
  return def.key === "hp" ? Math.max(1, value) : value;
}
const diceMod = (mine: number, theirs: number) => Math.max(0, Math.floor((mine - theirs) / 10));
const dice = (m: number) => `1d20+${m}`;

function useLiveBattles() {
  const qc = useQueryClient();
  useEffect(() => {
    const refresh = () => qc.invalidateQueries({ queryKey: ["battles"] });
    const ch = supabase
      .channel("battles-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "battles" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "battle_participants" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "character_attributes" }, refresh)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc]);
  return useQuery({
    queryKey: ["battles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("battles")
        .select("*, battle_participants(sort_order, characters(id,name,player_name,photo_path,race_id,body,sanity,character_attributes(attribute_key,current_value,max_value,points,bonus)))")
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
          {battle && <BattleView key={battle.id} battle={battle} isMaster={isMaster} />}
        </>
      )}
    </div>
  );
}

type BattleRow = NonNullable<ReturnType<typeof useLiveBattles>["data"]>[number];

function BattleView({ battle, isMaster }: { battle: BattleRow; isMaster: boolean }) {
  const { data: defs } = useDefs();
  const { data: races } = useRaces();
  const qc = useQueryClient();
  const [selectedTargetIds, setSelectedTargetIds] = useState<string[]>(() => battle.target_character_id ? [battle.target_character_id] : []);
  const fighters = useMemo(
    () => battle.battle_participants.slice().sort((a, b) => a.sort_order - b.sort_order).map((p) => p.characters as Fighter).filter(Boolean),
    [battle],
  );
  const modsOf = (f: Fighter) => raceMods(races?.find((r) => r.id === f.race_id));
  const val = (f: Fighter, key: string) => {
    const def = defs?.find((d) => d.key === key);
    return def ? totalOf(def, f.character_attributes.find((a) => a.attribute_key === key), modsOf(f)) : 0;
  };

  const update = async (patch: { current_character_id?: string | null; target_character_id?: string | null; active?: boolean; name?: string }) => {
    const { error } = await supabase.from("battles").update(patch).eq("id", battle.id);
    if (error) toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["battles"] });
  };

  async function advanceTurn() {
    const nextTurn = (battle.turn_count ?? 0) + 1;
    const { error: turnError } = await supabase.from("battles").update({ turn_count: nextTurn }).eq("id", battle.id);
    if (turnError) { toast.error(turnError.message); return; }
    for (const fighter of fighters) {
      const manaAttr = fighter.character_attributes.find((a) => a.attribute_key === "mana");
      if (!manaAttr) continue;
      const nextMana = Math.min(val(fighter, "mana"), (manaAttr.current_value ?? 0) + Math.ceil(val(fighter, "mana") * 0.05));
      const { error } = await supabase.from("character_attributes").update({ current_value: nextMana, updated_at: new Date().toISOString() }).eq("character_id", fighter.id).eq("attribute_key", "mana");
      if (error) toast.error("Falha ao regenerar mana de " + fighter.name + ": " + error.message);
    }
    toast.success("Turno " + nextTurn + ": regeneração de 5% da mana máxima.");
    await qc.invalidateQueries({ queryKey: ["battles"] });
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
      <div className="panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div><div className="text-sm text-muted-foreground">Turnos transcorridos</div><div className="font-display text-2xl text-gold">{battle.turn_count ?? 0}</div></div>
        {isMaster && <Button onClick={() => void advanceTurn()}><RotateCw className="mr-2 h-4 w-4" /> Avançar turno (+5% Mana)</Button>}
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
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded border border-border p-2"><span className="text-muted-foreground">Corpo</span><div className="font-semibold">{f.body}%</div></div>
                <div className="rounded border border-border p-2"><span className="text-muted-foreground">Sanidade</span><div className="font-semibold">{f.sanity}%</div></div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {defs.filter((d) => !d.show_bar && !["hp", "mana"].includes(d.key)).map((d) => (
                  <div key={d.key} className="rounded border border-border p-2"><span className="text-muted-foreground">{d.label}</span><div className="font-semibold">{val(f, d.key)}</div></div>
                ))}
              </div>
              {isMaster && <CombatResourceEditor fighter={f} val={val} />}
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


function CombatResourceEditor({ fighter, val }: { fighter: Fighter; val: (f: Fighter, k: string) => number }) {
  const qc = useQueryClient();
  const [manaDelta, setManaDelta] = useState("10");
  const [sanityDelta, setSanityDelta] = useState("10");
  const [bodyDelta, setBodyDelta] = useState("10");
  const [busy, setBusy] = useState(false);

  async function changePercent(field: "sanity" | "body", deltaText: string) {
    const delta = Number(deltaText);
    if (!Number.isFinite(delta) || delta <= 0) { toast.error("Informe uma quantidade positiva"); return; }
    setBusy(true);
    try {
      const current = field === "sanity" ? fighter.sanity : fighter.body;
      const next = Math.max(0, Math.min(100, current - delta));
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
      <div className="text-xs font-semibold text-muted-foreground">Reduzir recursos (mestre)</div>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Input aria-label="Quantidade de mana a reduzir" type="number" min="1" value={manaDelta} onChange={(e) => setManaDelta(e.target.value)} />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void changeMana()}><Minus className="mr-1 h-3 w-3" /> Mana</Button>
        <Input aria-label="Quantidade de sanidade a reduzir" type="number" min="1" value={sanityDelta} onChange={(e) => setSanityDelta(e.target.value)} />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void changePercent("sanity", sanityDelta)}><Brain className="mr-1 h-3 w-3" /> Sanidade</Button>
        <Input aria-label="Quantidade de corpo a reduzir" type="number" min="1" value={bodyDelta} onChange={(e) => setBodyDelta(e.target.value)} />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void changePercent("body", bodyDelta)}><Activity className="mr-1 h-3 w-3" /> Corpo</Button>
      </div>
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
          {targets.map((target) => <DamageApplier key={target.id} target={target} battleId={battleId} />)}
        </div>
      )}
    </div>
  );
}
