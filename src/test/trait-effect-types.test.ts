import { describe, expect, it } from "vitest";
import { TRAIT_STARTING_EFFECT_TYPES } from "@/lib/trait-starting-effect-types";

describe("Efeitos iniciais de raça e classe", () => {
  it("permite Resistência a DoTs e mantém Imunidade a DoTs", () => {
    expect(TRAIT_STARTING_EFFECT_TYPES).toContain("dot_resistance");
    expect(TRAIT_STARTING_EFFECT_TYPES).toContain("dot_immunity");
  });

  it("não duplica opções nem disponibiliza cura instantânea como efeito permanente", () => {
    expect(new Set(TRAIT_STARTING_EFFECT_TYPES).size).toBe(TRAIT_STARTING_EFFECT_TYPES.length);
    expect(TRAIT_STARTING_EFFECT_TYPES).not.toContain("healing");
  });
});
