import { describe, expect, it } from "vitest";
import { addDefenseIgnore, parseDefenseIgnore, remainingDefense } from "@/lib/defense-ignore";
describe("ignorar defesa dos ataques", () => {
  it("não altera defesas de habilidades antigas", () => {
    expect(parseDefenseIgnore(null)).toEqual({physical_percent:0,physical_fixed:0,magical_percent:0,magical_fixed:0});
  });
  it("combina habilidade, categoria acertada e alvo sem ultrapassar 100%", () => {
    const combo=addDefenseIgnore(
      parseDefenseIgnore({physical_percent:25,magical_fixed:4}),
      parseDefenseIgnore({physical_percent:25,magical_percent:20}),
      parseDefenseIgnore({physical_percent:60,physical_fixed:3}),
    );
    expect(combo).toEqual({physical_percent:100,physical_fixed:3,magical_percent:20,magical_fixed:4});
    expect(remainingDefense(20,combo.physical_percent,combo.physical_fixed)).toBe(0);
  });
  it("aplica percentual antes do valor fixo", () => {
    expect(remainingDefense(20,50,3)).toBe(7);
    expect(remainingDefense(20,0,5)).toBe(15);
    expect(remainingDefense(20,100,50)).toBe(0);
  });
});
