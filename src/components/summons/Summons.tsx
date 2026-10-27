import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ghost, Plus, Trash2, Shield, Sparkles, Eye } from "lucide-react";
import { SummonDetailsDialog } from "@/components/summons/SummonDetailsDialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SearchableGrantPicker } from "@/components/ui/searchable-grant-picker";
import { Input } from "@/components/ui/input";
import { useDefs } from "@/lib/sheets";
import { supabase } from "@/integrations/supabase/client";

type Stats = Record<string, number>;
type SummonGrant = {
  id: string;
  summoner_character_id: string | null;
  ability_id: string | null;
  template_character_id: string;
  display_name: string;
  custom_stats: Stats;
  transfer_stats: Stats;
  borrowed_assignment_ids: string[];
};
type CharacterOption = { id: string; name: string };
type AbilityOption = { id: string; name: string };
type SummonInstance = {
  id: string; battle_id: string; grant_id: string | null;
  summoned_character_id: string; summoner_character_id: string;
  template_character_id: string; transferred_stats: Stats;
};
const db = supabase as any;

function useSummonGrants() {
  return useQuery<SummonGrant[]>({
    queryKey: ["summon-grants"],
    queryFn: async () => {
      const { data, error } = await db.from("summon_grants").select("*").order("created_at");
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 7000,
  });
}

function useSummonTemplates(enabled: boolean) {
  return useQuery<CharacterOption[]>({
    queryKey: ["summon-templates"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db.from("characters")
        .select("id,name").eq("is_summon_snapshot", false).order("name");
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 5000,
  });
}

function SummonStatsFields({ title, help, value, onChange }: {
  title: string; help: string; value: Stats; onChange: (next: Stats) => void;
}) {
  const { data: defs = [] } = useDefs();
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{help}</p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {defs.map((def) => (
          <label key={def.key} className="space-y-1 text-xs">
            <span>{def.label}</span>
            <Input
              type="number" min={0} max={1000000} step={1}
              placeholder="Padrão"
              value={value[def.key] ?? ""}
              onChange={(event) => {
                const raw = event.target.value;
                const updated = { ...value };
                if (!raw.trim()) delete updated[def.key];
                else updated[def.key] = Number(raw);
                onChange(updated);
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function SummonGrantCard({ grant, master, templateOptions, onRefresh, onViewDetails }: {
  grant: SummonGrant; master: boolean; templateOptions: CharacterOption[]; onRefresh: () => void;
  onViewDetails: (grantId:string) => void;
}) {
  const [name, setName] = useState(grant.display_name);
  const [customStats, setCustomStats] = useState<Stats>(grant.custom_stats ?? {});
  const [transferStats, setTransferStats] = useState<Stats>(grant.transfer_stats ?? {});
  const [borrowedIds, setBorrowedIds] = useState<string[]>(grant.borrowed_assignment_ids ?? []);
  const [busy, setBusy] = useState(false);
  const { data: options = [] } = useQuery<AbilityOption[]>({
    queryKey: ["summon-borrowed-assignments", grant.template_character_id],
    enabled: master && !!grant.summoner_character_id,
    queryFn: async () => {
      const { data, error } = await db.from("character_abilities")
        .select("id,name").eq("character_id", grant.template_character_id).order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  useEffect(() => {
    setName(grant.display_name);
    setCustomStats(grant.custom_stats ?? {});
    setTransferStats(grant.transfer_stats ?? {});
    setBorrowedIds(grant.borrowed_assignment_ids ?? []);
  }, [grant.id, grant.display_name, grant.custom_stats, grant.transfer_stats, grant.borrowed_assignment_ids]);

  const templateName = templateOptions.find((item) => item.id === grant.template_character_id)?.name ?? grant.display_name ?? "Criatura cadastrada";
  async function save() {
    setBusy(true);
    try {
      const { error } = await db.from("summon_grants").update({
        display_name: name.trim(),
        custom_stats: customStats,
        transfer_stats: transferStats,
        borrowed_assignment_ids: grant.summoner_character_id ? borrowedIds : [],
      }).eq("id", grant.id);
      if (error) throw error;
      toast.success("Invocação configurada");
      onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Falha ao salvar invocação");
    } finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm("Remover esta configuração de invocação? Habilidades emprestadas serão retiradas.")) return;
    setBusy(true);
    const { error } = await db.from("summon_grants").delete().eq("id", grant.id);
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    onRefresh();
  }
  return (
    <article className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-semibold text-gold">{name || templateName}</p>
          <p className="text-xs text-muted-foreground">Ficha de origem: {templateName}</p>
        </div>
        {master && <Button size="icon" variant="ghost" disabled={busy} onClick={() => void remove()} aria-label="Remover invocação"><Trash2 className="h-4 w-4"/></Button>}
      </div>
      <Button type="button" size="sm" variant="outline" className="min-h-11 w-full border-gold/30 text-gold sm:w-auto"
        onClick={() => onViewDetails(grant.id)}>
        <Eye className="mr-2 h-4 w-4" /> Ver detalhes da criatura
      </Button>
      {master ? (
        <>
          <label className="block space-y-1 text-xs">Nome da invocação
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={templateName} />
          </label>
          <SummonStatsFields title="Atributos personalizados" help="Deixe vazio para copiar o valor da ficha registrada; um número define o atributo da criatura ao ser invocada. Para Mana, use pontos de Mana convertidos normalmente na ficha." value={customStats} onChange={setCustomStats} />
          <SummonStatsFields title="Atributos transferidos do invocador" help="Valores retirados temporariamente do invocador e adicionados à criatura enquanto ela estiver no combate. Também poderão ser alterados antes de invocar." value={transferStats} onChange={setTransferStats} />
          {!!grant.summoner_character_id && (
            <div className="space-y-2 rounded-md border border-border p-3">
              <p className="text-sm font-semibold">Habilidades disponíveis sem invocar</p>
              <p className="text-xs text-muted-foreground">Selecione habilidades da criatura para conceder diretamente à ficha do invocador.</p>
              <SearchableGrantPicker
                options={options}
                selectedIds={new Set(borrowedIds)}
                selectedLabel="Habilidades emprestadas"
                emptyLabel="Nenhuma habilidade da criatura foi emprestada."
                addLabel="Emprestar habilidade"
                searchPlaceholder="Buscar habilidade da criatura…"
                onToggle={(id, checked) => setBorrowedIds((current) => checked
                  ? current.includes(id) ? current : [...current, id]
                  : current.filter((item) => item !== id))}
              />
              {!options.length && <p className="text-xs text-muted-foreground">Esta ficha não tem habilidades atribuídas.</p>}
            </div>
          )}
          <Button size="sm" disabled={busy} onClick={() => void save()}>Salvar invocação</Button>
        </>
      ) : (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>Modo: {Object.keys(customStats).length ? "atributos personalizados" : "atributos originais"}.</p>
          {Object.keys(transferStats).length > 0 && <p>Transferência: {Object.entries(transferStats).map(([k,v]) => `${k}: ${v}`).join(", ")}</p>}
          {borrowedIds.length > 0 && <p>{borrowedIds.length} habilidade(s) emprestada(s), disponíveis mesmo sem invocar.</p>}
        </div>
      )}
    </article>
  );
}

export function SummonGrantsEditor({ characterId, abilityId, master }: {
  characterId?: string; abilityId?: string; master: boolean;
}) {
  const qc = useQueryClient();
  const { data: grants = [] } = useSummonGrants();
  const { data: templates = [] } = useSummonTemplates(master);
  const [templateId, setTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [detailsGrantId, setDetailsGrantId] = useState<string|null>(null);
  const current = grants.filter((grant) => characterId
    ? grant.summoner_character_id === characterId
    : grant.ability_id === abilityId);
  const available = templates.filter((c) => c.id !== characterId);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["summon-grants"] });
    void qc.invalidateQueries({ queryKey: ["character-abilities"] });
    void qc.invalidateQueries({ queryKey: ["summon-borrowed-assignments"] });
  };

  async function add() {
    if (!templateId) { toast.error("Escolha uma ficha registrada para invocar"); return; }
    setBusy(true);
    const { error } = await db.from("summon_grants").insert({
      summoner_character_id: characterId ?? null,
      ability_id: abilityId ?? null,
      template_character_id: templateId,
      display_name: available.find((option) => option.id === templateId)?.name ?? "",
      custom_stats: {},
      transfer_stats: {},
      borrowed_assignment_ids: [],
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    setTemplateId("");
    toast.success("Invocação vinculada");
    refresh();
  }

  return (
    <section className="panel space-y-3 p-4">
      <h3 className="flex items-center gap-2 text-lg font-semibold text-gold"><Ghost className="h-5 w-5"/> Invocações</h3>
      <p className="text-xs text-muted-foreground">
        {characterId
          ? "Criaturas que este personagem pode invocar no combate. O mestre pode emprestar algumas habilidades da criatura ao personagem."
          : "Criaturas invocadas automaticamente ao ativar esta habilidade durante um combate."}
      </p>
      {!current.length && <p className="text-sm text-muted-foreground">Nenhuma invocação configurada.</p>}
      {current.map((grant) => <SummonGrantCard key={grant.id} grant={grant} master={master}
        templateOptions={templates} onRefresh={refresh} onViewDetails={setDetailsGrantId}/>)}
      <SummonDetailsDialog grantId={detailsGrantId} onClose={()=>setDetailsGrantId(null)} />
      {master && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <select className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            <option value="">Selecione a ficha da criatura</option>
            {available.map((option) => <option value={option.id} key={option.id}>{option.name}</option>)}
          </select>
          <Button size="sm" disabled={busy || !templateId} onClick={() => void add()}>
            <Plus className="mr-1 h-4 w-4"/> Vincular invocação
          </Button>
        </div>
      )}
    </section>
  );
}

function SummonInstanceEditor({ instance, name, onRefresh }: {
  instance: SummonInstance; name: string; onRefresh: () => void;
}) {
  const { data: defs = [] } = useDefs();
  const [editing, setEditing] = useState(false);
  const [bonus, setBonus] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const { data: stats = [] } = useQuery<Array<{attribute_key: string; bonus: number; points: number; max_value: number; current_value: number}>>({
    queryKey: ["summon-instance-stats", instance.summoned_character_id],
    queryFn: async () => {
      const { data,error } = await db.from("character_attributes")
        .select("attribute_key,bonus,points,max_value,current_value")
        .eq("character_id",instance.summoned_character_id);
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 5000,
  });
  const save = async () => {
    setBusy(true);
    const { error } = await db.rpc("update_summon_stat_bonuses", {
      _summoned_character_id: instance.summoned_character_id,
      _bonuses: bonus,
    });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Atributos da invocação ajustados");
    onRefresh();
    setEditing(false);
  };
  return (
    <div className="space-y-2 rounded-md border border-gold/25 p-3">
      <p className="text-sm font-semibold text-gold">{name}</p>
      <p className="text-xs text-muted-foreground">Invocação ativa: participa do combate com ficha independente.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => {
          if (!editing) setBonus(Object.fromEntries(stats.map(s => [s.attribute_key, s.bonus])));
          setEditing(!editing);
        }}> {editing ? "Cancelar ajustes" : "Ajustar atributos"}</Button>
        <Button size="sm" variant="destructive" disabled={busy} onClick={async () => {
          if (!confirm("Remover invocação e devolver os atributos ao invocador?")) return;
          setBusy(true);
          const { error } = await db.rpc("remove_summon_companion", {
            _summoned_character_id: instance.summoned_character_id, _battle_id: instance.battle_id,
          });
          setBusy(false);
          if (error) { toast.error(error.message); return; }
          toast.success("Invocação retirada; atributos devolvidos");
          onRefresh();
        }}>Remover invocação</Button>
      </div>
      {editing && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Ajuste os bônus dos atributos desta criatura apenas para o combate atual. HP e Mana atuais continuam editáveis no cartão da criatura.</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {defs.map((def) => {
              const stat = stats.find((item) => item.attribute_key === def.key);
              if (!stat) return null;
              return (
                <label key={def.key} className="space-y-1 text-xs">{def.label} · bônus
                  <Input type="number" min={-1000000} max={1000000} step={1}
                    value={bonus[def.key] ?? stat.bonus}
                    onChange={(event) => setBonus((current) => ({ ...current, [def.key]: Number(event.target.value) }))} />
                </label>
              );
            })}
          </div>
          <Button size="sm" disabled={busy} onClick={() => void save()}>Salvar atributos no combate</Button>
        </div>
      )}
    </div>
  );
}

export function SummonCombatPanel({ characterId, characterName, battleId, master, visible, showEmptyState = false }: {
  characterId: string; characterName: string; battleId: string; master: boolean; visible: boolean;
  showEmptyState?: boolean;
}) {
  const qc = useQueryClient();
  const { data: allGrants = [] } = useSummonGrants();
  const { data: defs = [] } = useDefs();
  const [transferOverrides, setTransferOverrides] = useState<Record<string, Stats>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detailsGrantId, setDetailsGrantId] = useState<string|null>(null);
  const { data: abilityIds = [] } = useQuery<string[]>({
    queryKey: ["summon-ability-source-ids", characterId],
    enabled: visible,
    refetchInterval: 5000,
    queryFn: async () => {
      const { data,error } = await db.from("character_abilities").select("ability_id").eq("character_id",characterId);
      if (error) throw error;
      return (data ?? []).flatMap((a: { ability_id: string | null }) => a.ability_id ? [a.ability_id] : []);
    },
  });
  const { data: instances = [] } = useQuery<SummonInstance[]>({
    queryKey: ["active-summons",battleId],
    enabled: visible,
    queryFn: async () => {
      const { data,error } = await db.from("active_summons").select("*").eq("battle_id",battleId);
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: 5000,
  });
  const { data: summons = [] } = useQuery<CharacterOption[]>({
    queryKey: ["active-summon-names",battleId],
    enabled: visible && instances.length>0,
    queryFn: async () => {
      const { data,error } = await db.from("characters")
        .select("id,name").in("id",instances.map((s) => s.summoned_character_id));
      if (error) throw error;
      return data ?? [];
    },
  });
  const refresh = () => {
    for (const key of ["battles","battle-effects","character-active-effects","active-summons","active-summon-names","summon-instance-stats","character-abilities"]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };
  const grants = allGrants.filter((g) =>
    g.summoner_character_id===characterId || (!!g.ability_id && abilityIds.includes(g.ability_id)));
  const currentInstances = instances.filter(s => s.summoner_character_id===characterId);
  const activeGrantIds = new Set(currentInstances.map(s => s.grant_id));
  const labelFor = (s: SummonInstance) => summons.find(c => c.id===s.summoned_character_id)?.name
    ?? allGrants.find(g => g.id===s.grant_id)?.display_name ?? "Criatura invocada";
  if (!visible) return null;
  if (!grants.length && !currentInstances.length) {
    return showEmptyState ? (
      <div className="rounded-lg border border-dashed border-border p-5 text-center">
        <Ghost className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-semibold">Nenhuma invocação disponível para {characterName}</p>
        <p className="mt-1 text-xs text-muted-foreground">As invocações cadastradas para este personagem ou concedidas pelas suas habilidades aparecerão aqui.</p>
      </div>
    ) : null;
  }

  return (
    <section className="mt-3 space-y-3 rounded-md border border-gold/30 bg-gold/5 p-3">
      <h3 className="flex items-center gap-2 font-semibold text-gold"><Ghost className="h-4 w-4"/> Invocações de {characterName}</h3>
      {grants.map(g => {
        const active = activeGrantIds.has(g.id);
        const transfer = transferOverrides[g.id] ?? g.transfer_stats ?? {};
        return (
          <div className="space-y-2 rounded-md border border-border bg-background/30 p-3" key={g.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">{g.display_name || "Invocação cadastrada"}</span>
              <span className="text-xs text-muted-foreground">{active ? "Em combate" : g.ability_id ? "Vinculada à habilidade" : "Disponível"}</span>
            </div>
            <Button type="button" size="sm" variant="outline" className="min-h-11 w-full border-gold/30 text-gold sm:w-auto"
              onClick={()=>setDetailsGrantId(g.id)}>
              <Eye className="mr-2 h-4 w-4"/> Ver detalhes da criatura
            </Button>
            {master && !active && (
              <>
                <p className="text-xs text-muted-foreground">Ajuste quanto {characterName} emprestará de cada atributo antes de invocar. Os valores retornam ao remover a criatura.</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {defs.map((d) => (
                    <label key={d.key} className="space-y-1 text-xs">{d.label}
                      <Input type="number" min={0} max={1000000} step={1}
                        value={transfer[d.key] ?? ""}
                        placeholder="0"
                        onChange={(event) => {
                          const next={ ...transfer };
                          if (!event.target.value) delete next[d.key]; else next[d.key]=Number(event.target.value);
                          setTransferOverrides(prev => ({ ...prev,[g.id]: next }));
                        }}
                      />
                    </label>
                  ))}
                </div>
                <Button size="sm" disabled={busyId!==null} onClick={async () => {
                  setBusyId(g.id);
                  const { error } = await db.rpc("summon_character_companion",{
                    _grant_id:g.id,_summoner_id:characterId,_battle_id:battleId,_transfer_override:transfer,
                  });
                  setBusyId(null);
                  if (error) { toast.error(error.message); return; }
                  toast.success("Criatura invocada!");
                  refresh();
                }}><Sparkles className="mr-1 h-4 w-4"/> Invocar criatura</Button>
              </>
            )}
          </div>
        );
      })}
      {currentInstances.map(s => master
        ? <SummonInstanceEditor key={s.id} instance={s} name={labelFor(s)} onRefresh={refresh}/>
        : <div key={s.id} className="space-y-2 rounded-md border border-gold/20 p-3 text-xs">
            <p>{labelFor(s)} está participando do combate.</p>
            {s.grant_id && <Button type="button" size="sm" variant="outline" className="min-h-11 w-full sm:w-auto"
              onClick={()=>setDetailsGrantId(s.grant_id)}>
              <Eye className="mr-2 h-4 w-4"/> Ver HP, status e habilidades
            </Button>}
          </div>
      )}
      <SummonDetailsDialog grantId={detailsGrantId} onClose={()=>setDetailsGrantId(null)}/>
      {!master && <p className="text-xs text-muted-foreground">Somente o mestre pode invocar ou ajustar os atributos no combate.</p>}
    </section>
  );
}
