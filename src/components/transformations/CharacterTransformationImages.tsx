import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Trash2, Upload, Sparkles } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { usePhotoUrl, type Character } from "@/lib/sheets";

type Transformation = { id: string; name: string; description: string | null; cooldown_turns: number; mana_cost: number };
type CharacterTransformationState = { transformation_id: string; image_path: string | null; active: boolean; cooldown_remaining: number };

export function CharacterTransformationImages({ character, isMaster = false }: { character: Character; isMaster?: boolean }) {
  const db = supabase as any;
  const qc = useQueryClient();

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

  const { data: catalog = [], isLoading: loadingCatalog } = useQuery<Transformation[]>({
    queryKey: ["transformations"],
    queryFn: async () => {
      const { data, error } = await db.from("transformations").select("id,name,description,cooldown_turns,mana_cost").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: raceLinks = [], isLoading: loadingRaces } = useQuery<Array<{ transformation_id: string }>>({
    queryKey: ["race-transformations", character.race_id],
    enabled: !!character.race_id,
    queryFn: async () => {
      const { data, error } = await db.from("race_transformations").select("transformation_id").eq("race_id", character.race_id);
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: virtueLinks = [], isLoading: loadingVirtues } = useQuery<Array<{ transformation_id: string }>>({
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

  const availableIds = new Set([...raceLinks, ...virtueLinks].map((link) => link.transformation_id));
  const available = catalog.filter((transformation) => availableIds.has(transformation.id));
  const busy = loadingCatalog || loadingRaces || loadingVirtues || loadingStates;

  return (
    <section className="panel space-y-4 p-4">
      <div className="flex items-center gap-2">
        <ImagePlus className="h-5 w-5 text-gold" />
        <h2 className="text-lg text-gold">Imagens das transformações</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Escolha uma imagem para cada transformação concedida pela raça ou virtude atual. Durante o combate, os outros jogadores verão essa imagem enquanto a transformação estiver ativa. Sem imagem personalizada, o retrato normal continuará sendo usado.
      </p>
      {statesError && <p className="text-sm text-destructive">Não foi possível carregar as imagens: {String(statesError.message ?? statesError)}</p>}
      {busy ? (
        <p className="text-sm text-muted-foreground">Carregando transformações…</p>
      ) : available.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          Nenhuma transformação foi concedida pela raça ou virtude desta ficha ainda.
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
  characterId, transformation, state, onSaved,
}: {
  characterId: string;
  transformation: Transformation;
  state?: CharacterTransformationState;
  isMaster: boolean;
  onSaved: () => Promise<void>;
}) {
  const db = supabase as any;
  const inputRef = useRef<HTMLInputElement>(null);
  const imageUrl = usePhotoUrl(state?.image_path);
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
    <div className="flex gap-3 rounded-md border border-border p-3">
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
    </div>
  );
}
