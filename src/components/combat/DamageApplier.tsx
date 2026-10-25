import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HeartPulse, Shield, Sparkles, Swords, Zap, Plus, Trash2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import { DefenseIgnoreInputs } from "@/components/abilities/DefenseIgnoreInputs";
import { applyAbilityTargetDamage, isValidAbilityTargetAdjustment } from "@/lib/ability-attack-damage";
import { defenseIgnoreText, ZERO_DEFENSE_IGNORE, type DefenseIgnore } from "@/lib/defense-ignore";
import { type AbilityEffectDefinition, useDotTemplates } from "@/lib/abilities";
import { useDefs } from "@/lib/sheets";
import type { Json } from "@/integrations/supabase/types";

type DamageKind = "physical" | "magical" | "hybrid" | "true";
type MagicLevel = "baixa" | "media" | "alta";
type DamageType = { id: string; name: string; category: "physical" | "magical" };

export type DamageTarget = { id: string; name: string };
type DamageSource = { id: string; name: string };
type ManualDotDraft = { templateId: string; damageMode: "fixed" | "percent"; amount: string; duration: string };
export function DamageApplier({ target, battleId = null, sources = [], defaultSourceCharacterId = null }: {
  target: DamageTarget;
  battleId?: string | null;
  sources?: DamageSource[];
  defaultSourceCharacterId?: string | null;
}) {
  const qc = useQueryClient();
  const [damageMode, setDamageMode] = useState<"repeat" | "list">("repeat");
  const [damageKind, setDamageKind] = useState<DamageKind>("physical");
  const [damageValue, setDamageValue] = useState("20");
  const [repeatCount, setRepeatCount] = useState("1");
  const [damageList, setDamageList] = useState("50, 35, 45, 86, 20, 10, 50");
  const [damageTypeId, setDamageTypeId] = useState("");
  const [physicalDamageTypeId, setPhysicalDamageTypeId] = useState("");
  const [magicLevel, setMagicLevel] = useState<MagicLevel>("baixa");
  const [sourceCharacterId, setSourceCharacterId] = useState(defaultSourceCharacterId ?? "");
  const [criticalDamage, setCriticalDamage] = useState(false);
  const [extraDamageFixed, setExtraDamageFixed] = useState("0");
  const [extraDamagePercent, setExtraDamagePercent] = useState("0");
  const [defenseIgnore, setDefenseIgnore] = useState<DefenseIgnore>({ ...ZERO_DEFENSE_IGNORE });
  const [applyingDamage, setApplyingDamage] = useState(false);
  const [effects, setEffects] = useState<AbilityEffectDefinition[]>([]);
  const [dots, setDots] = useState<ManualDotDraft[]>([]);
  const [selectedDotTemplateId, setSelectedDotTemplateId] = useState("");
  const [applyingEffectsOnly, setApplyingEffectsOnly] = useState(false);
  const { data: defs = [] } = useDefs();
  const { data: dotTemplates = [], isLoading: loadingDotTemplates } = useDotTemplates();
  useEffect(() => {
    if (defaultSourceCharacterId) setSourceCharacterId(defaultSourceCharacterId);
  }, [defaultSourceCharacterId]);
  useEffect(() => {
    if (!dotTemplates.some((template) => template.id === selectedDotTemplateId)) {
      setSelectedDotTemplateId(dotTemplates[0]?.id ?? "");
    }
  }, [dotTemplates, selectedDotTemplateId]);

  const { data: damageTypes = [], isLoading: loadingTypes, error: typesError } = useQuery({
    queryKey: ["damage-types"],
    queryFn: async () => {
      const { data, error } = await supabase.from("damage_types").select("id,name,category").order("name");
      if (error) throw error;
      return data as DamageType[];
    },
  });

  const magicalDamageTypes = damageTypes.filter((type) => type.category === "magical");
  const physicalDamageTypes = damageTypes.filter((type) => type.category === "physical");
  const needsMagic = damageKind === "magical" || damageKind === "hybrid";
  const needsPhysical = damageKind === "physical" || damageKind === "hybrid";
  const selectedPhysicalDamageTypeId = physicalDamageTypes.some((type) => type.id === physicalDamageTypeId)
    ? physicalDamageTypeId
    : physicalDamageTypes[0]?.id ?? "";
  const selectedMagicDamageTypeId = magicalDamageTypes.some((type) => type.id === damageTypeId)
    ? damageTypeId
    : magicalDamageTypes[0]?.id ?? "";
  const damageKindName = {
    physical: "Físico",
    magical: "Mágico",
    hybrid: "Híbrido",
    true: "Verdadeiro",
  }[damageKind];

  function payloadDots(): Array<Record<string, unknown>> {
    return dots.flatMap((dot) => {
      const template = dotTemplates.find((item) => item.id === dot.templateId);
      if (!template) return [];
      const amount = Number(dot.amount);
      const duration = Math.floor(Number(dot.duration));
      const max = dot.damageMode === "percent" ? 1000 : 1000000;
      if (!Number.isFinite(amount) || amount <= 0 || amount > max || (dot.damageMode === "fixed" && !Number.isInteger(amount))) {
        throw new Error("Informe um valor válido para o DoT " + template.name + ".");
      }
      if (!Number.isInteger(duration) || duration < 1 || duration > 1000) throw new Error("A duração do DoT " + template.name + " precisa ficar entre 1 e 1000 turnos.");
      return [{
        id: template.id, template_id: template.id, name: template.name, damage_kind: template.damage_kind,
        physical_damage_type_id: template.physical_damage_type_id, damage_type_id: template.damage_type_id,
        magic_level: template.magic_level, damage_mode: dot.damageMode, damage_amount: amount, duration,
      }];
    });
  }

  async function applyConfiguredEffects(sourceOverride?: string | null) {
    if (!effects.length && !dots.length) {
      toast.error("Adicione pelo menos um efeito ou DoT primeiro.");
      return false;
    }
    let dotPayload: Array<Record<string, unknown>>;
    try { dotPayload = payloadDots(); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); return false; }
    const sourceId = (sourceOverride ?? sourceCharacterId) || null;
    const { data, error } = await supabase.rpc("apply_manual_character_effects", {
      _character_id: target.id,
      ...(battleId ? { _battle_id: battleId } : {}),
      ...(sourceId ? { _source_character_id: sourceId } : {}),
      _effects: effects as unknown as Json,
      _dots: dotPayload as unknown as Json,
      _permanent: false,
    });
    if (error) throw error;
    const count = Number(data ?? 0);
    if (count < 1) {
      toast.info("Nenhum efeito foi aplicado. Confira as imunidades a DoTs e os alvos.");
    } else {
      toast.success(String(count) + " efeito(s)/DoT(s) temporário(s) aplicado(s) em " + target.name + ".");
    }
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["battle-effects"] }),
      qc.invalidateQueries({ queryKey: ["character-active-effects"] }),
      ...(sourceId ? [qc.invalidateQueries({ queryKey: ["character", sourceId] })] : []),
      qc.invalidateQueries({ queryKey: ["battles"] }),
      qc.invalidateQueries({ queryKey: ["character", target.id] }),
      qc.invalidateQueries({ queryKey: ["characters"] }),
      qc.invalidateQueries({ queryKey: ["my-character"] }),
      qc.invalidateQueries({ queryKey: ["manual-sheet-effects", target.id] }),
    ]);
    return true;
  }

  async function applyEffectsOnly() {
    setApplyingEffectsOnly(true);
    try { await applyConfiguredEffects(); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setApplyingEffectsOnly(false); }
  }

  async function applyDamage(sourceOverride?: string | null) {
    let values: number[];
    if (damageMode === "repeat") {
      const amount = Number(damageValue);
      const count = Number(repeatCount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1000000 ||
          !Number.isInteger(count) || count < 1 || count > 200) {
        setCriticalDamage(false);
        toast.error("Informe um dano válido e uma quantidade de 1 a 200 golpes");
        return;
      }
      values = Array.from({ length: count }, () => amount);
    } else {
      const parts = damageList.split(/[,;\s]+/).filter(Boolean);
      values = parts.map(Number);
      if (values.length < 1 || values.length > 200 ||
          values.some((n) => !Number.isFinite(n) || n < 0 || n > 1000000)) {
        setCriticalDamage(false);
        toast.error("Informe de 1 a 200 danos válidos, separados por vírgula");
        return;
      }
    }
    const adjustmentFixed = Number(extraDamageFixed);
    const adjustmentPercent = Number(extraDamagePercent);
    if (!isValidAbilityTargetAdjustment(adjustmentFixed, adjustmentPercent)) {
      toast.error("Ajuste fixo deve ser inteiro entre -1.000.000 e +1.000.000; percentual entre -100% e +1000%.");
      return;
    }
    // Each hit uses its own raw value, even in list mode. Damage bonuses from
    // the source and armor/mitigation are still calculated on the server.
    values = values.map((value) => applyAbilityTargetDamage(value, adjustmentFixed, adjustmentPercent));

    if (needsMagic && !selectedMagicDamageTypeId) {
      setCriticalDamage(false);
      toast.error("Selecione um tipo de dano mágico");
      return;
    }
    if (needsPhysical && physicalDamageTypes.length > 0 && !selectedPhysicalDamageTypeId) {
      setCriticalDamage(false);
      toast.error("Selecione um tipo de dano físico");
      return;
    }
    if (loadingTypes && (needsMagic || needsPhysical)) {
      setCriticalDamage(false);
      toast.error("Aguarde o carregamento dos tipos de dano");
      return;
    }

    const criticalDamageForThisHit = criticalDamage;
    const effectiveSourceCharacterId = (sourceOverride ?? sourceCharacterId) || null;
    setApplyingDamage(true);
    try {
      const { data: runtimeResponse, error } = await supabase.functions.invoke("ability-runtime", {
        body: {
          action: "apply_damage",
          battle_id: battleId,
          _battle_id: battleId,
          _character_id: target.id,
          _damage_kind: damageKind,
          _damage_type_id: needsMagic ? selectedMagicDamageTypeId : null,
          _physical_damage_type_id: needsPhysical && physicalDamageTypes.length > 0 ? selectedPhysicalDamageTypeId : null,
          _damage_values: values,
          _magic_level: needsMagic ? magicLevel : null,
          _source_character_id: effectiveSourceCharacterId,
          _critical_damage: criticalDamageForThisHit,
          _defense_ignore: damageKind === "true" ? ZERO_DEFENSE_IGNORE : defenseIgnore,
        },
      });
      if (error) {
        let message = error.message;
        const errorContext = (error as { context?: unknown }).context;
        if (errorContext instanceof Response) {
          try {
            const responseBody = await errorContext.clone().json() as { error?: unknown; message?: unknown };
            const serverMessage = typeof responseBody.error === "string"
              ? responseBody.error
              : typeof responseBody.message === "string" ? responseBody.message : null;
            if (serverMessage) message = serverMessage;
          } catch {
            // Keep the SDK message if the error response has no JSON body.
          }
        }
        toast.error(message, { duration: 10000 });
        return;
      }

      const result = (runtimeResponse as { damage_result?: {
        hits: number;
        physical_defense: number;
        magical_defense: number;
        total_damage: number;
        hp_before: number;
        hp_after: number;
        final_damage_by_hit?: number[];
        custom_script_hooks?: { processed: number; errors: string[] };
        damage_fixed_modifier?: number;
        damage_percent_modifier?: number;
        damage_source_character_id?: string | null;
        damage_any_fixed_modifier?: number;
        damage_any_percent_modifier?: number;
        damage_physical_fixed_modifier?: number;
        damage_physical_percent_modifier?: number;
        damage_magical_fixed_modifier?: number;
        damage_magical_percent_modifier?: number;
        physical_reduction_fixed?: number;
        physical_reduction_percent?: number;
        magical_reduction_fixed?: number;
        magical_reduction_percent?: number;
        critical_damage?: boolean;
      } } | null)?.damage_result;
      if (!result) {
        toast.error("O servidor não retornou o resultado do dano.");
        return;
      }
      let defenseText: string;
      if (damageKind === "true") defenseText = "defesas ignoradas";
      else if (damageKind === "physical") defenseText = `Defesa física: ${result.physical_defense}`;
      else if (damageKind === "magical") defenseText = `Defesa mágica: ${result.magical_defense}; magia ${magicLevel}`;
      else defenseText = `Defesa física: ${result.physical_defense}; Defesa mágica: ${result.magical_defense}; magia ${magicLevel}`;

      const magicTypeName = magicalDamageTypes.find((type) => type.id === selectedMagicDamageTypeId)?.name ?? "mágico";
      const physicalTypeName = physicalDamageTypes.find((type) => type.id === selectedPhysicalDamageTypeId)?.name ?? "físico";
      const damageDescription = damageKind === "hybrid"
        ? `dano híbrido (físico: ${physicalTypeName}; mágico: ${magicTypeName})`
        : damageKind === "magical"
          ? `dano mágico (${magicTypeName})`
          : damageKind === "true"
            ? "dano verdadeiro"
            : physicalDamageTypes.length > 0
              ? `dano físico (${physicalTypeName})`
              : "dano físico";
      const sourceName = sources.find((source) => source.id === effectiveSourceCharacterId)?.name;
      const hitSummary = result.final_damage_by_hit?.length
        ? " Dano final por golpe: " + result.final_damage_by_hit.join(", ") + "."
        : "";
      const fixedModifier = Number(result.damage_fixed_modifier ?? 0);
      const percentModifier = Number(result.damage_percent_modifier ?? 0);
      const signed = (value: number) => `${value >= 0 ? "+" : ""}${value}`;
      const anyFixed = Number(result.damage_any_fixed_modifier ?? 0);
      const anyPercent = Number(result.damage_any_percent_modifier ?? 0);
      const physicalFixed = Number(result.damage_physical_fixed_modifier ?? 0);
      const physicalPercent = Number(result.damage_physical_percent_modifier ?? 0);
      const magicalFixed = Number(result.damage_magical_fixed_modifier ?? 0);
      const magicalPercent = Number(result.damage_magical_percent_modifier ?? 0);
      const sourceSummary = !effectiveSourceCharacterId
        ? ""
        : damageKind === "hybrid"
          ? ` Origem: ${sourceName ?? "personagem selecionado"}; metade física: ${signed(anyFixed + physicalFixed)} fixos, ${signed(anyPercent + physicalPercent)}%; metade mágica: ${signed(anyFixed + magicalFixed)} fixos, ${signed(anyPercent + magicalPercent)}%.`
          : ` Origem: ${sourceName ?? "personagem selecionado"}; modificadores de dano: ${signed(fixedModifier)} fixos, ${signed(percentModifier)}%.`;
      const physicalReductionFixed = Number(result.physical_reduction_fixed ?? 0);
      const physicalReductionPercent = Number(result.physical_reduction_percent ?? 0);
      const magicalReductionFixed = Number(result.magical_reduction_fixed ?? 0);
      const magicalReductionPercent = Number(result.magical_reduction_percent ?? 0);
      const reductionPart = (label: string, fixed: number, percent: number) =>
        fixed === 0 && percent === 0 ? "" : ` ${label}: -${fixed} fixos, -${percent}%.`;
      const reductionSummary = damageKind === "physical"
        ? reductionPart("Mitigação física recebida", physicalReductionFixed, physicalReductionPercent)
        : damageKind === "magical"
          ? reductionPart(`Mitigação mágica recebida para ${magicTypeName} / grau ${magicLevel}`, magicalReductionFixed, magicalReductionPercent)
          : damageKind === "hybrid"
            ? reductionPart("Mitigação da metade física", physicalReductionFixed, physicalReductionPercent)
              + reductionPart(`Mitigação da metade mágica (${magicTypeName}, grau ${magicLevel})`, magicalReductionFixed, magicalReductionPercent)
            : "";
      const criticalSummary = result.critical_damage === true ? "⚔️ DANO CRÍTICO ×2 aplicado. " : "";
      const manualDamageSummary = adjustmentFixed || adjustmentPercent
        ? ` Ajuste por golpe: ${adjustmentFixed >= 0 ? "+" : ""}${adjustmentFixed} fixo, ${adjustmentPercent >= 0 ? "+" : ""}${adjustmentPercent}%.` : "";
      const penetrationSummary = damageKind !== "true" && defenseIgnoreText(defenseIgnore)
        ? ` Defesa ignorada: ${defenseIgnoreText(defenseIgnore)}.` : "";
      toast.success(
        `${criticalSummary}${target.name}: ${result.hits} golpe(s) de ${damageDescription}; ${defenseText}; ${result.total_damage} de dano total. HP: ${result.hp_before} → ${result.hp_after}.${manualDamageSummary}${penetrationSummary}${sourceSummary}${reductionSummary}${hitSummary}`,
        { duration: 8000 },
      );
      const hookErrors = result.custom_script_hooks?.errors ?? [];
      if (hookErrors.length > 0) {
        toast.error("Dano aplicado, mas houve falha em script customizado: " + hookErrors[0], { duration: 8000 });
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["battles"] }),
        qc.invalidateQueries({ queryKey: ["character", target.id] }),
        qc.invalidateQueries({ queryKey: ["characters"] }),
        qc.invalidateQueries({ queryKey: ["my-character"] }),
        // Damage can change Demônio Interno heat on both the target (received_dano)
        // and the source (causou_dano), so refresh both the stored state and live HP cost.
        qc.invalidateQueries({ queryKey: ["character-abilities", target.id] }),
        ...(effectiveSourceCharacterId
          ? [qc.invalidateQueries({ queryKey: ["character-abilities", effectiveSourceCharacterId] })]
          : []),
        qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
        // Vulnerabilidade and custom scripts (Sedento's Invencibilidade)
        // can insert effects as part of resolving this damage.
        qc.invalidateQueries({ queryKey: ["battle-effects"] }),
        qc.invalidateQueries({ queryKey: ["character-active-effects", target.id] }),
        qc.invalidateQueries({ queryKey: ["demonio-interno-hp"] }),
      ]);
      if (effects.length > 0 || dots.length > 0) {
        try { await applyConfiguredEffects(effectiveSourceCharacterId); }
        catch (error) { toast.error("Dano aplicado, mas falhou ao aplicar efeitos/DoTs: " + (error instanceof Error ? error.message : String(error)), { duration: 10000 }); }
      }
    } finally {
      setApplyingDamage(false);
      setCriticalDamage(false);
    }
  }

  function addDot() {
    if (!selectedDotTemplateId) { toast.error("Cadastre e selecione um modelo de DoT primeiro."); return; }
    setDots((current) => [...current, { templateId: selectedDotTemplateId, damageMode: "fixed", amount: "10", duration: "3" }]);
  }

  return (
    <section className="panel space-y-3 p-4">
      <h3 className="flex items-center gap-2 text-lg text-gold">
        <HeartPulse className="h-5 w-5" /> Aplicar dano em {target.name}
      </h3>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Quem está causando o dano?</label>
        <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={sourceCharacterId} onChange={(e) => setSourceCharacterId(e.target.value)}>
          <option value="">Nenhum atacante (sem modificadores de dano)</option>
          {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
        </select>
        <p className="text-xs text-muted-foreground">Ao selecionar um personagem, os buffs/debuffs de Dano Causado dele serão aplicados antes da Defesa e da Defesa Mágica.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Categoria do dano</label>
          <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={damageKind} onChange={(e) => setDamageKind(e.target.value as DamageKind)}>
            <option value="physical">Físico — usa Defesa</option>
            <option value="magical">Mágico — usa Defesa Mágica</option>
            <option value="hybrid">Híbrido — usa as duas defesas</option>
            <option value="true">Verdadeiro — ignora as defesas</option>
          </select>
        </div>
        {needsPhysical && physicalDamageTypes.length > 0 && (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Tipo físico</label>
            <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={selectedPhysicalDamageTypeId}
              onChange={(e) => setPhysicalDamageTypeId(e.target.value)}>
              <option value="">Selecione o tipo físico</option>
              {physicalDamageTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
            </select>
          </div>
        )}
        {needsMagic && (
          <>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Tipo mágico</label>
              <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={damageTypeId} onChange={(e) => setDamageTypeId(e.target.value)}>
                <option value="">Selecione o tipo</option>
                {damageTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
              </select>
              {loadingTypes && <p className="text-xs text-muted-foreground">Carregando tipos…</p>}
              {typesError && <p className="text-xs text-destructive">Não foi possível carregar os tipos de dano.</p>}
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Nível da magia</label>
              <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={magicLevel} onChange={(e) => setMagicLevel(e.target.value as MagicLevel)}>
                <option value="baixa">Baixa</option>
                <option value="media">Média</option>
                <option value="alta">Alta</option>
              </select>
            </div>
          </>
        )}
      </div>
      {damageKind === "hybrid" && (
        <p className="text-xs text-muted-foreground">
          O dano bruto é dividido igualmente: metade física reduzida pela Defesa e metade mágica reduzida pela Defesa Mágica.
          Se o valor for ímpar, o ponto extra vai para a parte mágica.
        </p>
      )}
      {damageKind === "true" && (
        <p className="text-xs text-muted-foreground">Dano verdadeiro ignora Defesa e Defesa Mágica.</p>
      )}
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
      <div className="space-y-3 rounded-md border border-gold/30 p-3">
        <h4 className="text-sm font-semibold text-gold">Modificadores de dano em {target.name}</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-medium">
            Aumentar ou reduzir o dano (valor fixo +/-)
            <Input type="number" min={-1000000} max={1000000} step={1}
              disabled={applyingDamage} value={extraDamageFixed}
              onChange={(event) => setExtraDamageFixed(event.target.value)} />
          </label>
          <label className="space-y-1 text-xs font-medium">
            Aumentar ou reduzir o dano (% +/-)
            <Input type="number" min={-100} max={1000} step={1}
              disabled={applyingDamage} value={extraDamagePercent}
              onChange={(event) => setExtraDamagePercent(event.target.value)} />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Aplica o ajuste fixo e depois o percentual em cada golpe, antes de calcular defesa, buffs e redução de dano.
          Por exemplo: 50 + 10 fixos - 50% = 30 de dano bruto por golpe.
        </p>
        {damageKind !== "true" ? (
          <div className="border-t border-border/60 pt-3">
            <DefenseIgnoreInputs
              title="Ignorar Defesa Física ou Defesa Mágica neste alvo"
              value={defenseIgnore}
              onChange={setDefenseIgnore}
              disabled={applyingDamage}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              A porcentagem reduz primeiro a defesa efetiva, depois o valor fixo; o mínimo é zero.
              Defesa ignorada não remove outros efeitos de mitigação.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Dano verdadeiro já ignora ambas as defesas.</p>
        )}
      </div>
      <label className="flex cursor-pointer items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={criticalDamage}
          disabled={applyingDamage}
          onChange={(e) => setCriticalDamage(e.target.checked)}
        />
        <span>
          <span className="block font-semibold text-amber-500">Dano Crítico — ×2 de dano final</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Dobra o dano após defesa, mitigação e modificadores normais. A opção é desmarcada automaticamente ao terminar a aplicação.
          </span>
        </span>
      </label>
      <details className="rounded-md border border-border">
        <summary className="cursor-pointer select-none px-3 py-3 text-sm font-semibold hover:text-gold">
          Efeitos e DoTs neste alvo ({effects.length + dots.length})
        </summary>
        <div className="space-y-4 border-t border-border p-3">
          <AbilityEffectsEditor
            effects={effects}
            onChange={setEffects}
            defs={defs}
            title="Efeitos para aplicar junto com o dano"
            description={battleId ? "Os efeitos e DoTs são temporários durante o combate e seguem a duração configurada." : "Os efeitos e DoTs aplicados por esta área são sempre temporários. Para efeitos permanentes, use a seção separada Efeitos permanentes da ficha."}
            allowHealing={false}
          />
          <div className="space-y-3 rounded-md border border-border p-3">
            <div>
              <h4 className="text-sm font-semibold">DoTs para aplicar no alvo</h4>
              <p className="mt-1 text-xs text-muted-foreground">Os DoTs usam os modelos cadastrados na página Dano por Turno. É possível mudar o valor e a duração de cada aplicação.</p>
            </div>
            {loadingDotTemplates ? <p className="text-xs text-muted-foreground">Carregando modelos de DoT…</p> : dotTemplates.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhum modelo cadastrado ainda. Crie um na página Dano por Turno.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <select className="h-9 min-w-48 flex-1 rounded-md border border-input bg-background px-2 text-sm" value={selectedDotTemplateId}
                  onChange={(event) => setSelectedDotTemplateId(event.target.value)}>
                  {dotTemplates.map((template) => <option key={template.id} value={template.id}>{template.name} — {template.damage_kind === "physical" ? "Físico" : "Mágico"}</option>)}
                </select>
                <Button type="button" size="sm" variant="outline" onClick={addDot}><Plus className="mr-1 h-3.5 w-3.5" /> Adicionar DoT</Button>
              </div>
            )}
            {dots.map((dot, index) => {
              const template = dotTemplates.find((item) => item.id === dot.templateId);
              return (
                <div key={index} className="grid gap-2 rounded-md border border-border/70 p-2 sm:grid-cols-[minmax(0,1fr)_125px_105px_105px_auto] sm:items-end">
                  <label className="space-y-1 text-xs font-medium">
                    Modelo
                    <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={dot.templateId}
                      onChange={(event) => setDots((current) => current.map((item, i) => i === index ? { ...item, templateId: event.target.value } : item))}>
                      {dotTemplates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                    <span className="block text-muted-foreground">{template?.damage_kind === "physical" ? "Físico" : "Mágico"}{template?.magic_level ? " · magia " + template.magic_level : ""}</span>
                  </label>
                  <label className="space-y-1 text-xs font-medium">Cálculo
                    <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={dot.damageMode}
                      onChange={(event) => setDots((current) => current.map((item, i) => i === index ? { ...item, damageMode: event.target.value as "fixed" | "percent" } : item))}>
                      <option value="fixed">Dano fixo</option><option value="percent">% do HP</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-xs font-medium">Valor
                    <Input type="number" min={1} max={dot.damageMode === "percent" ? 1000 : 1000000} value={dot.amount}
                      onChange={(event) => setDots((current) => current.map((item, i) => i === index ? { ...item, amount: event.target.value } : item))} />
                  </label>
                  <label className="space-y-1 text-xs font-medium">Duração (turnos)
                    <Input type="number" min={1} max={1000} value={dot.duration}
                      onChange={(event) => setDots((current) => current.map((item, i) => i === index ? { ...item, duration: event.target.value } : item))} />
                  </label>
                  <Button type="button" variant="ghost" size="icon" aria-label="Remover DoT da aplicação" onClick={() => setDots((current) => current.filter((_, i) => i !== index))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={applyingEffectsOnly || applyingDamage || (!effects.length && !dots.length)}
              onClick={() => void applyEffectsOnly()}>
              <CheckCircle2 className="mr-1 h-4 w-4" /> {applyingEffectsOnly ? "Aplicando…" : "Aplicar somente efeitos/DoTs em " + target.name}
            </Button>
          </div>
        </div>
      </details>
      <Button disabled={applyingDamage || applyingEffectsOnly
        || (needsMagic && (!selectedMagicDamageTypeId || magicalDamageTypes.length === 0))
        || (needsPhysical && physicalDamageTypes.length > 0 && !selectedPhysicalDamageTypeId)
        || (loadingTypes && (needsMagic || needsPhysical))}
        onClick={() => void applyDamage()}>
        {damageKind === "physical" ? <Shield className="mr-1 h-4 w-4" /> :
          damageKind === "magical" ? <Sparkles className="mr-1 h-4 w-4" /> :
          damageKind === "hybrid" ? <Swords className="mr-1 h-4 w-4" /> : <Zap className="mr-1 h-4 w-4" />}
        {applyingDamage ? "Aplicando…" : `Confirmar dano em ${target.name}`}
      </Button>
    </section>
  );
}
