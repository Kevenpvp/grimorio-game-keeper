export type CustomAbilityAttributeType = "number" | "string" | "boolean";

export interface CustomAbilityAttribute {
  key: string;
  name: string;
  type: CustomAbilityAttributeType;
  value: number | string | boolean;
  /** Whether a numeric value is affected by a race multiplier when the ability comes from a virtue. */
  scale_with_race?: boolean;
  /** Harmful numeric attribute: excluded from virtue/race/class multipliers. */
  malefico?: boolean;
}

export const DEMONIO_INTERNO_DEFAULT_ATTRIBUTES: CustomAbilityAttribute[] = [
  { key: "porcentagem_maxima_dano_refletido", name: "Porcentagem máxima de dano refletido", type: "number", value: 50, scale_with_race: true },
  { key: "percentual_hp_perdido_por_refletir", name: "% de HP que perde para refletir", type: "number", value: 10, scale_with_race: false },
];

export const CUSTOM_ABILITY_SCRIPTS = [
  { key: "example", label: "Exemplo — registrar eventos (não altera o combate)" },
  { key: "demonio_interno", label: "Demônio Interno — acumula dano recebido e reflete no próximo ataque" },
  { key: "coracao_corrompido", label: "Coração Corrompido — usa ForçaBonus enquanto estiver em cooldown e houver superaquecimento" },
  { key: "sedento_por_sangue", label: "Sedento por Sangue — consome HP após turnos e concede invencibilidade com cooldown interno" },
  { key: "barrincar", label: "Barrincar — acumula +5% de dano físico por acerto; reseta após um turno sem acerto" },
  { key: "lagrimas_petalas", label: "Lágrimas das pétalas — controla stacks e prepara Sangramento no próximo ataque da Espada Florin" },
] as const;

export type CustomAbilityScriptKey = (typeof CUSTOM_ABILITY_SCRIPTS)[number]["key"];

export function parseCustomAbilityAttributes(value: unknown): CustomAbilityAttribute[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): CustomAbilityAttribute[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const type = raw.type;
    if (!key || !name || (type !== "number" && type !== "string" && type !== "boolean")) return [];
    if (type === "number") {
      const numeric = Number(raw.value);
      if (!Number.isFinite(numeric)) return [];
      return [{ key, name, type, value: numeric, scale_with_race: raw.scale_with_race !== false, malefico: raw.malefico === true }];
    }
    if (type === "boolean") return [{ key, name, type, value: raw.value === true }];
    return [{ key, name, type, value: typeof raw.value === "string" ? raw.value : String(raw.value ?? "") }];
  });
}

export function customAttributeKey(name: string, fallbackIndex: number): string {
  const key = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/%/g, " porcentagem ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key || `atributo_${fallbackIndex + 1}`;
}
