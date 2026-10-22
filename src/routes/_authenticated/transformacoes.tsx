import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Trash2, Sparkles, Clock3, Droplets } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useDefs, useMe, type AttributeDef } from "@/lib/sheets";
import { parseAbilityEffects, type AbilityEffectDefinition } from "@/lib/abilities";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import type { Json } from "@/integrations/supabase/types";

export const Route = createFileRoute("/_authenticated/transformacoes")({
  head: () => ({
    meta: [
      { title: "Transformações — Grimório" },
      { name: "description", content: "Crie transformações temporárias para personagens." },
    ],
  }),
  component: TransformationsPage,
});

type Transformation = {
  id: string;
  name: string;
  description: string | null;
  duration_turns: number;
  cooldown_turns: number;
  mana_cost: number;
  modifiers: Json;
  effects: Json;
  end_effects: Json;
  created_at: string;
  updated_at: string;
};

function parseModifiers(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n !== 0) output[key] = Math.round(n);
  }
  return output;
}

function TransformationsPage() {
  const { data: me, isLoading: loadingMe } = useMe();
  const { data: defs = [] } = useDefs();
  const qc = useQueryClient();
  const db = supabase as any;
  const [search, setSearch] = useState("");
  const [pendingSaveIds, setPendingSaveIds] = useState<string[]>([]);

  const { data: transformations = [], isLoading, error } = useQuery<Transformation[]>({
    queryKey: ["transformations"],
    queryFn: async () => {
      const { data, error } = await db.from("transformations").select("*").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  if (loadingMe || !me) return <p className="text-muted-foreground">Carregando…</p>;
  if (!me.isMaster) return <p className="text-muted-foreground">Apenas o mestre pode criar e gerenciar transformações.</p>;

  async function create() {
    const { data, error } = await db.from("transformations").insert({
      name: "Nova transformação",
      description: "",
      duration_turns: 3,
      cooldown_turns: 15,
      mana_cost: 0,
      modifiers: {},
      effects: [],
      end_effects: [],
    }).select("id").single();
    if (error) { toast.error(error.message); return; }
    setSearch("");
    setPendingSaveIds((current) => [data.id, ...current.filter((id) => id !== data.id)]);
    toast.success("Transformação criada. Configure e salve os detalhes.");
    await qc.invalidateQueries({ queryKey: ["transformations"] });
  }

  const normalizedSearch = search.trim().toLocaleLowerCase("pt-BR");
  const visible = transformations.filter((item) =>
    item.name.toLocaleLowerCase("pt-BR").includes(normalizedSearch)
    || (item.description ?? "").toLocaleLowerCase("pt-BR").includes(normalizedSearch)
  ).slice().sort((a, b) => {
    const ai = pendingSaveIds.indexOf(a.id);
    const bi = pendingSaveIds.indexOf(b.id);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.name.localeCompare(b.name, "pt-BR");
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-3xl text-gold">
            <Sparkles className="h-7 w-7" /> Transformações
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Crie formas temporárias com modificadores de atributos, Corpo e Sanidade, efeitos de ativação e efeitos disparados quando a transformação termina. Raças e virtudes podem conceder acesso a cada transformação.
          </p>
        </div>
        <Button onClick={() => void create()}><Plus className="mr-1 h-4 w-4" /> Nova transformação</Button>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Pesquisar transformação…" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>

      {error && <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">Não foi possível carregar as transformações: {String(error.message ?? error)}</p>}
      {isLoading && <p className="text-sm text-muted-foreground">Carregando transformações…</p>}
      {!isLoading && transformations.length === 0 && (
        <div className="panel p-8 text-center">
          <Sparkles className="mx-auto mb-3 h-9 w-9 text-gold" />
          <h2 className="text-lg text-gold">Nenhuma transformação criada</h2>
          <p className="mt-2 text-sm text-muted-foreground">Crie a primeira transformação e depois vincule-a a uma raça ou virtude.</p>
          <Button className="mt-4" onClick={() => void create()}><Plus className="mr-1 h-4 w-4" /> Criar transformação</Button>
        </div>
      )}
      {transformations.length > 0 && visible.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma transformação encontrada para “{search}”.</p>}
      <div className="space-y-5">
        {visible.map((transformation) => (
          <TransformationEditor
            key={transformation.id}
            transformation={transformation}
            defs={defs}
            isNew={pendingSaveIds.includes(transformation.id)}
            onSaved={() => setPendingSaveIds((current) => current.filter((id) => id !== transformation.id))}
            onDeleted={() => setPendingSaveIds((current) => current.filter((id) => id !== transformation.id))}
          />
        ))}
      </div>
    </div>
  );
}

function TransformationEditor({
  transformation, defs, isNew, onSaved, onDeleted,
}: {
  transformation: Transformation;
  defs: AttributeDef[];
  isNew: boolean;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const db = supabase as any;
  const [name, setName] = useState(transformation.name);
  const [description, setDescription] = useState(transformation.description ?? "");
  const [duration, setDuration] = useState(transformation.duration_turns);
  const [cooldown, setCooldown] = useState(transformation.cooldown_turns);
  const [manaCost, setManaCost] = useState(transformation.mana_cost);
  const [modifiers, setModifiers] = useState<Record<string, number>>(() => parseModifiers(transformation.modifiers));
  const [effects, setEffects] = useState<AbilityEffectDefinition[]>(() => parseAbilityEffects(transformation.effects));
  const [endEffects, setEndEffects] = useState<AbilityEffectDefinition[]>(() => parseAbilityEffects(transformation.end_effects));

  useEffect(() => {
    setName(transformation.name);
    setDescription(transformation.description ?? "");
    setDuration(transformation.duration_turns);
    setCooldown(transformation.cooldown_turns);
    setManaCost(transformation.mana_cost);
    setModifiers(parseModifiers(transformation.modifiers));
    setEffects(parseAbilityEffects(transformation.effects));
    setEndEffects(parseAbilityEffects(transformation.end_effects));
  }, [transformation.id, transformation.name, transformation.description, transformation.duration_turns, transformation.cooldown_turns, transformation.mana_cost, transformation.modifiers, transformation.effects, transformation.end_effects]);

  async function save() {
    if (!name.trim()) { toast.error("Informe o nome da transformação"); return; }
    const cleanModifiers: Record<string, number> = {};
    for (const [key, raw] of Object.entries(modifiers)) {
      const value = Math.round(Number(raw) || 0);
      if (!Number.isFinite(value) || Math.abs(value) > 1000000) {
        toast.error(`O modificador de ${key} deve ficar entre -1.000.000 e 1.000.000`);
        return;
      }
      if (value !== 0) cleanModifiers[key] = value;
    }
    const { error } = await db.from("transformations").update({
      name: name.trim(),
      description: description.trim() || null,
      duration_turns: Math.max(1, Math.min(1000, Math.floor(Number(duration) || 1))),
      cooldown_turns: Math.max(1, Math.min(1000, Math.floor(Number(cooldown) || 1))),
      mana_cost: Math.max(0, Math.min(1000000, Math.floor(Number(manaCost) || 0))),
      modifiers: cleanModifiers,
      effects: effects as unknown as Json,
      end_effects: endEffects as unknown as Json,
      updated_at: new Date().toISOString(),
    }).eq("id", transformation.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Transformação salva");
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["transformations"] }),
      qc.invalidateQueries({ queryKey: ["race-transformations"] }),
      qc.invalidateQueries({ queryKey: ["virtue-transformations"] }),
      qc.invalidateQueries({ queryKey: ["character-transformations"] }),
      qc.invalidateQueries({ queryKey: ["battle-character-transformations"] }),
    ]);
    onSaved();
  }

  async function remove() {
    if (!confirm(`Excluir a transformação “${transformation.name}”? Ela também será removida das raças e virtudes que a concedem.`)) return;
    const { error } = await db.from("transformations").delete().eq("id", transformation.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Transformação excluída");
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["transformations"] }),
      qc.invalidateQueries({ queryKey: ["race-transformations"] }),
      qc.invalidateQueries({ queryKey: ["virtue-transformations"] }),
      qc.invalidateQueries({ queryKey: ["character-transformations"] }),
      qc.invalidateQueries({ queryKey: ["battle-character-transformations"] }),
    ]);
    onDeleted();
  }

  return (
    <section className="panel space-y-5 p-5">
      {isNew && <p className="text-xs font-semibold text-amber-500">Nova transformação — salve para confirmar as configurações.</p>}
      <div className="grid gap-4 md:grid-cols-[1fr_180px_180px]">
        <div className="space-y-1.5">
          <Label>Nome da transformação</Label>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" /> Duração da transformação (turnos)</Label>
          <Input type="number" min={1} max={1000} value={duration} onChange={(event) => setDuration(Number(event.target.value))} />
        </div>
        <div className="space-y-1.5">
          <Label className="flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" /> Cooldown para reutilizar (turnos)</Label>
          <Input type="number" min={1} max={1000} value={cooldown} onChange={(event) => setCooldown(Number(event.target.value))} />
        </div>
        <div className="space-y-1.5">
          <Label className="flex items-center gap-1"><Droplets className="h-3.5 w-3.5" /> Custo de Mana (0 = grátis)</Label>
          <Input type="number" min={0} max={1000000} value={manaCost} onChange={(event) => setManaCost(Number(event.target.value))} />
        </div>
        <div className="space-y-1.5 md:col-span-3">
          <Label>Descrição</Label>
          <Textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
        </div>
      </div>

      <div className="space-y-3 rounded-md border border-border p-3">
        <div>
          <h3 className="text-sm font-semibold text-gold">Modificadores temporários de atributos</h3>
          <p className="mt-1 text-xs text-muted-foreground">Valores positivos aumentam o atributo e negativos o reduzem. Inclua Corpo e Sanidade para modificar os percentuais durante a transformação. Os valores originais são restaurados quando ela termina.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {defs.map((definition) => (
            <div key={definition.key} className="space-y-1">
              <Label>{definition.label} ({definition.key})</Label>
              <Input type="number" step={1} value={modifiers[definition.key] ?? 0}
                onChange={(event) => setModifiers((current) => ({ ...current, [definition.key]: Number(event.target.value) || 0 }))} />
            </div>
          ))}
          {([{key:"body",label:"Corpo (%)"},{key:"sanity",label:"Sanidade (%)"}]).map((item) => (
            <div key={item.key} className="space-y-1">
              <Label>{item.label}</Label>
              <Input type="number" min={-100} max={100} step={1} value={modifiers[item.key] ?? 0}
                onChange={(event) => setModifiers((current) => ({ ...current, [item.key]: Math.max(-100, Math.min(100, Number(event.target.value) || 0)) }))} />
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-md border border-border p-3">
        <AbilityEffectsEditor
          effects={effects}
          onChange={setEffects}
          title="Efeitos ao ativar"
          description="Estes efeitos ficam vinculados à transformação e são removidos quando o cooldown chega a zero."
          defs={defs}
          allowHealing
          allowPeriodicHealing
          hideDuration
        />
      </div>
      <div className="rounded-md border border-border p-3">
        <AbilityEffectsEditor
          effects={endEffects}
          onChange={setEndEffects}
          title="Efeitos ao terminar"
          description="Estes efeitos são aplicados quando a transformação termina. A duração definida em cada efeito é mantida normalmente."
          defs={defs}
          allowHealing
          allowPeriodicHealing
        />
      </div>

      <div className="space-y-3 rounded-md border border-border p-3">
        <h3 className="text-sm font-semibold text-gold">Conceder transformação</h3>
        <div className="grid gap-4 lg:grid-cols-2">
          <TransformationGrantList transformationId={transformation.id} scope="race" />
          <TransformationGrantList transformationId={transformation.id} scope="virtue" />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save()}>{isNew ? "Salvar transformação" : "Salvar alterações"}</Button>
        <Button variant="destructive" onClick={() => void remove()}><Trash2 className="mr-1 h-4 w-4" /> Excluir</Button>
      </div>
    </section>
  );
}
