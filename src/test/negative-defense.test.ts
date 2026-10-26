import { describe, expect, it } from "vitest";
import { clampNonDefenseAttribute, conditionAdjustedValue, computeValue } from "@/lib/sheets";

const character = { body: 100, sanity: 100 };

describe("defesas negativas na ficha e no combate", () => {
  it("exibe a defesa negativa causada pela raça, sem limitar a zero", () => {
    const defense = computeValue({ base_value: 0, points_multiplier: 1 } as never, 5 - 7);
    expect(defense).toBe(-2);
    expect(clampNonDefenseAttribute("phys_def", defense)).toBe(-2);
    expect(conditionAdjustedValue(character, "phys_def", defense)).toBe(-2);
  });

  it("permite defesa mágica negativa, mas não libera negativos em outras estatísticas", () => {
    expect(clampNonDefenseAttribute("mag_def", -10)).toBe(-10);
    expect(clampNonDefenseAttribute("speed", -10)).toBe(0);
    expect(clampNonDefenseAttribute("mana", -10)).toBe(0);
    expect(clampNonDefenseAttribute("hp", -10)).toBe(0);
  });

  it("escala defesa física negativa com Corpo e preserva defesa mágica", () => {
    const halfBody = { body: 50, sanity: 100 };
    expect(conditionAdjustedValue(halfBody, "phys_def", -10)).toBe(-5);
    expect(conditionAdjustedValue(halfBody, "mag_def", -10)).toBe(-10);
    expect(conditionAdjustedValue({ body: 0, sanity: 100 }, "phys_def", -10)).toBe(0);
  });

  it("mantém o comportamento de defesa positiva", () => {
    expect(conditionAdjustedValue(character, "phys_def", 7)).toBe(7);
    expect(conditionAdjustedValue({ body: 50, sanity: 100 }, "phys_def", 7)).toBe(3.5);
  });
});
