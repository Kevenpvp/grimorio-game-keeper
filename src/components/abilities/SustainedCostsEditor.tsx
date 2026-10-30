import { Activity, Brain, Droplets, Heart } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type SustainedResource = "mana" | "hp" | "body" | "sanity";
export type SustainedCost = {
  resource: SustainedResource;
  mode: "fixed" | "percent";
  amount: number;
};

const RESOURCE_CONFIG = [
  { resource: "mana", label: "Mana", Icon: Droplets, modes: ["fixed", "percent"] as const },
  { resource: "hp", label: "HP (Vida)", Icon: Heart, modes: ["fixed", "percent"] as const },
  { resource: "body", label: "Corpo", Icon: Activity, modes: ["percent"] as const },
  { resource: "sanity", label: "Sanidade", Icon: Brain, modes: ["percent"] as const },
] as const;

const isResource = (resource: unknown): resource is SustainedResource =>
  resource === "mana" || resource === "hp" || resource === "body" || resource === "sanity";

export function parseSustainedCosts(value: unknown): SustainedCost[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<SustainedResource>();
  const costs: SustainedCost[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    if (!isResource(raw.resource) || seen.has(raw.resource)) continue;
    const mode = raw.mode === "fixed" && (raw.resource === "mana" || raw.resource === "hp") ? "fixed" : "percent";
    const amount = Number(raw.amount);
    if (!Number.isFinite(amount) || amount < 0) continue;
    seen.add(raw.resource);
    costs.push({
      resource: raw.resource,
      mode,
      amount: Math.min(mode === "percent" ? 100 : 1_000_000, amount),
    });
  }
  return costs;
}

export function validateSustainedCosts(costs: SustainedCost[]): string | null {
  if (new Set(costs.map((entry) => entry.resource)).size !== costs.length) return "Há recursos duplicados no consumo.";
  for (const cost of costs) {
    if (!isResource(cost.resource)) return "Recurso de consumo inválido.";
    if (cost.mode !== "percent" && (cost.mode !== "fixed" || cost.resource === "body" || cost.resource === "sanity")) {
      return "Corpo e Sanidade só podem ser drenados em porcentagem.";
    }
    if (!Number.isFinite(cost.amount) || cost.amount < 0 || cost.amount > (cost.mode === "percent" ? 100 : 1_000_000)) {
      return "Informe um consumo válido (0 a 100% ou 0 a 1.000.000 pontos).";
    }
    if (cost.mode === "fixed" && !Number.isInteger(cost.amount)) return "O consumo fixo deve ser um número inteiro.";
  }
  return null;
}

export function sustainedCostsSummary(value: unknown): string {
  const costs = parseSustainedCosts(value).filter((entry) => entry.amount > 0);
  return costs.map(({ resource, mode, amount }) => {
    const label = { mana: "Mana", hp: "HP", body: "Corpo", sanity: "Sanidade" }[resource];
    return `${amount}${mode === "percent" ? "%" : ""} ${label}`;
  }).join(" · ");
}

export function SustainedCostsEditor({ value, onChange, disabled = false, usage = "turn" }: {
  value: SustainedCost[];
  onChange: (next: SustainedCost[]) => void;
  disabled?: boolean;
  /** "activation" means a one-time cost when pressing Ativar or Atacar. */
  usage?: "turn" | "activation";
}) {
  const update = (resource: SustainedResource, patch: Partial<SustainedCost>) =>
    onChange(value.map((item) => item.resource === resource ? { ...item, ...patch } : item));

  return (
    <section className="space-y-3 rounded-xl border border-violet-500/35 bg-violet-500/5 p-3 sm:p-4">
      <div>
        <h3 className="font-semibold text-gold">{usage === "activation" ? "Custos adicionais ao usar" : "Consumo por turno"}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {usage === "activation"
            ? "Além da Mana configurada, cobra HP, Corpo ou Sanidade uma vez ao usar Ativar ou Atacar. HP aceita valor fixo ou % do HP máximo; Corpo e Sanidade usam pontos percentuais (0 a 100). Se não houver recurso suficiente, a habilidade não será usada."
            : "Enquanto a habilidade estiver ligada, esses recursos serão drenados a cada turno do personagem. Mana e HP usam quantidade fixa ou % do máximo; Corpo e Sanidade somente porcentagem (pontos de 0 a 100). Se um recurso chegar a zero, a habilidade é desligada e começa sua recarga."}
        </p>
      </div>
      <div className="space-y-2">
        {RESOURCE_CONFIG.filter(({ resource }) => usage === "turn" || resource !== "mana").map(({ resource, label, Icon, modes }) => {
          const selected = value.find((entry) => entry.resource === resource);
          const enabled = !!selected;
          return (
            <div key={resource} className="min-w-0 rounded-lg border border-border/70 bg-background/50 p-3">
              <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm font-medium">
                <input type="checkbox" className="h-4 w-4 accent-[#e8b95a]"
                  disabled={disabled} checked={enabled}
                  onChange={(event) => onChange(event.target.checked
                    ? [...value, { resource, mode: resource === "body" || resource === "sanity" ? "percent" : "fixed", amount: 0 }]
                    : value.filter((entry) => entry.resource !== resource)
                  )} />
                <Icon className="h-4 w-4 text-gold" aria-hidden="true" />
                <span>{label}</span>
              </label>
              {selected && (
                <div className="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <div className="space-y-1">
                    <Label className="text-xs">Tipo de consumo</Label>
                    {modes.length === 1
                      ? <div className="flex min-h-10 items-center rounded-lg border border-border px-3 text-xs text-muted-foreground">% do recurso</div>
                      : <select disabled={disabled} aria-label={`Tipo de consumo de ${label}`}
                          className="min-h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                          value={selected.mode}
                          onChange={(event) => update(resource, { mode: event.target.value as "fixed" | "percent", amount: 0 })}>
                          <option value="fixed">Valor fixo</option>
                          <option value="percent">% do máximo</option>
                        </select>
                    }
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">{usage === "activation" ? "Custo por utilização" : "Quantidade por turno"} {selected.mode === "percent" ? "(%)" : "(pontos)"}</Label>
                    <Input
                      disabled={disabled}
                      aria-label={`Consumo de ${label} ${usage === "activation" ? "ao usar" : "por turno"}`}
                      type="number" min={0} max={selected.mode === "percent" ? 100 : 1000000}
                      step={selected.mode === "percent" ? "0.1" : "1"}
                      value={selected.amount}
                      onChange={(event) => update(resource, { amount: Number(event.target.value) })}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {usage === "activation"
          ? "O gasto é pago pelo personagem que usa a habilidade, nunca pelo alvo. Em ataques com múltiplos alvos, cobra apenas na primeira utilização, mesmo que todos esquivem. Os recursos são descontados junto com a Mana."
          : "O custo de Ativar continua separado. O consumo por turno só acontece enquanto esta habilidade sustentada estiver ligada, e não atinge o alvo."}
      </p>
    </section>
  );
}
