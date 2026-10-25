import { describe, expect, it } from "vitest";
import { attackDiceModifier, hasActiveStun } from "@/lib/combat-dice";
describe("bônus de acerto em alvo atordoado", () => {
  it("adiciona +1 após cálculo original mesmo quando resultado base é zero", () => {
    expect(attackDiceModifier(30,33,false)).toBe(0);
    expect(attackDiceModifier(30,33,true)).toBe(1);
    expect(attackDiceModifier(30,9,true)).toBe(3);
  });
  it("ignora stun expirado e stun de outro alvo", () => {
    const effects=[
      { character_id:"a",effect_type:"stun",duration:0 },
      { character_id:"b",effect_type:"stun",duration:2 },
      { character_id:"a",effect_type:"status",duration:1 },
    ];
    expect(hasActiveStun("a",effects)).toBe(false);
    expect(hasActiveStun("b",effects)).toBe(true);
  });
});
