import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Gem, ImagePlus, Plus, Save, Search, Swords, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import { useAbilities, type Ability, type AbilityEffectDefinition } from "@/lib/abilities";
import { AbilityEditor } from "@/routes/_authenticated/habilidades";
import { accessoryPhoto, itemGrantSummary, type ItemTemplate, type WeaponDamageConfig, weaponDamageSummary, useItemTemplates } from "@/lib/inventory";
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

function ItemEditor({ item, abilities, abilityDefinitions, transformations, creatures, defs }: {
  item: ItemTemplate; abilities: Option[]; abilityDefinitions: Ability[]; transformations: Option[]; creatures: Option[]; defs: NonNullable<ReturnType<typeof useDefs>["data"]>;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(item.name);
  const [weaponDamage, setWeaponDamage] = useState<WeaponDamageConfig>(item.weapon_damage);
  const [itemType, setItemType] = useState<"accessory" | "weapon">(item.item_type);
  const { data: damageTypes = [] } = useQuery<Array<{id:string;name:string;category:"physical"|"magical"}>>({
    queryKey: ["damage-types"],
    queryFn: async () => {
      const { data, error } = await db.from("damage_types").select("id,name,category").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const [description, setDescription] = useState(item.description);
  const [effects, setEffects] = useState<AbilityEffectDefinition[]>(item.effects);
  const [abilityIds, setAbilityIds] = useState<string[]>(item.ability_ids);
  const [transformationIds, setTransformationIds] = useState<string[]>(item.transformation_ids);
  const [summonIds, setSummonIds] = useState<string[]>(item.summon_character_ids);
  const [busy, setBusy] = useState(false);
  const [photoPath, setPhotoPath] = useState(item.image_path);
  const [open, setOpen] = useState(false);
  const [editingWeaponAbilityId, setEditingWeaponAbilityId] = useState<string | null>(null);

  useEffect(() => {
    setName(item.name); setDescription(item.description); setEffects(item.effects);
    setItemType(item.item_type); setWeaponDamage(item.weapon_damage);
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
    if (!name.trim()) { toast.error("Informe o nome do item"); return false; }
    if (itemType === "weapon") {
      if (weaponDamage.uses_ammo && (!Number.isInteger(weaponDamage.ammo_max) || weaponDamage.ammo_max < 1 || weaponDamage.ammo_max > 100000)) {
        toast.error("A munição máxima precisa ser um inteiro entre 1 e 100000."); return false;
      }
      if ((weaponDamage.damage_kind === "magical" || weaponDamage.damage_kind === "hybrid") &&
        !damageTypes.some((entry) => entry.id === weaponDamage.damage_type_id && entry.category === "magical")) {
        toast.error("Selecione o tipo de dano mágico da arma."); return false;
      }
      if ((weaponDamage.damage_kind === "physical" || weaponDamage.damage_kind === "hybrid") &&
        weaponDamage.physical_damage_type_id &&
        !damageTypes.some((entry) => entry.id === weaponDamage.physical_damage_type_id && entry.category === "physical")) {
        toast.error("Selecione um tipo físico válido para a arma."); return false;
      }
    }
    const { error } = await db.from("item_templates").update({
      name: name.trim(), description, image_path: path, effects,
      item_type: itemType, weapon_damage: weaponDamage,
      ...(itemType === "weapon" ? {} : { ability_ids: abilityIds }), transformation_ids: transformationIds,
      summon_character_ids: summonIds, updated_at: new Date().toISOString(),
    }).eq("id", item.id);
    if (error) { toast.error(error.message); return false; }
    if (itemType === "weapon") {
      const { data: ids, error: abilitiesError } = await db.rpc("inventory_weapon_set_abilities", {
        _item_template_id: item.id, _requested_ids: abilityIds,
      });
      if (abilitiesError) {
        toast.error("Item salvo, mas não foi possível vincular as habilidades da arma: " + abilitiesError.message);
        await refresh();
        return false;
      }
      if (Array.isArray(ids)) setAbilityIds(ids);
      await qc.invalidateQueries({ queryKey: ["abilities"] });
    }
    setPhotoPath(path);
    toast.success((itemType === "weapon" ? "Arma" : "Acessório") + " salvo(a). Benefícios dos personagens equipados sincronizados.");
    await refresh();
    return true;
  }

  async function createWeaponAbility() {
    setBusy(true);
    try {
      const { data: abilityId, error } = await db.rpc("inventory_weapon_create_ability", { _item_template_id: item.id });
      if (error) throw error;
      setAbilityIds((current) => current.includes(abilityId) ? current : [...current, abilityId]);
      setEditingWeaponAbilityId(abilityId);
      toast.success("Habilidade exclusiva criada. Configure e salve os detalhes abaixo.");
      await qc.invalidateQueries({ queryKey: ["abilities"] });
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível criar a habilidade.");
    } finally {
      setBusy(false);
    }
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
    if (!window.confirm("Excluir este item do catálogo? Não é possível excluir itens que ainda estão em algum inventário.")) return;
    setBusy(true);
    const { error } = await db.from("item_templates").delete().eq("id", item.id);
    setBusy(false);
    if (error) toast.error(error.message);
    else { toast.success("Item excluído"); await refresh(); }
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
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{item.item_type === "weapon" ? "Arma" : "Acessório"}</p>
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
              <Textarea rows={4} value={description} onChange={event => setDescription(event.target.value)} placeholder="Aparência, história e funcionamento do item…" />
            </label>
            <label className="block space-y-1 text-sm">Categoria
              <select aria-label="Categoria do item" className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={itemType} onChange={event => setItemType(event.target.value === "weapon" ? "weapon" : "accessory")}>
                <option value="accessory">Acessório</option>
                <option value="weapon">Arma</option>
              </select>
            </label>
          </div>
        </div>
        {itemType === "weapon" && (
          <section className="space-y-3 rounded-xl border border-red-500/30 bg-red-500/5 p-3 sm:p-4">
            <h3 className="flex items-center gap-2 text-base font-semibold text-gold"><Swords className="h-4 w-4" /> Dano da arma</h3>
            <p className="text-xs text-muted-foreground">
              Ao usar esta arma equipada em Aplicar dano em, o sistema usa a categoria configurada
              e acrescenta o bônus a cada golpe antes de defesa e mitigação. Pode combinar com outros efeitos e habilidades.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs font-medium">Categoria de dano
                <select aria-label="Categoria de dano da arma" className="min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={weaponDamage.damage_kind}
                  onChange={event => setWeaponDamage(current => ({
                    ...current, damage_kind: event.target.value as WeaponDamageConfig["damage_kind"],
                  }))}>
                  <option value="physical">Físico</option>
                  <option value="magical">Mágico</option>
                  <option value="hybrid">Híbrido (físico + mágico)</option>
                  <option value="true">Verdadeiro</option>
                </select>
              </label>
              <label className="space-y-1 text-xs font-medium">Bônus de dano
                <select aria-label="Modo de bônus da arma" className="min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={weaponDamage.bonus_mode}
                  onChange={event => setWeaponDamage(current => ({
                    ...current, bonus_mode: event.target.value === "percent" ? "percent" : "fixed",
                    bonus_amount: 0,
                  }))}>
                  <option value="fixed">Valor fixo extra por golpe</option>
                  <option value="percent">% extra do dano bruto por golpe</option>
                </select>
              </label>
              <label className="space-y-1 text-xs font-medium">{weaponDamage.bonus_mode === "percent" ? "Dano extra (%)" : "Dano fixo extra"}
                <Input type="number" min={0} max={weaponDamage.bonus_mode === "percent" ? 1000 : 1000000}
                  step={weaponDamage.bonus_mode === "percent" ? "0.1" : "1"}
                  value={weaponDamage.bonus_amount}
                  onChange={event => setWeaponDamage(current => {
                    const raw = Number(event.target.value);
                    const amount = Number.isFinite(raw) ? Math.max(0, Math.min(raw, current.bonus_mode === "percent" ? 1000 : 1000000)) : 0;
                    return { ...current, bonus_amount: current.bonus_mode === "fixed" ? Math.floor(amount) : amount };
                  })} />
              </label>
              {(weaponDamage.damage_kind === "physical" || weaponDamage.damage_kind === "hybrid") && (
                <label className="space-y-1 text-xs font-medium">Tipo de dano físico
                  <select className="min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={weaponDamage.physical_damage_type_id ?? ""}
                    onChange={event => setWeaponDamage(current => ({...current, physical_damage_type_id: event.target.value || null}))}>
                    <option value="">Sem subtipo físico</option>
                    {damageTypes.filter(type => type.category === "physical").map(type => (
                      <option key={type.id} value={type.id}>{type.name}</option>
                    ))}
                  </select>
                </label>
              )}
              {(weaponDamage.damage_kind === "magical" || weaponDamage.damage_kind === "hybrid") && (
                <>
                  <label className="space-y-1 text-xs font-medium">Tipo de dano mágico
                    <select className="min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={weaponDamage.damage_type_id ?? ""}
                      onChange={event => setWeaponDamage(current => ({...current, damage_type_id: event.target.value || null}))}>
                      <option value="">Selecionar tipo mágico</option>
                      {damageTypes.filter(type => type.category === "magical").map(type => (
                        <option key={type.id} value={type.id}>{type.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs font-medium">Grau da magia
                    <select className="min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={weaponDamage.magic_level}
                      onChange={event => setWeaponDamage(current => ({
                        ...current, magic_level: event.target.value as WeaponDamageConfig["magic_level"],
                      }))}>
                      <option value="baixa">Baixa</option>
                      <option value="media">Média</option>
                      <option value="alta">Alta</option>
                    </select>
                  </label>
                </>
              )}
            </div>
            <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
              <label className="flex min-h-11 items-center gap-3 text-sm font-semibold text-amber-200">
                <input type="checkbox" checked={weaponDamage.uses_ammo}
                  onChange={event => setWeaponDamage(current => ({ ...current, uses_ammo: event.target.checked }))}
                  className="h-5 w-5 shrink-0 accent-amber-500" />
                <span>Esta arma utiliza munição</span>
              </label>
              {weaponDamage.uses_ammo && <>
                <label className="block space-y-1 text-xs font-semibold">Munição máxima (mínimo: 0)
                  <Input type="number" min={1} max={100000} step={1} value={weaponDamage.ammo_max}
                    onChange={event => setWeaponDamage(current => ({ ...current, ammo_max: Number(event.target.value) }))}
                    aria-label="Munição máxima da arma" />
                </label>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Cada exemplar começa cheio, com limite de {weaponDamage.ammo_max || 0}. Cada golpe em Aplicar Dano Em consome 1 munição.
                  Quando acabar, o mestre poderá recarregar no inventário.
                </p>
              </>}
            </div>
            <p className="text-xs font-medium text-gold">{weaponDamageSummary(weaponDamage)} · por golpe acertado</p>
          </section>
        )}
        <div className="rounded-xl border border-gold/20 p-3">
          <AbilityEffectsEditor effects={effects} onChange={setEffects} defs={defs}
            permanent isPassive hideTargeting allowHealing={false} allowPeriodicHealing={false}
            title="Efeitos enquanto equipado"
            description="Efeitos passivos do sistema de habilidades. São removidos quando o acessório é desequipado."
            permanentNote="Ativo apenas enquanto este item estiver equipado." />
        </div>
        <GrantedResources title="Habilidades concedidas" options={[
          ...abilities,
          ...abilityDefinitions.filter((entry) => (entry as Ability & { weapon_item_template_id?: string | null }).weapon_item_template_id === item.id)
            .map(({ id, name }) => ({ id, name })),
        ]} values={abilityIds} onChange={setAbilityIds} />
        {itemType === "weapon" && (
          <section className="space-y-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-gold">Habilidades exclusivas desta arma</h3>
                <p className="mt-1 text-xs text-muted-foreground">Crie habilidades próprias com custos, efeitos, atributos, ataques e scripts, sem cadastrá-las na lista geral.</p>
              </div>
              <Button type="button" size="sm" disabled={busy} onClick={() => void createWeaponAbility()}>
                <Plus className="mr-1.5 h-4 w-4" /> Nova habilidade da arma
              </Button>
            </div>
            {abilityDefinitions.filter((entry) =>
              abilityIds.includes(entry.id) && (entry as Ability & { weapon_item_template_id?: string | null }).weapon_item_template_id === item.id
            ).map((ability) => (
              <div key={ability.id} className="min-w-0 space-y-2">
                <button type="button" className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-violet-500/25 bg-background/50 px-3 text-left text-sm"
                  onClick={() => setEditingWeaponAbilityId((id) => id === ability.id ? null : ability.id)}>
                  <span className="min-w-0 flex-1 truncate font-semibold">{ability.name}</span>
                  <span className="shrink-0 text-xs text-gold">{editingWeaponAbilityId === ability.id ? "Recolher" : "Editar"}</span>
                </button>
                {editingWeaponAbilityId === ability.id && (
                  <AbilityEditor ability={ability} defs={defs} isNew={false} hideDelete
                    onSaved={() => { void refresh(); }} />
                )}
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">
              Para desvincular uma habilidade, remova-a na seção Habilidades concedidas e salve a arma.
              As cópias de habilidades globais compartilhadas ficam independentes entre armas.
            </p>
          </section>
        )}
        <GrantedResources title="Transformações concedidas" options={transformations} values={transformationIds} onChange={setTransformationIds} />
        <GrantedResources title="Invocações concedidas" options={creatures} values={summonIds} onChange={setSummonIds} />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button disabled={busy} className="min-h-11 flex-1" onClick={() => {
            setBusy(true); void save().finally(() => setBusy(false));
          }}><Save className="mr-1.5 h-4 w-4" /> {busy ? "Salvando…" : "Salvar item"}</Button>
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

  async function create(type: "accessory" | "weapon") {
    setCreating(true);
    const { error } = await db.from("item_templates").insert({
      name: type === "weapon" ? "Nova arma" : "Novo acessório", item_type: type,
    });
    setCreating(false);
    if (error) { toast.error(error.message); return; }
    toast.success((type === "weapon" ? "Arma criada" : "Acessório criado") + ". Abra para configurar.");
    await qc.invalidateQueries({ queryKey: ["inventory-templates"] });
  }

  return (
    <div className="min-w-0 space-y-4 pb-12">
      <header className="grimorio-section-header flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-bold text-gold sm:text-3xl"><Gem className="h-6 w-6" /> Itens e acessórios</h1>
          <p className="mt-1 text-sm text-muted-foreground">Cadastre acessórios e armas com habilidades, efeitos, invocações e transformações. Apenas o mestre edita o catálogo.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={creating} variant="outline" onClick={() => void create("accessory")} className="min-h-11">
            <Plus className="mr-1.5 h-4 w-4" /> Novo acessório
          </Button>
          <Button disabled={creating} onClick={() => void create("weapon")} className="min-h-11">
            <Swords className="mr-1.5 h-4 w-4" /> Nova arma
          </Button>
        </div>
      </header>
      <div className="panel flex items-center gap-2 p-3">
        <Search className="h-4 w-4 text-muted-foreground" />
        <Input aria-label="Buscar item ou arma" value={search} onChange={event => setSearch(event.target.value)} placeholder="Pesquisar itens…" className="border-0" />
        <span className="shrink-0 text-xs text-muted-foreground">{items.length} item(ns)</span>
      </div>
      {error && <p role="alert" className="text-sm text-red-300">{error.message}</p>}
      {isLoading && <p className="text-sm text-muted-foreground">Carregando catálogo…</p>}
      {(["accessory", "weapon"] as const).map(type => {
        const categoryItems = items.filter(item =>
          item.item_type === type && item.name.toLocaleLowerCase("pt-BR").includes(search.toLocaleLowerCase("pt-BR"))
        );
        return (
          <section key={type} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 border-b border-gold/25 pb-2">
              {type === "weapon" ? <Swords className="h-5 w-5 text-gold" /> : <Gem className="h-5 w-5 text-gold" />}
              <h2 className="font-display text-xl text-gold">{type === "weapon" ? "Armas" : "Acessórios"}</h2>
              <span className="text-xs text-muted-foreground">({categoryItems.length})</span>
            </div>
            {categoryItems.length > 0 ? (
              <div className="grid items-start gap-3 xl:grid-cols-2">
                {categoryItems.map(item => (
                  <ItemEditor key={item.id} item={item}
                    abilities={abilityCatalog.filter((ability) => !(ability as Ability & { weapon_item_template_id?: string | null }).weapon_item_template_id).map(({id,name}) => ({id,name}))}
                    abilityDefinitions={abilityCatalog}
                    transformations={transforms} creatures={creatures} defs={defs} />
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-gold/20 p-4 text-xs text-muted-foreground">
                {search ? "Nenhum item desta categoria corresponde à pesquisa." :
                  type === "weapon" ? "Nenhuma arma cadastrada. Clique em Nova arma." :
                    "Nenhum acessório cadastrado."}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
