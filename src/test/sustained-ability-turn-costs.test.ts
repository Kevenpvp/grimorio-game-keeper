import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseSustainedCosts,
  validateSustainedCosts,
  sustainedCostsSummary,
  type SustainedCost,
} from "@/components/abilities/SustainedCostsEditor";

const migration = readFileSync(resolve(process.cwd(), "drizzle/migrations/193_sustained_ability_turn_costs.sql"), "utf8");
const turnFix = readFileSync(resolve(process.cwd(), "drizzle/migrations/194_sustained_cost_full_cooldown.sql"), "utf8");
const catalog = readFileSync(resolve(process.cwd(), "src/routes/_authenticated/habilidades.tsx"), "utf8");
const sheet = readFileSync(resolve(process.cwd(), "src/components/abilities/CharacterAbilities.tsx"), "utf8");

describe("Custos sustentados", () => {
  it("permite múltiplos recursos e só percentuais para Corpo e Sanidade", () => {
    const parsed = parseSustainedCosts([
      { resource: "mana", mode: "fixed", amount: 40 },
      { resource: "hp", mode: "percent", amount: 12.5 },
      { resource: "body", mode: "fixed", amount: 5 },
      { resource: "sanity", mode: "percent", amount: 7 },
    ]);
    expect(parsed).toEqual([
      { resource: "mana", mode: "fixed", amount: 40 },
      { resource: "hp", mode: "percent", amount: 12.5 },
      { resource: "body", mode: "percent", amount: 5 },
      { resource: "sanity", mode: "percent", amount: 7 },
    ]);
    expect(sustainedCostsSummary(parsed)).toBe("40 Mana · 12.5% HP · 5% Corpo · 7% Sanidade");
    expect(validateSustainedCosts(parsed)).toBeNull();
    expect(validateSustainedCosts([{ resource: "body", mode: "fixed", amount: 10 }])).toContain("só podem ser drenados em porcentagem");
    expect(validateSustainedCosts([{ resource: "mana", mode: "percent", amount: 200 }])).toContain("consumo válido");
    expect(validateSustainedCosts([{ resource: "hp", mode: "fixed", amount: -1 }])).toContain("consumo válido");
    expect(validateSustainedCosts([
      { resource: "hp", mode: "fixed", amount: 1 },
      { resource: "hp", mode: "percent", amount: 1 },
    ])).toContain("duplicados");
  });

  it("salva custos no catálogo e por ficha, preservando cópias concedidas por acessórios", () => {
    expect(catalog).toContain("<SustainedCostsEditor value={sustainCosts}");
    expect(catalog).toContain("sustain_costs: canActivate && toggleMode ? sustainCosts : []");
    expect(sheet).toContain("<SustainedCostsEditor value={sustainCosts}");
    expect(sheet).toContain("sustain_costs: canActivate && toggleMode ? sustainCosts : []");
    expect(sheet).toContain("Drena/turno:");
    expect(migration).toContain("assign_catalog_sustain_costs");
    expect(migration).toContain("update_catalog_sustain_costs");
    expect(migration).toContain("''sustain_costs'',ca.sustain_costs");
    expect(migration).toContain("sustain_costs=COALESCE(_entry.value->''sustain_costs'',ca.sustain_costs)");
  });

  it("desconta apenas do personagem da habilidade, ao avançar individual ou global", () => {
    expect(migration).toContain("ca.toggle_mode AND ca.toggle_active AND ca.toggle_battle_id=_battle_id");
    expect(migration).toContain("(_character_id IS NULL OR ca.character_id=_character_id)");
    expect(migration).toContain("public.calculate_character_resource_max(_ability.character_id,_resource)");
    expect(migration).toContain("current_value=GREATEST(0,COALESCE(current_value,0)-_drain)");
    expect(migration).toContain("body=GREATEST(0,body-_drain)");
    expect(migration).toContain("sanity=GREATEST(0,sanity-_drain)");
    expect(migration).toContain("public.turn_off_character_ability(_ability.id,_battle_id)");
  });

  it("não reduz a recarga no mesmo turno em que a habilidade se desliga automaticamente", () => {
    expect(turnFix).toContain("Charge after cooldowns and DoTs");
    expect(turnFix).toContain("public.tick_sustained_ability_costs_internal(_battle_id,_character_id)");
    expect(turnFix).toContain("  return _result_turn;");
  });
});
