import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HeartPulse, Shield, Sparkles, Swords, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";

type DamageKind = "physical" | "magical" | "hybrid" | "true";
type MagicLevel = "baixa" | "media" | "alta";
type DamageType = { id: string; name: string };

export type DamageTarget = { id: string; name: string };
type DamageSource = { id: string; name: string };

export function DamageApplier({ target, battleId = null, sources = [] }: {
  target: DamageTarget;
  battleId?: string | null;
  sources?: DamageSource[];
}) {
  const qc = useQueryClient();
  const [damageMode, setDamageMode] = useState<"repeat" | "list">("repeat");
  const [damageKind, setDamageKind] = useState<DamageKind>("physical");
  const [damageValue, setDamageValue] = useState("20");
  const [repeatCount, setRepeatCount] = useState("1");
  const [damageList, setDamageList] = useState("50, 35, 45, 86, 20, 10, 50");
  const [damageTypeId, setDamageTypeId] = useState("");
  const [magicLevel, setMagicLevel] = useState<MagicLevel>("baixa");
  const [sourceCharacterId, setSourceCharacterId] = useState("");
  const [criticalDamage, setCriticalDamage] = useState(false);
  const [applyingDamage, setApplyingDamage] = useState(false);

  const { data: damageTypes = [], isLoading: loadingTypes, error: typesError } = useQuery({
    queryKey: ["damage-types"],
    queryFn: async () => {
      const { data, error } = await supabase.from("damage_types").select("id,name").order("name");
      if (error) throw error;
      return data as DamageType[];
    },
  });

  const needsMagic = damageKind === "magical" || damageKind === "hybrid";
  const damageKindName = {
    physical: "Físico",
    magical: "Mágico",
    hybrid: "Híbrido",
    true: "Verdadeiro",
  }[damageKind];

  async function applyDamage() {
    let values: number[];
    if (damageMode === "repeat") {
      const amount = Number(damageValue);
      const count = Number(repeatCount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1000000 ||
          !Number.isInteger(count) || count < 1 || count > 200) {
        toast.error("Informe um dano válido e uma quantidade de 1 a 200 golpes");
        return;
      }
      values = Array.from({ length: count }, () => amount);
    } else {
      const parts = damageList.split(/[,;\s]+/).filter(Boolean);
      values = parts.map(Number);
      if (values.length < 1 || values.length > 200 ||
          values.some((n) => !Number.isFinite(n) || n < 0 || n > 1000000)) {
        toast.error("Informe de 1 a 200 danos válidos, separados por vírgula");
        return;
      }
    }
    if (needsMagic && !damageTypeId) {
      toast.error("Selecione um tipo de dano mágico");
      return;
    }

    const criticalDamageForThisHit = criticalDamage;
    setApplyingDamage(true);
    try {
      const { data: runtimeResponse, error } = await supabase.functions.invoke("ability-runtime", {
        body: {
          action: "apply_damage",
          battle_id: battleId,
          _battle_id: battleId,
          _character_id: target.id,
          _damage_kind: damageKind,
          _damage_type_id: needsMagic ? damageTypeId : null,
          _damage_values: values,
          _magic_level: needsMagic ? magicLevel : null,
          _source_character_id: sourceCharacterId || null,
          _critical_damage: criticalDamageForThisHit,
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

      const typeName = needsMagic
        ? damageTypes.find((t) => t.id === damageTypeId)?.name ?? "mágico"
        : damageKindName;
      const damageDescription = damageKind === "hybrid" ? `dano híbrido (${typeName})` : damageKind === "magical" ? `dano mágico (${typeName})` : damageKind === "true" ? "dano verdadeiro" : "dano físico";
      const sourceName = sources.find((source) => source.id === sourceCharacterId)?.name;
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
      const sourceSummary = !sourceCharacterId
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
          ? reductionPart(`Mitigação mágica recebida para ${typeName} / grau ${magicLevel}`, magicalReductionFixed, magicalReductionPercent)
          : damageKind === "hybrid"
            ? reductionPart("Mitigação da metade física", physicalReductionFixed, physicalReductionPercent)
              + reductionPart(`Mitigação da metade mágica (${typeName}, grau ${magicLevel})`, magicalReductionFixed, magicalReductionPercent)
            : "";
      const criticalSummary = result.critical_damage === true ? "⚔️ DANO CRÍTICO ×2 aplicado. " : "";
      toast.success(
        `${criticalSummary}${target.name}: ${result.hits} golpe(s) de ${damageDescription}; ${defenseText}; ${result.total_damage} de dano total. HP: ${result.hp_before} → ${result.hp_after}.${sourceSummary}${reductionSummary}${hitSummary}`,
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
      ]);
    } finally {
      setApplyingDamage(false);
      setCriticalDamage(false);
    }
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
              {typesError && <p className="text-xs text-destructive">Não foi possível carregar os tipos mágicos.</p>}
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
      <Button disabled={applyingDamage || (needsMagic && (!damageTypeId || damageTypes.length === 0))}
        onClick={() => void applyDamage()}>
        {damageKind === "physical" ? <Shield className="mr-1 h-4 w-4" /> :
          damageKind === "magical" ? <Sparkles className="mr-1 h-4 w-4" /> :
          damageKind === "hybrid" ? <Swords className="mr-1 h-4 w-4" /> : <Zap className="mr-1 h-4 w-4" />}
        {applyingDamage ? "Aplicando…" : `Aplicar dano em ${target.name}`}
      </Button>
    </section>
  );
}
