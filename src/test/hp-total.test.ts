import { describe, expect, it } from "vitest";
import { effectiveHpTotal } from "@/lib/hp-total";

describe("total efetivo de HP", () => {
  it("soma o máximo manual ao bônus de HP da raça", () => {
    expect(effectiveHpTotal(117, 7, 0, 0, 0)).toBe(124);
  });
  it("mantém separado o máximo base e inclui efeitos percentuais", () => {
    expect(effectiveHpTotal(100, 10, 0, 10, 25)).toBe(150);
  });
  it("inclui penalidades de raça e debuffs", () => {
    expect(effectiveHpTotal(102, -12, 0, 0, 0)).toBe(90);
    expect(effectiveHpTotal(117, 7, 0, -10, 0)).toBe(114);
  });
  it("recalcula o total se o mestre mudar o máximo base", () => {
    expect(effectiveHpTotal(115, 7, 0, 0, 0)).toBe(122);
    expect(effectiveHpTotal(130, 7, 0, 0, 0)).toBe(137);
  });
  it("mantém HP total em pelo menos 1", () => {
    expect(effectiveHpTotal(4, -12, 0, 0, 0)).toBe(1);
  });
});
