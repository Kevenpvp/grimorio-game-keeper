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

export function DamageApplier({ target, battleId = null }: {
  target: DamageTarget;
  battleId?: string | null;
}) {
  const qc = useQueryClient();
  const [damageMode, setDamageMode] = useState<"repeat" | "list">("repeat");
  const [damageKind, setDamageKind] = useState<DamageKind>("physical");
  const [damageValue, setDamageValue] = useState("20");
  const [repeatCount, setRepeatCount] = useState("1");
  const [damageList, setDamageList] = useState("50, 35, 45, 86, 20, 10, 50");
  const [damageTypeId, setDamageTypeId] = useState("");
  const [magicLevel, setMagicLevel] = useState<MagicLevel>("baixa");
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

    setApplyingDamage(true);
    try {
      const { data, error } = await supabase.rpc("apply_battle_damage", {
        _battle_id: battleId,
        _character_id: target.id,
        _damage_kind: damageKind,
        _damage_type_id: needsMagic ? damageTypeId : null,
        _damage_values: values,
        _magic_level: needsMagic ? magicLevel : null,
      });
      if (error) {
        toast.error(error.message);
        return;
      }

      const result = data as unknown as {
        hits: number;
        physical_defense: number;
        magical_defense: number;
        total_damage: number;
        hp_before: number;
        hp_after: number;
      };
      let defenseText: string;
      if (damageKind === "true") defenseText = "defesas ignoradas";
      else if (damageKind === "physical") defenseText = `Defesa física: ${result.physical_defense}`;
      else if (damageKind === "magical") defenseText = `Defesa mágica: ${result.magical_defense}; magia ${magicLevel}`;
      else defenseText = `Defesa física: ${result.physical_defense}; Defesa mágica: ${result.magical_defense}; magia ${magicLevel}`;

      const typeName = needsMagic
        ? damageTypes.find((t) => t.id === damageTypeId)?.name ?? "mágico"
        : damageKindName;
      const damageDescription = damageKind === "hybrid" ? `dano híbrido (${typeName})` : damageKind === "magical" ? `dano mágico (${typeName})` : damageKind === "true" ? "dano verdadeiro" : "dano físico";
      toast.success(
        `${target.name}: ${result.hits} golpe(s) de ${damageDescription}; ${defenseText}; ${result.total_damage} de dano total. HP: ${result.hp_before} → ${result.hp_after}.`,
        { duration: 8000 },
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["battles"] }),
        qc.invalidateQueries({ queryKey: ["character", target.id] }),
        qc.invalidateQueries({ queryKey: ["characters"] }),
        qc.invalidateQueries({ queryKey: ["my-character"] }),
      ]);
    } finally {
      setApplyingDamage(false);
    }
  }

  return (
    <section className="panel space-y-3 p-4">
      <h3 className="flex items-center gap-2 text-lg text-gold">
        <HeartPulse className="h-5 w-5" /> Aplicar dano em {target.name}
      </h3>
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
