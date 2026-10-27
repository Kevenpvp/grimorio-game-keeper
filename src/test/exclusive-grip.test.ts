import { describe, expect, it } from "vitest";
import { defaultContinuousRule, parseContinuousRules } from "@/lib/continuous-effects";

describe("grudagem exclusiva", () => {
  it("mantém as regras antigas sem exclusividade por padrão", () => {
    expect(defaultContinuousRule().exclusive_grip).toBe(false);
    expect(parseContinuousRules([{ ...defaultContinuousRule(), exclusive_grip: undefined }])[0]?.exclusive_grip).toBe(false);
  });

  it("preserva a opção habilitada ao carregar uma habilidade", () => {
    const rule = { ...defaultContinuousRule(), exclusive_grip: true };
    expect(parseContinuousRules([rule])[0]?.exclusive_grip).toBe(true);
  });

  it("não ativa a exclusividade com strings enviadas indevidamente", () => {
    expect(parseContinuousRules([{ ...defaultContinuousRule(), exclusive_grip: "true" }])[0]?.exclusive_grip).toBe(false);
  });
});
