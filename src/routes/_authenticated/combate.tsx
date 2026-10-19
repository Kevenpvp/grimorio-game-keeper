import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Crosshair, Dices, Plus, Swords, Trash2, Copy, HeartPulse } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { computeValue, raceMods, useDefs, useMe, useRaces, type AttributeDef } from "@/lib/sheets";
import { Portrait } from "@/components/sheet/CharacterSheetView";
import { StatBar } from "@/components/sheet/StatBar";
import { cn } from "@/lib/utils";

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
        .select("*, battle_participants(sort_order, characters(id,name,player_name,photo_path,race_id,character_attributes(attribute_key,current_value,max_value,points,bonus)))")
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

  const actor = fighters.find((f) => f.id === battle.current_character_id);
  const target = fighters.find((f) => f.id === battle.target_character_id);

  if (!defs) return null;
  return (
    <div className="space-y-6">
      {isMaster && <BattleAdmin battle={battle} fighters={fighters} onUpdate={update} />}
      {!isMaster && <h2 className="text-xl text-gold">{battle.name}</h2>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {fighters.map((f) => {
          const isActor = f.id === actor?.id;
          const isTarget = f.id === target?.id;
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
                  {isTarget && <div className="text-xs font-semibold text-blood">◎ Alvo</div>}
                </div>
              </div>
              <Bar label="HP" cur={hp?.current_value ?? 0} max={val(f, "hp")} tone="bg-blood" />
              <Bar label="Mana" cur={mana?.current_value ?? 0} max={val(f, "mana")} tone="bg-arcane" />
              {isMaster && (
                <div className="flex gap-2 pt-1">
                  <Button size="sm" variant={isActor ? "default" : "outline"} onClick={() => update({ current_character_id: f.id, target_character_id: battle.target_character_id === f.id ? null : battle.target_character_id })}>
                    <Swords className="mr-1 h-3.5 w-3.5" /> Vez
                  </Button>
                  <Button size="sm" variant={isTarget ? "destructive" : "outline"} disabled={isActor} onClick={() => update({ target_character_id: f.id })}>
                    <Crosshair className="mr-1 h-3.5 w-3.5" /> Alvo
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {isMaster && (actor && target ? (
        <Actions battleId={battle.id} actor={actor} target={target} defs={defs} val={val} />
      ) : (
        <p className="text-sm text-muted-foreground">Escolha quem está na vez e um alvo para ver as ações.</p>
      ))}
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

function Actions({ battleId, actor, target, defs, val }: {
  battleId: string; actor: Fighter; target: Fighter; defs: AttributeDef[]; val: (f: Fighter, k: string) => number;
}) {
  const qc = useQueryClient();
  const [roll, setRoll] = useState<Roll | null>(null);
  const [testKey, setTestKey] = useState("strength");
  const [damageMode, setDamageMode] = useState<"repeat" | "list">("repeat");
  const [damageKind, setDamageKind] = useState<"physical" | "magical">("physical");
  const [damageValue, setDamageValue] = useState("20");
  const [repeatCount, setRepeatCount] = useState("1");
  const [damageList, setDamageList] = useState("50, 35, 45, 86, 20, 10, 50");
  const [damageTypeId, setDamageTypeId] = useState("");
  const [applyingDamage, setApplyingDamage] = useState(false);
  const { data: damageTypes = [] } = useQuery({
    queryKey: ["damage-types"],
    queryFn: async () => {
      const { data, error } = await supabase.from("damage_types").select("id,name").order("name");
      if (error) throw error;
      return data;
    },
  });
  const label = (k: string) => defs.find((d) => d.key === k)?.label ?? k;

  function attack() {
    const aAtk = val(actor, "atk_speed"), tSpd = val(target, "speed");
    const atkMod = diceMod(aAtk, tSpd);
    const dodgeMod = diceMod(tSpd, aAtk);
    setRoll({
      title: `${actor.name} ataca ${target.name}`,
      lines: [
        { who: `${actor.name} (ataque)`, dice: dice(atkMod), detail: `(${label("atk_speed")} ${aAtk} − ${label("speed")} ${tSpd}) ÷ 10` },
        { who: `${target.name} (esquiva)`, dice: dice(dodgeMod), detail: `(${label("speed")} ${tSpd} − ${label("atk_speed")} ${aAtk}) ÷ 10` },
      ],
    });
  }
  function test() {
    const a = val(actor, testKey), t = val(target, testKey);
    setRoll({
      title: `Teste de ${label(testKey)} vs ${label(testKey)}`,
      lines: [
        { who: actor.name, dice: dice(diceMod(a, t)), detail: `(${a} − ${t}) ÷ 10` },
        { who: target.name, dice: dice(diceMod(t, a)), detail: `(${t} − ${a}) ÷ 10` },
      ],
    });
  }
  const testable = defs;

  return (
    <div className="panel space-y-4 p-4">
      <h2 className="text-xl text-gold">Ações de {actor.name} → {target.name}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={attack}><Swords className="mr-1 h-4 w-4" /> Atacar</Button>
        <span className="mx-2 text-muted-foreground">|</span>
        <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={testKey} onChange={(e) => setTestKey(e.target.value)}>
          {testable.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select>
        <Button variant="outline" onClick={test}><Dices className="mr-1 h-4 w-4" /> Teste</Button>
      </div>
      <div className="space-y-3 border-t border-border pt-4">
        <div className="flex items-center gap-2 text-lg text-gold"><HeartPulse className="h-5 w-5" /> Aplicar dano em lote</div>
        <p className="text-sm text-muted-foreground">A defesa escolhida é descontada de cada golpe individualmente. O HP não fica abaixo de zero.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Tipo de dano</label>
            <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={damageKind} onChange={(e) => setDamageKind(e.target.value as "physical" | "magical")}>
              <option value="physical">Físico — Defesa</option>
              <option value="magical">Mágico — Defesa Mágica</option>
            </select>
          </div>
          {damageKind === "magical" && (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Subtipo mágico</label>
              <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={damageTypeId} onChange={(e) => setDamageTypeId(e.target.value)}>
                <option value="">Selecione o subtipo</option>
                {damageTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
              </select>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={damageMode === "repeat" ? "default" : "outline"} onClick={() => setDamageMode("repeat")}>Repetir um valor</Button>
          <Button size="sm" variant={damageMode === "list" ? "default" : "outline"} onClick={() => setDamageMode("list")}>Lista de danos</Button>
        </div>
        {damageMode === "repeat" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Dano bruto por golpe</label>
              <Input type="number" min="0" max="1000000" value={damageValue} onChange={(e) => setDamageValue(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Quantidade de golpes (1–200)</label>
              <Input type="number" min="1" max="200" value={repeatCount} onChange={(e) => setRepeatCount(e.target.value)} />
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Danos brutos separados por vírgula</label>
            <Input value={damageList} onChange={(e) => setDamageList(e.target.value)} placeholder="50, 35, 45, 86, 20, 10, 50" />
          </div>
        )}
        <Button disabled={applyingDamage || (damageKind === "magical" && (!damageTypeId || damageTypes.length === 0))} onClick={async () => {
          let values: number[];
          if (damageMode === "repeat") {
            const amount = Number(damageValue);
            const count = Number(repeatCount);
            if (!Number.isFinite(amount) || amount < 0 || amount > 1000000 || !Number.isInteger(count) || count < 1 || count > 200) {
              toast.error("Informe um dano válido e de 1 a 200 golpes"); return;
            }
            values = Array.from({ length: count }, () => amount);
          } else {
            const parts = damageList.split(/[,;\s]+/).filter(Boolean);
            values = parts.map(Number);
            if (values.length < 1 || values.length > 200 || values.some((n) => !Number.isFinite(n) || n < 0 || n > 1000000)) {
              toast.error("Informe de 1 a 200 danos válidos, separados por vírgula"); return;
            }
          }
          if (damageKind === "magical" && !damageTypeId) { toast.error("Selecione um subtipo mágico"); return; }
          setApplyingDamage(true);
          try {
            const { data, error } = await supabase.rpc("apply_battle_damage", {
              _battle_id: battleId,
              _character_id: target.id,
              _damage_kind: damageKind,
              _damage_type_id: damageKind === "magical" ? damageTypeId : null,
              _damage_values: values,
            });
            if (error) { toast.error(error.message); return; }
            const result = data as unknown as { hits: number; defense: number; total_damage: number; hp_before: number; hp_after: number };
            toast.success(`Dano aplicado em ${target.name}: ${result.hits} golpe(s), defesa ${result.defense}, ${result.total_damage} de dano total. HP: ${result.hp_before} → ${result.hp_after}.`);
            await qc.invalidateQueries({ queryKey: ["battles"] });
            await qc.invalidateQueries({ queryKey: ["character", target.id] });
          } finally {
            setApplyingDamage(false);
          }
        }}><HeartPulse className="mr-1 h-4 w-4" /> {applyingDamage ? "Aplicando…" : `Aplicar dano em ${target.name}`}</Button>
      </div>
      {roll && (
        <div className="space-y-2 rounded-md border border-gold/40 p-3">
          <div className="font-display text-gold">{roll.title}</div>
          {roll.lines.map((l) => (
            <div key={l.who} className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm">{l.who}</div>
                <div className="text-xs text-muted-foreground">{l.detail} (mínimo 0)</div>
              </div>
              <div className="flex items-center gap-2">
                <span className="tabular font-display text-2xl text-gold">{l.dice}</span>
                <Button size="icon" variant="ghost" onClick={() => { navigator.clipboard.writeText(l.dice); toast.success("Copiado"); }}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
