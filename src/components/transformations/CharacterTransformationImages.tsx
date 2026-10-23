import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Trash2, Upload, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import { parseAbilityEffects, useAbilities, type AbilityEffectDefinition } from "@/lib/abilities";
import { useDefs } from "@/lib/sheets";
import type { Json } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";
import { usePhotoUrl, type Character } from "@/lib/sheets";

type Transformation = { id: string; name: string; description: string | null; duration_turns: number; cooldown_turns: number; mana_cost: number; modifiers: Json; effects: Json; end_effects: Json; owner_character_id?: string | null };
type CharacterTransformationState = { transformation_id: string; image_path: string | null; active: boolean; cooldown_remaining: number };

export function CharacterTransformationImages({ character, isMaster = false }: { character: Character; isMaster?: boolean }) {
  const db = supabase as any;
  const qc = useQueryClient();
  const [newTransformationName, setNewTransformationName] = useState("");
  const [creatingTransformation, setCreatingTransformation] = useState(false);

  useEffect(() => {
    const channel = supabase
      .channel(`character-transformations-${character.id}`)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "character_transformations",
        filter: `character_id=eq.${character.id}`,
      }, () => {
        void Promise.all([
          qc.invalidateQueries({ queryKey: ["character-transformations", character.id] }),
          qc.invalidateQueries({ queryKey: ["battle-character-transformations"] }),
        ]);
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [character.id, qc]);

  const { data: defs = [] } = useDefs();
  const { data: catalog = [], isLoading: loadingCatalog } = useQuery<Transformation[]>({
    queryKey: ["transformations"],
    queryFn: async () => {
      const { data, error } = await db.from("transformations").select("*").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: raceLinks = [], isLoading: loadingRaces, error: raceLinksError } = useQuery<Array<{ transformation_id: string }>>({
    queryKey: ["race-transformations", character.race_id],
    enabled: !!character.race_id,
    queryFn: async () => {
      const { data, error } = await db.from("race_transformations").select("transformation_id").eq("race_id", character.race_id);
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: virtueLinks = [], isLoading: loadingVirtues, error: virtueLinksError } = useQuery<Array<{ transformation_id: string }>>({
    queryKey: ["virtue-transformations", character.virtue_id],
    enabled: !!character.virtue_id,
    queryFn: async () => {
      const { data, error } = await db.from("virtue_transformations").select("transformation_id").eq("virtue_id", character.virtue_id);
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: states = [], isLoading: loadingStates, error: statesError } = useQuery<CharacterTransformationState[]>({
    queryKey: ["character-transformations", character.id],
    queryFn: async () => {
      const { data, error } = await db.from("character_transformations").select("transformation_id,image_path,active,cooldown_remaining").eq("character_id", character.id);
      if (error) throw error;
      return data ?? [];
    },
  });

  // Include trait grants, personal transformations, and any transformation state already attached to this character.
  const availableIds = new Set([...raceLinks, ...virtueLinks, ...states].map((link) => link.transformation_id));
  const available = catalog.filter((transformation) => availableIds.has(transformation.id) || transformation.owner_character_id === character.id);
  async function createPersonalTransformation() {
    const name = newTransformationName.trim();
    if (!name) { toast.error("Informe o nome da transformação"); return; }
    setCreatingTransformation(true);
    const { data, error } = await db.from("transformations").insert({
      owner_character_id: character.id,
      name,
      description: "",
      duration_turns: 3,
      cooldown_turns: 3,
      mana_cost: 0,
      modifiers: {},
      effects: [],
      end_effects: [],
    }).select("id").single();
    if (error) { setCreatingTransformation(false); toast.error(error.message); return; }
    const { error: stateError } = await db.from("character_transformations").insert({
      character_id: character.id, transformation_id: data.id, active: false, cooldown_remaining: 0,
    });
    setCreatingTransformation(false);
    if (stateError) {
      await db.from("transformations").delete().eq("id", data.id);
      toast.error("A transformação foi criada, mas não pôde ser vinculada à ficha: " + stateError.message);
      return;
    }
    setNewTransformationName("");
    toast.success("Transformação exclusiva criada nesta ficha");
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["transformations"] }),
      qc.invalidateQueries({ queryKey: ["character-transformations", character.id] }),
      qc.invalidateQueries({ queryKey: ["battle-character-transformations"] }),
    ]);
  }
  const busy = loadingCatalog || loadingRaces || loadingVirtues || loadingStates;

  return (
    <section className="panel space-y-4 p-4">
      <div className="flex items-center gap-2">
        <ImagePlus className="h-5 w-5 text-gold" />
        <h2 className="text-lg text-gold">{isMaster ? "Transformações e imagens da ficha" : "Transformações que você possui"}</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        {isMaster
          ? "Veja as transformações disponíveis nesta ficha, escolha uma imagem para cada uma e crie transformações exclusivas do personagem."
          : "Aqui aparecem as transformações concedidas pela sua raça ou virtude, as transformações exclusivas da sua ficha e o estado de cada uma."}
      </p>
      <div className="flex flex-col gap-2 rounded-md border border-gold/30 p-3 sm:flex-row">
        <Input value={newTransformationName} onChange={(event) => setNewTransformationName(event.target.value)} placeholder="Nome da transformação exclusiva" />
        <Button type="button" onClick={() => void createPersonalTransformation()} disabled={creatingTransformation || !newTransformationName.trim()}>
          <Sparkles className="mr-1 h-4 w-4" /> {creatingTransformation ? "Criando..." : "Criar transformação"}
        </Button>
      </div>
      {(statesError || raceLinksError || virtueLinksError) && (
        <p className="text-sm text-destructive">
          Não foi possível carregar todas as transformações: {String(statesError?.message ?? raceLinksError?.message ?? virtueLinksError?.message ?? "erro desconhecido")}
        </p>
      )}
      {busy ? (
        <p className="text-sm text-muted-foreground">Carregando transformações…</p>
      ) : available.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          {isMaster
            ? "Nenhuma transformação disponível nesta ficha. Vincule transformações à raça/virtude ou crie uma transformação exclusiva."
            : "Você ainda não possui transformações vinculadas à sua raça, virtude ou ficha. Peça ao mestre para conceder uma."}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {available.map((transformation) => (
            <TransformationImageCard
              key={transformation.id}
              characterId={character.id}
              transformation={transformation}
              state={states.find((entry) => entry.transformation_id === transformation.id)}
              isMaster={isMaster}
              isPersonal={transformation.owner_character_id === character.id}
              defs={defs}
              onSaved={async () => {
                await Promise.all([
                  qc.invalidateQueries({ queryKey: ["character-transformations", character.id] }),
                  qc.invalidateQueries({ queryKey: ["battle-character-transformations"] }),
                ]);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TransformationImageCard({
  characterId, transformation, state, onSaved, isPersonal, defs,
}: {
  characterId: string;
  transformation: Transformation;
  state?: CharacterTransformationState;
  isMaster: boolean;
  isPersonal: boolean;
  defs: NonNullable<ReturnType<typeof useDefs>["data"]>;
  onSaved: () => Promise<void>;
}) {
  const db = supabase as any;
  const inputRef = useRef<HTMLInputElement>(null);
  const imageUrl = usePhotoUrl(state?.image_path);
  const [editPersonal, setEditPersonal] = useState(false);
  const [name, setName] = useState(transformation.name);
  const [description, setDescription] = useState(transformation.description ?? "");
  const [duration, setDuration] = useState(String(transformation.duration_turns ?? 3));
  const [cooldown, setCooldown] = useState(String(transformation.cooldown_turns));
  const [manaCost, setManaCost] = useState(String(transformation.mana_cost));
  const [modifiers, setModifiers] = useState<Record<string, number>>(() => {
    const raw = transformation.modifiers;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Number(value) || 0])) : {};
  });
  const [effects, setEffects] = useState<AbilityEffectDefinition[]>(parseAbilityEffects(transformation.effects));
  const [endEffects, setEndEffects] = useState<AbilityEffectDefinition[]>(parseAbilityEffects(transformation.end_effects));
  const { data: abilityCatalog = [] } = useAbilities();
  const [abilityGrants, setAbilityGrants] = useState<Array<{ ability_id: string; only_while_transformed: boolean }>>([]);
  const { data: savedAbilityGrants = [] } = useQuery<Array<{ ability_id: string; only_while_transformed: boolean }>>({
    queryKey: ["transformation-abilities", transformation.id],
    enabled: isPersonal,
    queryFn: async () => {
      const { data, error } = await db.from("transformation_abilities").select("ability_id,only_while_transformed").eq("transformation_id", transformation.id);
      if (error) throw error;
      return data ?? [];
    },
  });
  useEffect(() => { setAbilityGrants(savedAbilityGrants); }, [savedAbilityGrants]);
  useEffect(() => {
    setName(transformation.name); setDescription(transformation.description ?? "");
    setDuration(String(transformation.duration_turns ?? 3)); setCooldown(String(transformation.cooldown_turns));
    setManaCost(String(transformation.mana_cost));
    const raw = transformation.modifiers;
    setModifiers(raw && typeof raw === "object" && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Number(value) || 0])) : {});
    setEffects(parseAbilityEffects(transformation.effects)); setEndEffects(parseAbilityEffects(transformation.end_effects));
  }, [transformation]);
  async function upload(file: File) {
    if (!file.type.startsWith("image/")) { toast.error("Escolha um arquivo de imagem"); return; }
    if (file.size > 8 * 1024 * 1024) { toast.error("A imagem deve ter no máximo 8 MB"); return; }
    const extension = file.name.split(".").pop()?.replace(/[^a-zA-Z0-9]/g, "") || "jpg";
    const newPath = `${characterId}/transformations/${transformation.id}/${Date.now()}.${extension}`;
    const { error: uploadError } = await supabase.storage.from("character-photos").upload(newPath, file, {
      contentType: file.type,
      upsert: false,
    });
    if (uploadError) { toast.error("Falha ao enviar imagem: " + uploadError.message); return; }

    const { error } = await db.rpc("set_character_transformation_image", {
      _character_id: characterId,
      _transformation_id: transformation.id,
      _image_path: newPath,
    });
    if (error) {
      await supabase.storage.from("character-photos").remove([newPath]);
      toast.error(error.message);
      return;
    }
    if (state?.image_path && state.image_path !== newPath) {
      await supabase.storage.from("character-photos").remove([state.image_path]);
    }
    toast.success(`Imagem de ${transformation.name} salva`);
    await onSaved();
  }

  async function savePersonalTransformation() {
    if (!name.trim()) { toast.error("Informe o nome da transformação"); return; }
    const cleanModifiers = Object.fromEntries(Object.entries(modifiers).map(([key, value]) => [key, Math.round(Number(value) || 0)]).filter(([, value]) => value !== 0));
    const { error } = await db.from("transformations").update({
      name: name.trim(), description: description.trim() || null,
      duration_turns: Math.max(1, Math.min(1000, Math.floor(Number(duration) || 1))),
      cooldown_turns: Math.max(1, Math.min(1000, Math.floor(Number(cooldown) || 1))),
      mana_cost: Math.max(0, Math.min(1000000, Math.floor(Number(manaCost) || 0))),
      modifiers: cleanModifiers,
      effects: effects.map((effect) => ({ ...effect, duration: Math.max(1, effect.duration) })) as unknown as Json,
      end_effects: endEffects.map((effect) => ({ ...effect, duration: Math.max(1, effect.duration) })) as unknown as Json,
      updated_at: new Date().toISOString(),
    }).eq("id", transformation.id).eq("owner_character_id", characterId);
    if (error) { toast.error(error.message); return; }
    const { error: clearGrantsError } = await db.from("transformation_abilities").delete().eq("transformation_id", transformation.id);
    if (clearGrantsError) { toast.error("Transformação salva, mas não foi possível atualizar habilidades concedidas: " + clearGrantsError.message); return; }
    if (abilityGrants.length > 0) {
      const { error: grantsError } = await db.from("transformation_abilities").insert(
        abilityGrants.map((grant) => ({ transformation_id: transformation.id, ...grant }))
      );
      if (grantsError) { toast.error("Transformação salva, mas não foi possível salvar habilidades concedidas: " + grantsError.message); return; }
    }
    await qc.invalidateQueries({ queryKey: ["transformation-abilities", transformation.id] });
    toast.success("Transformação exclusiva salva");
    await qc.invalidateQueries({ queryKey: ["transformations"] });
    await onSaved();
    setEditPersonal(false);
  }

  async function remove() {
    if (!state?.image_path) return;
    const oldPath = state.image_path;
    const { error } = await db.rpc("set_character_transformation_image", {
      _character_id: characterId,
      _transformation_id: transformation.id,
      _image_path: null,
    });
    if (error) { toast.error(error.message); return; }
    await supabase.storage.from("character-photos").remove([oldPath]);
    toast.success("Imagem personalizada removida");
    await onSaved();
  }

  return (
    <div className="flex flex-wrap gap-3 rounded-md border border-border p-3">
      <div className="h-28 w-20 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
        {imageUrl ? <img src={imageUrl} alt={transformation.name} className="h-full w-full object-cover" /> : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <Sparkles className="h-6 w-6" />
            <span className="px-1 text-center text-[10px]">Usa foto normal</span>
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <h3 className="font-semibold">{transformation.name}</h3>
          <p className="text-xs text-muted-foreground">
            Cooldown de {transformation.cooldown_turns} turno(s) · {transformation.mana_cost > 0 ? `${transformation.mana_cost} Mana` : "sem custo de Mana"}
          </p>
          {state?.active && <p className="mt-1 text-xs font-semibold text-emerald-500">Transformação ativa · {state.cooldown_remaining} turno(s)</p>}
        </div>
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = "";
        }} />
        {isPersonal && (
          <Button type="button" size="sm" variant="outline" onClick={() => setEditPersonal((value) => !value)}>
            {editPersonal ? "Fechar edição" : "Editar transformação"}
          </Button>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
            <Upload className="mr-1 h-3.5 w-3.5" /> {state?.image_path ? "Trocar imagem" : "Escolher imagem"}
          </Button>
          {state?.image_path && (
            <Button type="button" size="sm" variant="ghost" onClick={() => void remove()}>
              <Trash2 className="mr-1 h-3.5 w-3.5" /> Remover
            </Button>
          )}
        </div>
      </div>
      {isPersonal && editPersonal && (
        <div className="mt-3 w-full basis-full space-y-3 rounded-md border border-gold/30 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label>Nome</Label><Input value={name} onChange={(event) => setName(event.target.value)} /></div>
            <div className="space-y-1"><Label>Duração (turnos)</Label><Input type="number" min={1} max={1000} value={duration} onChange={(event) => setDuration(event.target.value)} /></div>
            <div className="space-y-1"><Label>Cooldown (turnos)</Label><Input type="number" min={1} max={1000} value={cooldown} onChange={(event) => setCooldown(event.target.value)} /></div>
            <div className="space-y-1"><Label>Custo de Mana</Label><Input type="number" min={0} max={1000000} value={manaCost} onChange={(event) => setManaCost(event.target.value)} /></div>
            <div className="space-y-1 sm:col-span-2"><Label>Descrição</Label><Textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} /></div>
          </div>
          <div className="space-y-2 rounded-md border border-border p-3">
            <Label>Modificadores de atributos</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {defs.map((definition) => <div key={definition.key} className="space-y-1">
                <Label>{definition.label}</Label>
                <Input type="number" value={modifiers[definition.key] ?? 0} onChange={(event) => setModifiers((current) => ({ ...current, [definition.key]: Number(event.target.value) || 0 }))} />
              </div>)}
              {(["body", "sanity"] as const).map((key) => <div key={key} className="space-y-1">
                <Label>{key === "body" ? "Corpo (%)" : "Sanidade (%)"}</Label>
                <Input type="number" min={-100} max={100} value={modifiers[key] ?? 0} onChange={(event) => setModifiers((current) => ({ ...current, [key]: Number(event.target.value) || 0 }))} />
              </div>)}
            </div>
          </div>
          <AbilityEffectsEditor effects={effects} onChange={setEffects} permanent={false} title="Efeitos ao transformar" description="Efeitos aplicados ao ativar esta transformação." defs={defs} />
          <AbilityEffectsEditor effects={endEffects} onChange={setEndEffects} permanent={false} title="Efeitos ao terminar" description="Efeitos aplicados quando a transformação acaba." defs={defs} allowPeriodicHealing={false} />
          <div className="space-y-2 rounded-md border border-border p-3">
            <Label>Habilidades concedidas por esta transformação</Label>
            <p className="text-xs text-muted-foreground">As habilidades marcadas como condicionais só aparecem enquanto a transformação estiver ativa no combate.</p>
            {abilityCatalog.map((ability) => {
              const grant = abilityGrants.find((item) => item.ability_id === ability.id);
              return <div key={ability.id} className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={!!grant} onChange={(event) => setAbilityGrants((current) => event.target.checked
                    ? [...current.filter((item) => item.ability_id !== ability.id), { ability_id: ability.id, only_while_transformed: false }]
                    : current.filter((item) => item.ability_id !== ability.id))} />
                  {ability.name}
                </label>
                {grant && <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={grant.only_while_transformed} onChange={(event) => setAbilityGrants((current) => current.map((item) => item.ability_id === ability.id ? { ...item, only_while_transformed: event.target.checked } : item))} />
                  Só enquanto transformado
                </label>}
              </div>;
            })}
            {abilityCatalog.length === 0 && <p className="text-xs text-muted-foreground">Nenhuma habilidade do catálogo disponível.</p>}
          </div>
          <Button type="button" onClick={() => void savePersonalTransformation()}>Salvar transformação exclusiva</Button>
        </div>
      )}
    </div>
  );
}
