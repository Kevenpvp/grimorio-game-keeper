import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Backpack, Check, Gem, Package, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { useMe } from "@/lib/sheets";
import { accessoryPhoto, invalidateInventory, itemGrantSummary, useCharacterInventory, useItemTemplates } from "@/lib/inventory";

const db = supabase as any;

export function InventoryPanel({ characterId, master = false, combat = false }: {
  characterId: string; master?: boolean; combat?: boolean;
}) {
  const { data: me } = useMe();
  const { data, isLoading, error } = useCharacterInventory(characterId);
  const { data: templates = [] } = useItemTemplates(master && !combat);
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [slotsInput, setSlotsInput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: grantDetails } = useQuery<{
    abilities: Array<{id:string;name:string}>;
    transformations: Array<{id:string;name:string}>;
    summons: Array<{id:string;name:string}>;
  }>({
    queryKey: ["inventory-grant-details", selectedId],
    enabled: !!selectedId,
    queryFn: async () => {
      const { data: details, error } = await db.rpc("inventory_item_grant_details", { _item_id: selectedId });
      if (error) throw error;
      return details;
    },
  });

  if (isLoading) return <div className="panel p-4 text-sm text-muted-foreground">Carregando inventário…</div>;
  if (error || !data) return <div role="alert" className="panel border-red-500/40 p-4 text-sm text-red-300">Não foi possível consultar o inventário: {error instanceof Error ? error.message : "Erro desconhecido"}</div>;

  const canEquip = master || !!(me?.user?.id && me.user.id === data.ownerId);
  const items = data.items;
  const selected = items.find(item => item.id === selectedId);
  const equipped = items.filter(item => item.equipped);
  const bySlot = new Map(items.map(item => [item.slot_index, item]));

  async function run(action: () => Promise<{ error: { message: string } | null }>, success: string) {
    if (busy) return;
    setBusy(true);
    try {
      const { error } = await action();
      if (error) throw error;
      toast.success(success);
      invalidateInventory(qc, characterId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (e as {message?: string})?.message ?? "Não foi possível modificar o inventário");
    } finally {
      setBusy(false);
    }
  }

  const img = (path: string | null, name: string, className = "h-full w-full object-cover") => {
    const src = accessoryPhoto(path);
    return src ? <img src={src} alt={name} loading="lazy" className={className} /> :
      <Gem aria-hidden="true" className="h-8 w-8 text-gold/60" />;
  };

  return (
    <section className="panel min-w-0 space-y-4 border-gold/30 p-3 sm:p-5" aria-label="Inventário do personagem">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-xl font-semibold text-gold">
            <Backpack className="h-5 w-5" /> Inventário
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">Acessórios e equipamentos pertencentes a esta ficha.</p>
        </div>
        <span className="rounded-full border border-gold/30 bg-gold/10 px-3 py-1.5 text-xs font-bold tabular-nums text-gold">
          {items.length} / {data.slots} slots
        </span>
      </div>

      {equipped.length > 0 && (
        <div className="rounded-xl border border-emerald-700/35 bg-emerald-950/10 p-3">
          <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-emerald-300"><ShieldCheck className="h-4 w-4" /> Acessórios equipados ({equipped.length})</p>
          <div className="flex flex-wrap gap-2">
            {equipped.map(item => (
              <button key={item.id} type="button" onClick={() => setSelectedId(item.id)}
                className="flex min-h-11 items-center gap-2 rounded-lg border border-emerald-600/30 bg-background/65 px-2 py-1 text-left text-xs hover:border-gold/55">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-gold/10">{img(item.item_templates.image_path, item.item_templates.name)}</span>
                <span className="max-w-36 truncate font-medium">{item.item_templates.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6" aria-label="Slots do inventário">
        {Array.from({length: data.slots}, (_, index) => {
          const item = bySlot.get(index + 1);
          return item ? (
            <button key={index} type="button" onClick={() => setSelectedId(item.id)}
              className={"group relative min-w-0 overflow-hidden rounded-xl border bg-[#110e0c] p-2 text-left transition-colors hover:border-gold " + (item.equipped ? "border-emerald-600/55" : "border-gold/25")}>
              <div className="relative mx-auto flex aspect-square max-h-32 items-center justify-center overflow-hidden rounded-lg bg-gold/5">
                {img(item.item_templates.image_path, item.item_templates.name)}
                {item.equipped && <span className="absolute right-1 top-1 rounded-full bg-emerald-800 p-1 text-white"><Check className="h-3 w-3" /></span>}
              </div>
              <p className="mt-2 truncate text-[11px] font-semibold">{item.item_templates.name}</p>
              <p className={"mt-0.5 text-[10px] " + (item.equipped ? "text-emerald-300" : "text-muted-foreground")}>{item.equipped ? "Equipado" : "Guardado"}</p>
            </button>
          ) : (
            <div key={index} className="flex min-h-28 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-gold/15 bg-background/30 p-2 text-muted-foreground/40">
              <Package aria-hidden="true" className="h-6 w-6" />
              <span className="text-[10px]">Slot {index + 1}</span>
            </div>
          );
        })}
        {data.slots === 0 && <p className="col-span-full rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">Inventário sem slots. O mestre pode aumentar a capacidade.</p>}
      </div>

      {master && !combat && (
        <details className="space-y-3 rounded-xl border border-gold/25 bg-background/30 p-3">
          <summary className="min-h-9 cursor-pointer text-sm font-semibold text-gold">Administração do inventário</summary>
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="max-w-40 flex-1 space-y-1 text-xs">
                <span>Quantidade de slots</span>
                <Input aria-label="Quantidade de slots" type="number" min={0} max={200}
                  value={slotsInput ?? String(data.slots)} onChange={e => setSlotsInput(e.target.value)} />
              </label>
              <Button variant="outline" disabled={busy} onClick={() => {
                const slots = Number(slotsInput ?? data.slots);
                if (!Number.isInteger(slots) || slots < 0 || slots > 200) return toast.error("Informe entre 0 e 200 slots");
                void run(() => db.rpc("inventory_set_slots", {_character_id: characterId,_slots: slots}), "Capacidade atualizada");
              }}>Salvar slots</Button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <select aria-label="Escolher item para adicionar" value={templateId} onChange={e => setTemplateId(e.target.value)}
                className="min-h-11 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm">
                <option value="">Selecionar acessório cadastrado…</option>
                {templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
              </select>
              <Button disabled={busy || !templateId || items.length >= data.slots} onClick={() =>
                void run(() => db.rpc("inventory_add_item",{_character_id:characterId,_template_id:templateId}),"Item adicionado ao inventário")
              }><Plus className="mr-1 h-4 w-4" /> Adicionar item</Button>
            </div>
            <p className="text-xs text-muted-foreground">Somente o mestre adiciona e remove itens. Crie os acessórios no menu Itens.</p>
          </div>
        </details>
      )}

      <Dialog open={!!selected} onOpenChange={open => { if (!open) setSelectedId(null); }}>
        <DialogContent className="max-h-[92dvh] max-w-lg overflow-y-auto border-gold/35">
          {selected && <>
            <DialogHeader>
              <DialogTitle className="font-display text-xl text-gold">{selected.item_templates.name}</DialogTitle>
              <DialogDescription>Acessório · slot {selected.slot_index} · {selected.equipped ? "Equipado" : "Guardado"}</DialogDescription>
            </DialogHeader>
            <div className="flex justify-center">
              <div className="flex aspect-square w-36 items-center justify-center overflow-hidden rounded-xl border border-gold/30 bg-background/50 sm:w-48">
                {img(selected.item_templates.image_path, selected.item_templates.name)}
              </div>
            </div>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{selected.item_templates.description || "Sem descrição."}</p>
            <div className="space-y-2 rounded-xl border border-gold/25 bg-gold/5 p-3 text-xs">
              <p className="font-semibold text-gold">Benefícios enquanto equipado</p>
              <p className="text-muted-foreground">{itemGrantSummary(selected.item_templates)}</p>
              {selected.item_templates.effects.map((effect, index) => <p key={index}>✦ {effect.name || effect.effect_type}</p>)}
              {!!grantDetails?.abilities.length && <div className="space-y-1 border-t border-gold/20 pt-2">
                <p className="font-semibold text-gold">Habilidades</p>
                {grantDetails.abilities.map(entry => <p key={entry.id}>⚡ {entry.name}</p>)}
              </div>}
              {!!grantDetails?.transformations.length && <div className="space-y-1 border-t border-gold/20 pt-2">
                <p className="font-semibold text-gold">Transformações</p>
                {grantDetails.transformations.map(entry => <p key={entry.id}>✨ {entry.name}</p>)}
              </div>}
              {!!grantDetails?.summons.length && <div className="space-y-1 border-t border-gold/20 pt-2">
                <p className="font-semibold text-gold">Invocações</p>
                {grantDetails.summons.map(entry => <p key={entry.id}>👻 {entry.name}</p>)}
              </div>}
            </div>
            {canEquip && <Button className="min-h-11 w-full" variant={selected.equipped ? "outline" : "default"} disabled={busy}
              onClick={() => void run(() => db.rpc("inventory_set_equipped",{_item_id:selected.id,_equipped:!selected.equipped}),
                selected.equipped ? "Acessório desequipado" : "Acessório equipado")}>
              {selected.equipped ? <><X className="mr-2 h-4 w-4" /> Desequipar</> : <><ShieldCheck className="mr-2 h-4 w-4" /> Equipar</>}
            </Button>}
            {master && !combat && <Button variant="destructive" className="min-h-11 w-full" disabled={busy}
              onClick={() => {
                if (!window.confirm("Retirar este item do inventário? Os benefícios concedidos serão removidos.")) return;
                void run(() => db.rpc("inventory_remove_item",{_item_id:selected.id}), "Item removido");
                setSelectedId(null);
              }}><Trash2 className="mr-2 h-4 w-4" /> Remover do inventário</Button>}
          </>}
        </DialogContent>
      </Dialog>
    </section>
  );
}
