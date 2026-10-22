import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Flame, Plus, Trash2, Timer } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useDamageTypes } from "@/lib/abilities";
import type { Json } from "@/integrations/supabase/types";

type DotDamageKind = "physical" | "magical";
type DotAmountMode = "fixed" | "percent";

type DotTemplate = {
  id: string;
  name: string;
  damage_kind: DotDamageKind;
  physical_damage_type_id: string | null;
  damage_type_id: string | null;
  magic_level: "baixa" | "media" | "alta" | null;
  created_at: string;
  updated_at: string;
};

type FighterOption = { id: string; name: string };

const fieldClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
const fieldLabel = "block space-y-1 text-xs font-medium text-muted-foreground";

function damageTypeLabel(template: DotTemplate, types: { id: string; name: string }[]) {
  if (template.damage_kind === "physical") {
    const name = types.find((type) => type.id === template.physical_damage_type_id)?.name ?? "tipo físico removido";
    return `Físico · ${name}`;
  }
  const name = types.find((type) => type.id === template.damage_type_id)?.name ?? "tipo mágico removido";
  const level = template.magic_level === "baixa" ? "baixa" : template.magic_level === "media" ? "média" : "alta";
  return `Mágico · ${name} · magia ${level}`;
}

export function DamageOverTimeManager({
  battleId,
  fighters,
  active,
}: {
  battleId: string | null;
  fighters: FighterOption[];
  active: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: physicalTypes = [] } = useDamageTypes("physical");
  const { data: magicalTypes = [] } = useDamageTypes("magical");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateKind, setTemplateKind] = useState<DotDamageKind>("physical");
  const [templatePhysicalTypeId, setTemplatePhysicalTypeId] = useState("");
  const [templateMagicTypeId, setTemplateMagicTypeId] = useState("");
  const [templateMagicLevel, setTemplateMagicLevel] = useState<"baixa" | "media" | "alta">("baixa");
  const [targetId, setTargetId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [amountMode, setAmountMode] = useState<DotAmountMode>("fixed");
  const [amount, setAmount] = useState("10");
  const [duration, setDuration] = useState("3");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [applyingDot, setApplyingDot] = useState(false);

  const { data: templates = [], isLoading, isError } = useQuery({
    queryKey: ["damage-over-time-templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("damage_over_time_templates")
        .select("*")
        .order("name");
      if (error) throw error;
      return (data ?? []) as DotTemplate[];
    },
  });

  useEffect(() => {
    const channel = supabase
      .channel("damage-over-time-templates-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "damage_over_time_templates" }, () => {
        void queryClient.invalidateQueries({ queryKey: ["damage-over-time-templates"] });
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [queryClient]);

  useEffect(() => {
    if (templates.length > 0 && !templates.some((template) => template.id === selectedTemplateId)) {
      setSelectedTemplateId(templates[0].id);
    }
    if (templates.length === 0 && selectedTemplateId) setSelectedTemplateId("");
  }, [templates, selectedTemplateId]);

  useEffect(() => {
    if (!fighters.some((fighter) => fighter.id === targetId)) setTargetId(fighters[0]?.id ?? "");
    if (!fighters.some((fighter) => fighter.id === sourceId)) setSourceId("");
  }, [fighters, targetId, sourceId]);

  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId);
  const allTypes = [...physicalTypes, ...magicalTypes];

  async function createTemplate() {
    const cleanName = templateName.trim();
    if (!cleanName) {
      toast.error("Informe um nome para o modelo de DoT");
      return;
    }
    if (templateKind === "physical" && !templatePhysicalTypeId) {
      toast.error("Cadastre e selecione um tipo de dano físico");
      return;
    }
    if (templateKind === "magical" && !templateMagicTypeId) {
      toast.error("Selecione um tipo de dano mágico");
      return;
    }

    setSavingTemplate(true);
    try {
      const payload = templateKind === "physical"
        ? {
            name: cleanName,
            damage_kind: "physical" as const,
            physical_damage_type_id: templatePhysicalTypeId,
            damage_type_id: null,
            magic_level: null,
          }
        : {
            name: cleanName,
            damage_kind: "magical" as const,
            physical_damage_type_id: null,
            damage_type_id: templateMagicTypeId,
            magic_level: templateMagicLevel,
          };
      const { data, error } = await supabase
        .from("damage_over_time_templates")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw error;

      setTemplateName("");
      setSelectedTemplateId(data.id);
      await queryClient.invalidateQueries({ queryKey: ["damage-over-time-templates"] });
      toast.success("Modelo de DoT salvo");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingTemplate(false);
    }
  }

  async function deleteTemplate(template: DotTemplate) {
    if (!window.confirm(`Excluir o modelo "${template.name}"? DoTs que já estão aplicados não serão removidos.`)) return;
    const { error } = await supabase.from("damage_over_time_templates").delete().eq("id", template.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["damage-over-time-templates"] });
    toast.success("Modelo de DoT excluído");
  }

  async function applyDot() {
    if (!battleId || !active) {
      toast.error("Selecione uma batalha ativa para aplicar o DoT");
      return;
    }
    if (!selectedTemplate || !targetId) {
      toast.error("Selecione um modelo de DoT e o alvo");
      return;
    }
    const numericAmount = Number(amount);
    const numericDuration = Math.floor(Number(duration));
    const maxAmount = amountMode === "percent" ? 1000 : 1_000_000;
    if (
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0 ||
      numericAmount > maxAmount ||
      (amountMode === "fixed" && !Number.isInteger(numericAmount))
    ) {
      toast.error(amountMode === "percent" ? "Informe um percentual entre 0 e 1000%" : "Informe um dano fixo inteiro entre 1 e 1000000");
      return;
    }
    if (!Number.isFinite(numericDuration) || numericDuration < 1 || numericDuration > 1000) {
      toast.error("A duração precisa ser de 1 a 1000 turnos");
      return;
    }

    const sourceCharacterId = sourceId && sourceId !== targetId ? sourceId : null;
    const effectData: Json = {
      is_damage_over_time: true,
      dot_template_id: selectedTemplate.id,
      dot_template_name: selectedTemplate.name,
      damage_kind: selectedTemplate.damage_kind,
      physical_damage_type_id: selectedTemplate.physical_damage_type_id,
      damage_type_id: selectedTemplate.damage_type_id,
      magic_level: selectedTemplate.magic_level,
      damage_mode: amountMode,
      damage_amount: numericAmount,
      source_character_id: sourceCharacterId,
    };
    const damageDescription = selectedTemplate.damage_kind === "physical"
      ? `físico · ${allTypes.find((type) => type.id === selectedTemplate.physical_damage_type_id)?.name ?? "tipo físico"}`
      : `mágico · ${allTypes.find((type) => type.id === selectedTemplate.damage_type_id)?.name ?? "tipo mágico"} · ${selectedTemplate.magic_level}`;

    setApplyingDot(true);
    try {
      const { error } = await supabase.from("battle_effects").insert({
        battle_id: battleId,
        character_id: targetId,
        target_character_id: targetId,
        name: `DoT: ${selectedTemplate.name}`,
        effect_type: "damage_over_time",
        attribute_key: null,
        polarity: "debuff",
        value_mode: amountMode,
        amount: numericAmount,
        duration: numericDuration,
        duration_scope: "individual",
        until_combat_end: false,
        damage_scope: selectedTemplate.damage_kind,
        effect_data: effectData,
      });
      if (error) throw error;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["battle-effects"] }),
        queryClient.invalidateQueries({ queryKey: ["battles"] }),
      ]);
      toast.success(`DoT aplicado: ${numericAmount}${amountMode === "percent" ? "% do HP máximo" : " de dano por turno"} · ${numericDuration} turno(s)`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setApplyingDot(false);
    }
  }

  return (
    <section className="panel space-y-4 p-4">
      <h2 className="flex items-center gap-2 text-xl text-gold">
        <Flame className="h-5 w-5" /> Dano por Turno (DoT)
      </h2>
      <p className="text-sm text-muted-foreground">
        Cadastre modelos de dano uma vez e aplique-os durante o combate. O DoT causa dano no turno do alvo,
        passa pela defesa e mitigação do tipo escolhido e perde duração depois de causar o dano final.
        Percentual é calculado sobre o HP máximo atual do alvo.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3 rounded-md border border-border p-3">
          <h3 className="font-semibold">Modelos registrados pelo mestre</h3>
          {isLoading ? <p className="text-xs text-muted-foreground">Carregando modelos…</p> : null}
          {isError ? <p className="text-xs text-destructive">Não foi possível carregar os modelos.</p> : null}
          {templates.length === 0 && !isLoading && (
            <p className="text-xs text-muted-foreground">Nenhum modelo cadastrado. Crie um modelo abaixo.</p>
          )}
          <div className="space-y-2">
            {templates.map((template) => (
              <div key={template.id} className="flex items-center gap-2 rounded border border-border/70 p-2">
                <button
                  type="button"
                  onClick={() => setSelectedTemplateId(template.id)}
                  className={`min-w-0 flex-1 rounded px-1 py-1 text-left text-sm ${selectedTemplateId === template.id ? "text-gold" : "text-foreground"}`}
                >
                  <span className="block truncate font-medium">{template.name}</span>
                  <span className="block text-xs text-muted-foreground">{damageTypeLabel(template, allTypes)}</span>
                </button>
                <Button size="icon" variant="ghost" aria-label={`Excluir modelo ${template.name}`} onClick={() => void deleteTemplate(template)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>

          <div className="space-y-3 border-t border-border pt-3">
            <h4 className="text-sm font-semibold">Cadastrar modelo</h4>
            <label className={fieldLabel}>
              Nome do DoT
              <Input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="Ex.: Queimadura, Veneno, Sangramento" />
            </label>
            <label className={fieldLabel}>
              Categoria do dano
              <select className={fieldClass} value={templateKind} onChange={(event) => setTemplateKind(event.target.value as DotDamageKind)}>
                <option value="physical">Dano físico</option>
                <option value="magical">Dano mágico</option>
              </select>
            </label>
            {templateKind === "physical" ? (
              physicalTypes.length > 0 ? (
                <label className={fieldLabel}>
                  Tipo físico
                  <select className={fieldClass} value={templatePhysicalTypeId} onChange={(event) => setTemplatePhysicalTypeId(event.target.value)}>
                    <option value="">Selecione um tipo</option>
                    {physicalTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
                  </select>
                </label>
              ) : (
                <p className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-muted-foreground">
                  Nenhum tipo físico cadastrado. Registre-o na página <strong>Tipos de Dano</strong> primeiro.
                </p>
              )
            ) : (
              <>
                <label className={fieldLabel}>
                  Tipo mágico
                  <select className={fieldClass} value={templateMagicTypeId} onChange={(event) => setTemplateMagicTypeId(event.target.value)}>
                    <option value="">Selecione um tipo</option>
                    {magicalTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
                  </select>
                </label>
                <label className={fieldLabel}>
                  Grau da magia
                  <select className={fieldClass} value={templateMagicLevel} onChange={(event) => setTemplateMagicLevel(event.target.value as "baixa" | "media" | "alta")}>
                    <option value="baixa">Baixa</option>
                    <option value="media">Média</option>
                    <option value="alta">Alta</option>
                  </select>
                </label>
              </>
            )}
            <Button className="w-full" onClick={() => void createTemplate()} disabled={savingTemplate || !templateName.trim() || (templateKind === "physical" ? !templatePhysicalTypeId : !templateMagicTypeId)}>
              <Plus className="mr-1 h-4 w-4" /> {savingTemplate ? "Salvando…" : "Salvar modelo de DoT"}
            </Button>
          </div>
        </div>

        <div className="space-y-3 rounded-md border border-border p-3">
          <h3 className="font-semibold">Aplicar DoT no combate</h3>
          {(!battleId || !active) && (
            <p className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-muted-foreground">
              Os modelos podem ser cadastrados a qualquer momento. Selecione uma batalha ativa no topo da página para aplicar um DoT.
            </p>
          )}
          <label className={fieldLabel}>
            Modelo
            <select className={fieldClass} value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)} disabled={templates.length === 0}>
              <option value="">Selecione um modelo</option>
              {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
            </select>
          </label>
          <label className={fieldLabel}>
            Alvo
            <select className={fieldClass} value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              <option value="">Selecione o alvo</option>
              {fighters.map((fighter) => <option key={fighter.id} value={fighter.id}>{fighter.name}</option>)}
            </select>
          </label>
          <label className={fieldLabel}>
            Origem do DoT (opcional)
            <select className={fieldClass} value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
              <option value="">Nenhum (sem Dano Causado de origem)</option>
              {fighters.filter((fighter) => fighter.id !== targetId).map((fighter) => <option key={fighter.id} value={fighter.id}>{fighter.name}</option>)}
            </select>
            <span className="text-[11px]">Se selecionar um personagem, os modificadores de Dano Causado dele também entram no cálculo de cada tick.</span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={fieldLabel}>
              Valor por turno
              <select className={fieldClass} value={amountMode} onChange={(event) => setAmountMode(event.target.value as DotAmountMode)}>
                <option value="fixed">Dano fixo</option>
                <option value="percent">% do HP máximo do alvo</option>
              </select>
            </label>
            <label className={fieldLabel}>
              {amountMode === "percent" ? "Percentual (%)" : "Dano por turno"}
              <Input type="number" min={amountMode === "percent" ? 0.1 : 1} max={amountMode === "percent" ? 1000 : 1000000} step={amountMode === "percent" ? "any" : "1"} value={amount} onChange={(event) => setAmount(event.target.value)} />
            </label>
          </div>
          <label className={fieldLabel}>
            Duração (turnos do alvo)
            <Input type="number" min="1" max="1000" step="1" value={duration} onChange={(event) => setDuration(event.target.value)} />
          </label>
          <div className="rounded border border-border/70 p-3 text-xs text-muted-foreground">
            {selectedTemplate ? (
              <>
                <div className="font-medium text-foreground">{selectedTemplate.name} · {damageTypeLabel(selectedTemplate, allTypes)}</div>
                <div className="mt-1">
                  {amountMode === "percent" ? `${amount || "0"}% do HP máximo` : `${amount || "0"} de dano bruto`} por turno, durante {duration || "0"} turno(s).
                </div>
              </>
            ) : "Cadastre ou selecione um modelo antes de aplicar."}
          </div>
          <Button className="w-full" onClick={() => void applyDot()} disabled={!battleId || !active || applyingDot || !selectedTemplate || !targetId}>
            <Timer className="mr-1 h-4 w-4" /> {applyingDot ? "Aplicando…" : "Aplicar DoT"}
          </Button>
        </div>
      </div>
    </section>
  );
}
