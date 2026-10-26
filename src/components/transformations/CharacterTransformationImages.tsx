import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Trash2, Upload, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import { SearchableGrantPicker } from "@/components/ui/searchable-grant-picker";
import { effectSummary } from "@/components/abilities/CharacterAbilities";
import { parseAbilityEffects, useAbilities, useDamageTypes, type AbilityEffectDefinition } from "@/lib/abilities";
import { useDefs, useRaces, useClasses, useVirtues } from "@/lib/sheets";
import type { Json } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";
import { usePhotoUrl, type Character } from "@/lib/sheets";

type Transformation = { id: string; name: string; description: string | null; duration_turns: number; cooldown_turns: number; mana_cost: number; modifiers: Json; effects: Json; end_effects: Json; owner_character_id?: string | null; source_transformation_id?: string | null; linked_by_race_id?: string | null; linked_by_virtue_id?: string | null; linked_by_class_id?: string | null };
type CharacterTransformationState = { transformation_id: string; image_path: string | null; active: boolean; cooldown_remaining: number };

export function CharacterTransformationImages({ character, isMaster = false }: { character: Character; isMaster?: boolean }) {
  const db = supabase as any;
  const qc = useQueryClient();
  const [newTransformationName, setNewTransformationName] = useState("");
  const [creatingTransformation, setCreatingTransformation] = useState(false);
  const [newTransformationTrait, setNewTransformationTrait] = useState<"none" | "race" | "virtue" | "class">("none");
  const [catalogGrantTrait, setCatalogGrantTrait] = useState<"none" | "race" | "virtue" | "class">("none");
  const [catalogGrantBusy, setCatalogGrantBusy] = useState(false);

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
  const { data: damageTypes = [] } = useDamageTypes();
  const { data: races = [] } = useRaces();
  const { data: classes = [] } = useClasses();
  const { data: virtues = [] } = useVirtues();
  const { data: catalog = [], isLoading: loadingCatalog } = useQuery<Transformation[]>({
    queryKey: ["transformations", "character-transformation-images", character.id],
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
  const { data: classLinks = [], isLoading: loadingClasses, error: classLinksError } = useQuery<Array<{ transformation_id: string }>>({
    queryKey: ["class-transformations", character.class_id],
    enabled: !!character.class_id,
    queryFn: async () => {
      const { data, error } = await db.from("class_transformations").select("transformation_id").eq("class_id", character.class_id);
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
  const availableIds = new Set([...raceLinks, ...virtueLinks, ...classLinks, ...states].map((link) => link.transformation_id));
  const overriddenTransformationIds = new Set(catalog
    .filter((transformation) => transformation.owner_character_id === character.id && transformation.source_transformation_id)
    .map((transformation) => transformation.source_transformation_id as string));
  const available = catalog.filter((transformation) =>
    (availableIds.has(transformation.id) || transformation.owner_character_id === character.id)
    && !overriddenTransformationIds.has(transformation.id)
  );
  const catalogTemplates = catalog.filter((transformation) =>
    !transformation.owner_character_id && !transformation.source_transformation_id
  );
  const personalCatalogCopies = catalog.filter((transformation) =>
    transformation.owner_character_id === character.id && !!transformation.source_transformation_id
  );
  const grantedCatalogIds = new Set(personalCatalogCopies.map((item) => item.source_transformation_id as string));

  async function toggleCatalogGrant(templateId: string, checked: boolean) {
    if (catalogGrantBusy) return;
    if (!checked && !window.confirm("Retirar a transformação concedida desta ficha? O catálogo original não será alterado.")) return;
    setCatalogGrantBusy(true);
    try {
      const { error } = checked
        ? await db.rpc("grant_catalog_transformation_to_character", {
            _character_id: character.id, _transformation_id: templateId, _link_kind: catalogGrantTrait,
          })
        : await db.rpc("revoke_catalog_transformation_from_character", {
            _character_id: character.id, _source_transformation_id: templateId,
          });
      if (error) throw error;
      toast.success(checked ? "Transformação do catálogo concedida à ficha" : "Transformação retirada da ficha");
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["transformations"] }),
        qc.invalidateQueries({ queryKey: ["transformations", "character-transformation-images", character.id] }),
        qc.invalidateQueries({ queryKey: ["character-transformations", character.id] }),
        qc.invalidateQueries({ queryKey: ["battle-character-transformations"] }),
        qc.invalidateQueries({ queryKey: ["character-abilities", character.id] }),
        qc.invalidateQueries({ queryKey: ["transformation-abilities"] }),
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível alterar a transformação.");
    } finally {
      setCatalogGrantBusy(false);
    }
  }

  async function createPersonalTransformation() {
    const name = newTransformationName.trim();
    if (!name) { toast.error("Informe o nome da transformação"); return; }
    setCreatingTransformation(true);
    const { data, error } = await db.from("transformations").insert({
      owner_character_id: character.id,
      linked_by_race_id: newTransformationTrait === "race" ? character.race_id : null,
      linked_by_virtue_id: newTransformationTrait === "virtue" ? character.virtue_id : null,
      linked_by_class_id: newTransformationTrait === "class" ? character.class_id : null,
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
    setNewTransformationTrait("none");
    toast.success(newTransformationTrait === "none" ? "Transformação exclusiva criada nesta ficha" : "Transformação exclusiva vinculada à característica da ficha");
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["transformations"] }),
      qc.invalidateQueries({ queryKey: ["character-transformations", character.id] }),
      qc.invalidateQueries({ queryKey: ["battle-character-transformations"] }),
      qc.invalidateQueries({ queryKey: ["transformations", "character-transformation-images", character.id] }),
    ]);
  }
  const busy = loadingCatalog || loadingRaces || loadingVirtues || loadingClasses || loadingStates;

  return (
    <section className="panel space-y-4 p-4">
      <div className="flex items-center gap-2">
        <ImagePlus className="h-5 w-5 text-gold" />
        <h2 className="text-lg text-gold">{isMaster ? "Transformações e imagens da ficha" : "Transformações que você possui"}</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        {isMaster
          ? "Conceda transformações existentes do catálogo, gerencie vínculos com características e personalize imagens ou transformações exclusivas."
          : "Aqui aparecem as transformações da sua raça, virtude, classe ou ficha, com seus estados e imagens."}
      </p>
      {isMaster && (
        <section className="space-y-3 rounded-xl border border-gold/35 bg-[#110d0b]/60 p-3 sm:p-4">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gold"><Sparkles className="h-4 w-4" /> Conceder transformação já cadastrada</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Selecione uma transformação do catálogo sem modificar a original. Ela ficará disponível apenas nesta ficha,
              incluindo as habilidades que a transformação concede.
            </p>
          </div>
          <label className="block space-y-1.5 text-xs font-semibold">
            Vincular esta concessão a uma característica
            <select value={catalogGrantTrait}
              onChange={(event) => setCatalogGrantTrait(event.target.value as typeof catalogGrantTrait)}
              disabled={catalogGrantBusy}
              className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm">
              <option value="none">Sem vínculo — permanece nesta ficha</option>
              {character.race_id && <option value="race">Raça: {races.find((item) => item.id === character.race_id)?.name ?? "atual"}</option>}
              {character.virtue_id && <option value="virtue">Virtude: {virtues.find((item) => item.id === character.virtue_id)?.name ?? "atual"}</option>}
              {character.class_id && <option value="class">Classe: {classes.find((item) => item.id === character.class_id)?.name ?? "atual"}</option>}
            </select>
            <span className="block text-[11px] font-normal text-muted-foreground">
              Se escolher Raça, Classe ou Virtude, esta concessão desaparece quando o personagem perder a característica.
              Para mudar a origem de uma transformação já concedida, retire e adicione novamente.
            </span>
          </label>
          {loadingCatalog ? <p className="text-xs text-muted-foreground">Carregando catálogo…</p> : (
            <SearchableGrantPicker
              options={catalogTemplates.map((item) => ({
                id: item.id, name: item.name, description: item.description,
              }))}
              selectedIds={grantedCatalogIds}
              selectedLabel="Transformações concedidas do catálogo"
              emptyLabel="Nenhuma transformação do catálogo foi concedida diretamente."
              addLabel="Pesquisar e conceder transformação"
              searchPlaceholder="Buscar transformação já cadastrada…"
              disabled={catalogGrantBusy}
              onToggle={(id, checked) => void toggleCatalogGrant(id, checked)}
              selectedExtra={(id) => {
                const owned = personalCatalogCopies.find((item) => item.source_transformation_id === id);
                const origin = owned?.linked_by_race_id ? "Raça" : owned?.linked_by_virtue_id ? "Virtude"
                  : owned?.linked_by_class_id ? "Classe" : "Ficha";
                return <span className="rounded border border-gold/25 bg-gold/10 px-2 py-1 text-[11px] text-gold">{origin}</span>;
              }}
            />
          )}
        </section>
      )}
      {isMaster && (
        <details className="rounded-xl border border-border bg-[#100c0a]/50 p-3 sm:p-4">
          <summary className="min-h-10 cursor-pointer text-sm font-semibold text-gold">
            Criar transformação exclusiva
          </summary>
          <p className="mb-3 mt-2 text-xs text-muted-foreground">Crie uma transformação nova apenas para este personagem, separada do catálogo.</p>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(200px,0.65fr)_auto]">
            <Input value={newTransformationName} onChange={(event) => setNewTransformationName(event.target.value)} placeholder="Nome da transformação exclusiva" />
            <select className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={newTransformationTrait} onChange={(event) => setNewTransformationTrait(event.target.value as typeof newTransformationTrait)}>
              <option value="none">Sem vínculo automático</option>
              {character.race_id && <option value="race">Raça: {races.find((row) => row.id === character.race_id)?.name ?? "atual"}</option>}
              {character.virtue_id && <option value="virtue">Virtude: {virtues.find((row) => row.id === character.virtue_id)?.name ?? "atual"}</option>}
              {character.class_id && <option value="class">Classe: {classes.find((row) => row.id === character.class_id)?.name ?? "atual"}</option>}
            </select>
            <Button type="button" onClick={() => void createPersonalTransformation()} disabled={creatingTransformation || !newTransformationName.trim()}>
              <Sparkles className="mr-1 h-4 w-4" /> {creatingTransformation ? "Criando..." : "Criar transformação"}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Se vincular a uma raça, virtude ou classe, a transformação será removida automaticamente quando o personagem deixar de ter essa característica.</p>
        </details>
      )}
      {(statesError || raceLinksError || virtueLinksError || classLinksError) && (
        <p className="text-sm text-destructive">
          Não foi possível carregar todas as transformações: {String(statesError?.message ?? raceLinksError?.message ?? virtueLinksError?.message ?? classLinksError?.message ?? "erro desconhecido")}
        </p>
      )}
      {!isMaster && !busy && available.length > 0 && (
        <div className="space-y-2 rounded-md border border-gold/30 p-3">
          <h3 className="text-sm font-semibold text-gold">Lista das suas transformações</h3>
          <div className="space-y-2">
            {available.map((transformation) => {
              const state = states.find((entry) => entry.transformation_id === transformation.id);
              const fromRace = raceLinks.some((link) => link.transformation_id === transformation.id || link.transformation_id === transformation.source_transformation_id);
              const fromVirtue = virtueLinks.some((link) => link.transformation_id === transformation.id || link.transformation_id === transformation.source_transformation_id);
              const fromClass = classLinks.some((link) => link.transformation_id === transformation.id || link.transformation_id === transformation.source_transformation_id);
              return (
                <div key={transformation.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                  <span className="font-medium">{transformation.name}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {fromRace && <span className="rounded bg-gold/10 px-2 py-0.5 text-[11px] text-gold">Raça</span>}
                    {fromVirtue && <span className="rounded bg-gold/10 px-2 py-0.5 text-[11px] text-gold">Virtude</span>}
                    {fromClass && <span className="rounded bg-gold/10 px-2 py-0.5 text-[11px] text-gold">Classe</span>}
                    {transformation.owner_character_id === character.id && <span className="rounded bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-300">Exclusiva</span>}
                    {state?.active && <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-500">Ativa</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {busy ? (
        <p className="text-sm text-muted-foreground">Carregando transformações…</p>
      ) : available.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          {isMaster
            ? "Nenhuma transformação disponível. Conceda uma já cadastrada acima ou crie uma exclusiva."
            : "Você ainda não possui transformações vinculadas à sua raça, virtude ou ficha. Peça ao mestre para conceder uma."}
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {available.map((transformation) => (
            <TransformationImageCard
              key={transformation.id}
              characterId={character.id}
              raceId={character.race_id}
              virtueId={character.virtue_id}
              classId={character.class_id}
              raceName={races.find((row) => row.id === character.race_id)?.name ?? "Raça atual"}
              virtueName={virtues.find((row) => row.id === character.virtue_id)?.name ?? "Virtude atual"}
              className={classes.find((row) => row.id === character.class_id)?.name ?? "Classe atual"}
              transformation={transformation}
              state={states.find((entry) => entry.transformation_id === transformation.id)}
              isMaster={isMaster}
              isPersonal={transformation.owner_character_id === character.id}
              grantedByRace={raceLinks.some((link) => link.transformation_id === transformation.id || link.transformation_id === transformation.source_transformation_id)}
              grantedByVirtue={virtueLinks.some((link) => link.transformation_id === transformation.id || link.transformation_id === transformation.source_transformation_id)}
              grantedByClass={classLinks.some((link) => link.transformation_id === transformation.id || link.transformation_id === transformation.source_transformation_id)}
              hasCharacterState={states.some((entry) => entry.transformation_id === transformation.id)}
              defs={defs}
              damageTypes={damageTypes}
              races={races}
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
  characterId, raceId, virtueId, classId, raceName, virtueName, className, transformation, state, onSaved, isMaster, isPersonal, grantedByRace, grantedByVirtue, grantedByClass, hasCharacterState, defs, damageTypes, races,
}: {
  characterId: string;
  raceId: string | null;
  virtueId: string | null;
  classId: string | null;
  raceName: string;
  virtueName: string;
  className: string;
  transformation: Transformation;
  state?: CharacterTransformationState;
  isMaster: boolean;
  isPersonal: boolean;
  grantedByRace: boolean;
  grantedByVirtue: boolean;
  grantedByClass: boolean;
  hasCharacterState: boolean;
  defs: NonNullable<ReturnType<typeof useDefs>["data"]>;
  damageTypes: NonNullable<ReturnType<typeof useDamageTypes>["data"]>;
  races: NonNullable<ReturnType<typeof useRaces>["data"]>;
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
  const [personalTraitLink, setPersonalTraitLink] = useState<"none" | "race" | "virtue" | "class">(() => transformation.linked_by_race_id ? "race" : transformation.linked_by_virtue_id ? "virtue" : transformation.linked_by_class_id ? "class" : "none");
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
    setPersonalTraitLink(transformation.linked_by_race_id ? "race" : transformation.linked_by_virtue_id ? "virtue" : transformation.linked_by_class_id ? "class" : "none");
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

  async function saveTransformation() {
    if (!name.trim()) { toast.error("Informe o nome da transformação"); return; }
    const cleanModifiers = Object.fromEntries(Object.entries(modifiers).map(([key, value]) => [key, Math.round(Number(value) || 0)]).filter(([, value]) => value !== 0));
    const payload = {
      name: name.trim(), description: description.trim() || null,
      duration_turns: Math.max(1, Math.min(1000, Math.floor(Number(duration) || 1))),
      cooldown_turns: Math.max(1, Math.min(1000, Math.floor(Number(cooldown) || 1))),
      mana_cost: Math.max(0, Math.min(1000000, Math.floor(Number(manaCost) || 0))),
      modifiers: cleanModifiers,
      effects: effects.map((effect) => ({ ...effect, duration: Math.max(1, effect.duration) })) as unknown as Json,
      end_effects: endEffects.map((effect) => ({ ...effect, duration: Math.max(1, effect.duration) })) as unknown as Json,
      linked_by_race_id: personalTraitLink === "race" ? raceId : null,
      linked_by_virtue_id: personalTraitLink === "virtue" ? virtueId : null,
      linked_by_class_id: personalTraitLink === "class" ? classId : null,
      updated_at: new Date().toISOString(),
    };

    let savedTransformationId = transformation.id;
    if (isPersonal) {
      const { error } = await db.from("transformations").update(payload)
        .eq("id", transformation.id).eq("owner_character_id", characterId);
      if (error) { toast.error(error.message); return; }
    } else {
      // Race/virtue transformations are shared templates. Customize a copy for this character
      // instead of changing the template for every other player with the same race/virtue.
      const { data: existingCopy, error: existingCopyError } = await db.from("transformations")
        .select("id").eq("owner_character_id", characterId).eq("source_transformation_id", transformation.id).maybeSingle();
      if (existingCopyError) { toast.error(existingCopyError.message); return; }
      if (existingCopy?.id) {
        savedTransformationId = existingCopy.id;
        const { error } = await db.from("transformations").update(payload)
          .eq("id", savedTransformationId).eq("owner_character_id", characterId);
        if (error) { toast.error(error.message); return; }
      } else {
        const { data: copy, error } = await db.from("transformations").insert({
          ...payload,
          owner_character_id: characterId,
          source_transformation_id: transformation.id,
        }).select("id").single();
        if (error || !copy?.id) { toast.error(error?.message ?? "Não foi possível criar a transformação personalizada"); return; }
        savedTransformationId = copy.id;
      }
      const { error: linkError } = await db.from("character_transformations").upsert({
        character_id: characterId,
        transformation_id: savedTransformationId,
        active: false,
        cooldown_remaining: 0,
      }, { onConflict: "character_id,transformation_id", ignoreDuplicates: true });
      if (linkError) {
        await db.from("transformations").delete().eq("id", savedTransformationId);
        toast.error("Transformação copiada, mas não foi possível vinculá-la à ficha: " + linkError.message);
        return;
      }
    }

    const { error: clearGrantsError } = await db.from("transformation_abilities").delete().eq("transformation_id", savedTransformationId);
    if (clearGrantsError) { toast.error("Transformação salva, mas não foi possível atualizar habilidades concedidas: " + clearGrantsError.message); return; }
    if (abilityGrants.length > 0) {
      const { error: grantsError } = await db.from("transformation_abilities").insert(
        abilityGrants.map((grant) => ({ transformation_id: savedTransformationId, ...grant }))
      );
      if (grantsError) { toast.error("Transformação salva, mas não foi possível salvar habilidades concedidas: " + grantsError.message); return; }
    }
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["transformation-abilities", transformation.id] }),
      qc.invalidateQueries({ queryKey: ["transformation-abilities", savedTransformationId] }),
      qc.invalidateQueries({ queryKey: ["transformations"] }),
      qc.invalidateQueries({ queryKey: ["transformations", "character-transformation-images", characterId] }),
    ]);
    toast.success(isPersonal ? "Transformação salva" : "Transformação personalizada para esta ficha salva");
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
            Duração de {transformation.duration_turns} turno(s) · Cooldown de {transformation.cooldown_turns} turno(s) · {transformation.mana_cost > 0 ? `${transformation.mana_cost} Mana` : "sem custo de Mana"}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {grantedByRace && <span className="rounded bg-gold/10 px-2 py-0.5 text-[11px] text-gold">Transformação inicial da raça</span>}
            {grantedByVirtue && <span className="rounded bg-gold/10 px-2 py-0.5 text-[11px] text-gold">Transformação da virtude</span>}
            {grantedByClass && <span className="rounded bg-gold/10 px-2 py-0.5 text-[11px] text-gold">Transformação da classe</span>}
            {isPersonal && <span className="rounded bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-300">Exclusiva do personagem</span>}
            {!grantedByRace && !grantedByVirtue && !grantedByClass && !isPersonal && hasCharacterState && <span className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">Vinculada à ficha</span>}
          </div>
          {state?.active && <p className="mt-1 text-xs font-semibold text-emerald-500">Transformação ativa · {state.cooldown_remaining} turno(s)</p>}
          {transformation.description && <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{transformation.description}</p>}
        </div>
        <div className="w-full space-y-3 border-t border-border pt-3">
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gold">Modificadores de atributos</h4>
            {(() => {
              const raw = transformation.modifiers;
              const entries = raw && typeof raw === "object" && !Array.isArray(raw)
                ? Object.entries(raw as Record<string, unknown>).map(([key, value]) => [key, Number(value)] as const).filter(([, value]) => Number.isFinite(value) && value !== 0)
                : [];
              return entries.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {entries.map(([key, value]) => {
                    const label = key === "body" ? "Corpo" : key === "sanity" ? "Sanidade" : defs.find((item) => item.key === key)?.label ?? key;
                    const isPercent = key === "body" || key === "sanity";
                    return <span key={key} className={`rounded bg-muted px-2 py-1 text-xs ${value > 0 ? "text-emerald-500" : "text-destructive"}`}>
                      {value > 0 ? "+" : ""}{value}{isPercent ? "%" : ""} {label}
                    </span>;
                  })}
                </div>
              ) : <p className="text-xs text-muted-foreground">Nenhum modificador de atributo.</p>;
            })()}
          </div>
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gold">Efeitos ao ativar</h4>
            {effects.length ? effects.map((effect, index) => (
              <p key={index} className="text-xs text-muted-foreground">
                {effectSummary(effect, defs, damageTypes, races)} · Destino: {effect.target_scope === "caster" ? "Caster" : effect.target_scope === "both" ? "Ambos" : "Alvo"}
                {effect.effect_type === "healing" && effect.healing_timing !== "per_turn" ? "" : ` · ${effect.until_combat_end ? "até o fim do combate" : `${effect.duration} turno(s)`}`}
              </p>
            )) : <p className="text-xs text-muted-foreground">Nenhum efeito de ativação.</p>}
          </div>
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gold">Efeitos ao terminar</h4>
            {endEffects.length ? endEffects.map((effect, index) => (
              <p key={index} className="text-xs text-muted-foreground">
                {effectSummary(effect, defs, damageTypes, races)} · Destino: {effect.target_scope === "caster" ? "Caster" : effect.target_scope === "both" ? "Ambos" : "Alvo"}
                {effect.effect_type === "healing" && effect.healing_timing !== "per_turn" ? "" : ` · ${effect.until_combat_end ? "até o fim do combate" : `${effect.duration} turno(s)`}`}
              </p>
            )) : <p className="text-xs text-muted-foreground">Nenhum efeito de encerramento.</p>}
          </div>
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gold">Habilidades concedidas</h4>
            {abilityGrants.length ? abilityGrants.map((grant) => {
              const grantedAbility = abilityCatalog.find((ability) => ability.id === grant.ability_id);
              return <p key={grant.ability_id} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{grantedAbility?.name ?? "Habilidade indisponível"}</span>
                {grant.only_while_transformed ? " · somente enquanto a transformação estiver ativa" : " · concedida enquanto possuir a transformação"}
              </p>;
            }) : <p className="text-xs text-muted-foreground">Nenhuma habilidade concedida.</p>}
          </div>
        </div>
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = "";
        }} />
        {isMaster && (
          <Button type="button" size="sm" variant="outline" onClick={() => setEditPersonal((value) => !value)}>
            {editPersonal ? "Fechar edição" : "Editar transformação"}
          </Button>
        )}
        {isMaster && (
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
        )}
      </div>
      {isMaster && editPersonal && (
        <div className="mt-3 w-full basis-full space-y-3 rounded-md border border-gold/30 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label>Nome</Label><Input value={name} onChange={(event) => setName(event.target.value)} /></div>
            <div className="space-y-1"><Label>Duração (turnos)</Label><Input type="number" min={1} max={1000} value={duration} onChange={(event) => setDuration(event.target.value)} /></div>
            <div className="space-y-1"><Label>Cooldown (turnos)</Label><Input type="number" min={1} max={1000} value={cooldown} onChange={(event) => setCooldown(event.target.value)} /></div>
            <div className="space-y-1"><Label>Custo de Mana</Label><Input type="number" min={0} max={1000000} value={manaCost} onChange={(event) => setManaCost(event.target.value)} /></div>
            <div className="space-y-1 sm:col-span-2"><Label>Descrição</Label><Textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} /></div>
            {isMaster && <label className="block space-y-1 text-xs font-medium sm:col-span-2">Vincular transformação à característica
              <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={personalTraitLink} onChange={(event) => setPersonalTraitLink(event.target.value as typeof personalTraitLink)}>
                <option value="none">Sem vínculo automático</option>
                {raceId && <option value="race">Raça: {raceName}</option>}
                {virtueId && <option value="virtue">Virtude: {virtueName}</option>}
                {classId && <option value="class">Classe: {className}</option>}
              </select>
              <span className="block text-[11px] text-muted-foreground">A transformação será removida quando a característica escolhida for removida da ficha.</span>
            </label>}
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
          <Button type="button" onClick={() => void saveTransformation()}>{isPersonal ? "Salvar transformação" : "Personalizar transformação nesta ficha"}</Button>
        </div>
      )}
    </div>
  );
}
