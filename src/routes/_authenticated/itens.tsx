import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Gem, ImagePlus, Plus, Save, Search, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import { useAbilities, type AbilityEffectDefinition } from "@/lib/abilities";
import { accessoryPhoto, itemGrantSummary, type ItemTemplate, useItemTemplates } from "@/lib/inventory";
import { useDefs, useMe } from "@/lib/sheets";
import { supabase } from "@/integrations/supabase/client";

const db = supabase as any;

type Option = { id: string; name: string };
type GrantKey = "ability_ids" | "transformation_ids" | "summon_character_ids";

export const Route = createFileRoute("/_authenticated/itens")({
  head: () => ({ meta: [
    { title: "Itens e acessórios — Grimório" },
    { name: "description", content: "Cadastre acessórios e seus poderes para conceder aos personagens." },
  ] }),
  component: ItemCatalogPage,
});

function GrantedResources({ title, options, values, onChange }: {
  title: string; options: Option[]; values: string[]; onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const matching = options.filter(option =>
    option.name.toLocaleLowerCase("pt-BR").includes(query.toLocaleLowerCase("pt-BR")) && !values.includes(option.id)
  ).slice(0, 35);
  return (
    <div className="space-y-2 rounded-xl border border-gold/20 p-3">
      <button className="flex min-h-10 w-full items-center justify-between gap-2 text-left text-sm font-semibold text-gold"
        type="button" onClick={() => setExpanded(v => !v)}>
        <span>{title} ({values.length})</span><span className="text-xs text-muted-foreground">{expanded ? "Recolher" : "Configurar"}</span>
      </button>
      {values.length > 0 && <div className="flex flex-wrap gap-1.5">
        {values.map(id => <button key={id} type="button" onClick={() => onChange(values.filter(other => other !== id))}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/25 bg-gold/5 px-2 text-xs hover:border-red-500/40">
          <span className="max-w-44 truncate">{options.find(option => option.id === id)?.name ?? "Registro indisponível"}</span>
          <X className="h-3.5 w-3.5 text-red-300" />
        </button>)}
      </div>}
      {expanded && <div className="space-y-2">
        <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={"Pesquisar " + title.toLocaleLowerCase("pt-BR") + "…"} />
        <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
          {matching.length === 0 && <p className="p-2 text-xs text-muted-foreground">Nenhuma opção disponível.</p>}
          {matching.map(option => <button key={option.id} type="button" onClick={() => onChange([...values, option.id])}
            className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-xs hover:bg-gold/10">
            <Plus className="h-3.5 w-3.5 text-gold" /> <span className="min-w-0 flex-1 truncate">{option.name}</span>
          </button>)}
        </div>
      </div>}
    </div>
  );
}

function ItemEditor({ item, abilities, transformations, creatures, defs }: {
  item: ItemTemplate; abilities: Option[]; transformations: Option[]; creatures: Option[]; defs: NonNullable<ReturnType<typeof useDefs>["data"]>;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const [effects, setEffects] = useState<AbilityEffectDefinition[]>(item.effects);
  const [abilityIds, setAbilityIds] = useState<string[]>(item.ability_ids);
  const [transformationIds, setTransformationIds] = useState<string[]>(item.transformation_ids);
  const [summonIds, setSummonIds] = useState<string[]>(item.summon_character_ids);
  const [busy, setBusy] = useState(false);
  const [photoPath, setPhotoPath] = useState(item.image_path);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setName(item.name); setDescription(item.description); setEffects(item.effects);
    setAbilityIds(item.ability_ids); setTransformationIds(item.transformation_ids);
    setSummonIds(item.summon_character_ids); setPhotoPath(item.image_path);
  }, [item.id, item.updated_at]);

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["inventory-templates"] });
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["inventory"] }),
      qc.invalidateQueries({ queryKey: ["character-abilities"] }),
      qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
      qc.invalidateQueries({ queryKey: ["character-transformations"] }),
      qc.invalidateQueries({ queryKey: ["battle-character-transformations"] }),
      qc.invalidateQueries({ queryKey: ["summon-grants"] }),
      qc.invalidateQueries({ queryKey: ["transformations"] }),
    ]);
  }

  async function save(path = photoPath) {
    if (!name.trim()) { toast.error("Informe o nome do acessório"); return false; }
    const { error } = await db.from("item_templates").update({
      name: name.trim(), description, image_path: path, effects,
      ability_ids: abilityIds, transformation_ids: transformationIds,
      summon_character_ids: summonIds, updated_at: new Date().toISOString(),
    }).eq("id", item.id);
    if (error) { toast.error(error.message); return false; }
    setPhotoPath(path);
    toast.success("Acessório salvo. Benefícios dos personagens equipados sincronizados.");
    await refresh();
    return true;
  }

  async function upload(file: File) {
    if (!["image/jpeg","image/png","image/webp","image/gif"].includes(file.type) || file.size > 8 * 1024 * 1024) {
      toast.error("Envie JPEG, PNG, WEBP ou GIF de até 8 MB"); return;
    }
    setBusy(true);
    const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : file.type === "image/gif" ? "gif" : "jpg";
    const path = item.id + "/" + crypto.randomUUID() + "." + extension;
    try {
      const { error: uploadError } = await supabase.storage.from("item-images").upload(path, file, { upsert: false, contentType: file.type });
      if (uploadError) throw uploadError;
      const saved = await save(path);
      if (!saved) await supabase.storage.from("item-images").remove([path]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha ao enviar a imagem");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("Excluir este acessório do catálogo? Não é possível excluir itens que ainda estão em algum inventário.")) return;
    setBusy(true);
    const { error } = await db.from("item_templates").delete().eq("id", item.id);
    setBusy(false);
    if (error) toast.error(error.message);
    else { toast.success("Acessório excluído"); await refresh(); }
  }

  const path = accessoryPhoto(photoPath);
  return (
    <article className="panel min-w-0 space-y-3 border-gold/25 p-3 sm:p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-gold/25 bg-gold/5">
          {path ? <img src={path} alt={item.name} loading="lazy" className="h-full w-full object-cover" /> : <Gem className="h-8 w-8 text-gold/50" />}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="truncate font-display text-lg font-bold text-gold">{item.name}</h2>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Acessório</p>
          <p className="line-clamp-2 text-xs text-muted-foreground">{itemGrantSummary(item)}</p>
          <Button size="sm" variant="outline" className="mt-1 min-h-10" onClick={() => setOpen(v => !v)}>
            {open ? "Recolher configuração" : "Editar e ver detalhes"}
          </Button>
        </div>
      </div>
      {open && <div className="space-y-4 border-t border-gold/20 pt-3">
        <div className="grid gap-3 sm:grid-cols-[150px_minmax(0,1fr)]">
          <div className="space-y-2">
            <div className="flex aspect-square items-center justify-center overflow-hidden rounded-xl border border-gold/25 bg-background/60">
              {path ? <img src={path} alt="" className="h-full w-full object-cover" /> : <ImagePlus className="h-9 w-9 text-gold/40" />}
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
              onChange={event => { const file=event.target.files?.[0]; if (file) void upload(file); event.target.value=""; }} />
            <Button size="sm" className="w-full min-h-10" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
              <Upload className="mr-1.5 h-4 w-4" /> Enviar imagem
            </Button>
          </div>
          <div className="space-y-3">
            <label className="block space-y-1 text-sm">Nome do item
              <Input maxLength={140} value={name} onChange={event => setName(event.target.value)} />
            </label>
            <label className="block space-y-1 text-sm">Descrição
              <Textarea rows={4} value={description} onChange={event => setDescription(event.target.value)} placeholder="Aparência, história e funcionamento do acessório…" />
            </label>
          </div>
        </div>
        <div className="rounded-xl border border-gold/20 p-3">
          <AbilityEffectsEditor effects={effects} onChange={setEffects} defs={defs}
            permanent isPassive hideTargeting allowHealing={false} allowPeriodicHealing={false}
            title="Efeitos enquanto equipado"
            description="Efeitos passivos do sistema de habilidades. São removidos quando o acessório é desequipado."
            permanentNote="Ativo apenas enquanto este acessório estiver equipado." />
        </div>
        <GrantedResources title="Habilidades concedidas" options={abilities} values={abilityIds} onChange={setAbilityIds} />
        <GrantedResources title="Transformações concedidas" options={transformations} values={transformationIds} onChange={setTransformationIds} />
        <GrantedResources title="Invocações concedidas" options={creatures} values={summonIds} onChange={setSummonIds} />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button disabled={busy} className="min-h-11 flex-1" onClick={() => {
            setBusy(true); void save().finally(() => setBusy(false));
          }}><Save className="mr-1.5 h-4 w-4" /> {busy ? "Salvando…" : "Salvar acessório"}</Button>
          <Button disabled={busy} variant="destructive" onClick={() => void remove()}><Trash2 className="mr-1.5 h-4 w-4" /> Excluir</Button>
        </div>
      </div>}
    </article>
  );
}

function ItemCatalogPage() {
  const { data: me } = useMe();
  const { data: items = [], isLoading, error } = useItemTemplates(!!me?.isMaster);
  const { data: abilityCatalog = [] } = useAbilities();
  const { data: defs = [] } = useDefs();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const { data: transforms = [] } = useQuery<Option[]>({
    queryKey: ["inventory-transformation-options"], enabled: !!me?.isMaster,
    queryFn: async () => {
      const { data, error } = await db.from("transformations").select("id,name").is("owner_character_id",null).is("source_transformation_id",null).order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: creatures = [] } = useQuery<Option[]>({
    queryKey: ["inventory-creature-options"], enabled: !!me?.isMaster,
    queryFn: async () => {
      const { data, error } = await db.from("characters").select("id,name").eq("is_summon_snapshot",false).order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  if (!me) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  if (!me.isMaster) return <p className="panel p-5 text-muted-foreground">Somente o mestre pode cadastrar itens.</p>;

  async function create() {
    setCreating(true);
    const { error } = await db.from("item_templates").insert({ name: "Novo acessório", item_type: "accessory" });
    setCreating(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Acessório criado. Abra-o para configurar.");
    await qc.invalidateQueries({ queryKey: ["inventory-templates"] });
  }

  return (
    <div className="min-w-0 space-y-4 pb-12">
      <header className="grimorio-section-header flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-bold text-gold sm:text-3xl"><Gem className="h-6 w-6" /> Itens e acessórios</h1>
          <p className="mt-1 text-sm text-muted-foreground">Cadastre acessórios uma vez e conceda cópias a qualquer inventário. Apenas o mestre edita o catálogo.</p>
        </div>
        <Button disabled={creating} onClick={() => void create()} className="min-h-11"><Plus className="mr-1.5 h-4 w-4" /> Novo acessório</Button>
      </header>
      <div className="panel flex items-center gap-2 p-3">
        <Search className="h-4 w-4 text-muted-foreground" />
        <Input aria-label="Buscar acessório" value={search} onChange={event => setSearch(event.target.value)} placeholder="Pesquisar itens…" className="border-0" />
        <span className="shrink-0 text-xs text-muted-foreground">{items.length} item(ns)</span>
      </div>
      {error && <p role="alert" className="text-sm text-red-300">{error.message}</p>}
      {isLoading && <p className="text-sm text-muted-foreground">Carregando catálogo…</p>}
      <div className="grid items-start gap-3 xl:grid-cols-2">
        {items.filter(item => item.name.toLocaleLowerCase("pt-BR").includes(search.toLocaleLowerCase("pt-BR"))).map(item => (
          <ItemEditor key={item.id} item={item} abilities={abilityCatalog.map(({id,name}) => ({id,name}))}
            transformations={transforms} creatures={creatures} defs={defs} />
        ))}
      </div>
      {!isLoading && items.length===0 && <p className="panel p-6 text-sm text-muted-foreground">Nenhum acessório cadastrado. Crie o primeiro para começar.</p>}
    </div>
  );
}
