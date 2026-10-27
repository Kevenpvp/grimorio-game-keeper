import { describe, expect, it } from "vitest";
import { applyAbilityTargetDamage, isValidAbilityTargetAdjustment, shouldApplyAbilityDirectDamage } from "@/lib/ability-attack-damage";

describe("modificador de dano por alvo", () => {
  it("não envia golpes de dano bruto zero ao cálculo de HP, mas mantém golpes positivos", () => {
    // Grapple/status skills can hit and apply effects without dealing HP damage.
    // Negative target defense or fixed damage passives must not turn a 0
    // raw hit into unexpected HP loss.
    expect(shouldApplyAbilityDirectDamage(0)).toBe(false);
    expect(shouldApplyAbilityDirectDamage(applyAbilityTargetDamage(0, 0, 0))).toBe(false);
    expect(shouldApplyAbilityDirectDamage(applyAbilityTargetDamage(10, -10, 0))).toBe(false);
    expect(shouldApplyAbilityDirectDamage(1)).toBe(true);
    expect(shouldApplyAbilityDirectDamage(applyAbilityTargetDamage(0, 5, 0))).toBe(true);
    expect(shouldApplyAbilityDirectDamage(-1)).toBe(false);
    expect(shouldApplyAbilityDirectDamage(Number.NaN)).toBe(false);
  });
  it("mantém o dano base sem alterações", () => {
    expect(applyAbilityTargetDamage(50, 0, 0)).toBe(50);
  });
  it("permite aumentar e reduzir o dano percentual de cada alvo", () => {
    expect(applyAbilityTargetDamage(50, 0, 50)).toBe(75);
    expect(applyAbilityTargetDamage(50, 0, -50)).toBe(25);
    expect(applyAbilityTargetDamage(50, 0, -100)).toBe(0);
  });
  it("usa os mesmos ajustes em todos os golpes do Aplicar Dano, preservando a ordem da lista", () => {
    expect([50, 35, 45].map((hit) => applyAbilityTargetDamage(hit, 10, -50)))
      .toEqual([30, 23, 28]);
    expect(Array.from({ length: 3 }, () => 50).map((hit) => applyAbilityTargetDamage(hit, -5, 20)))
      .toEqual([54, 54, 54]);
  });
  it("combina ajustes fixos e percentuais sem criar dano negativo", () => {
    expect(applyAbilityTargetDamage(50, 10, -25)).toBe(45);
    expect(applyAbilityTargetDamage(50, -20, 20)).toBe(36);
    expect(applyAbilityTargetDamage(50, -100, 100)).toBe(0);
  });
  it("impede valores inválidos e limita valores exorbitantes", () => {
    expect(isValidAbilityTargetAdjustment(-50, -100)).toBe(true);
    expect(isValidAbilityTargetAdjustment(30, 1000)).toBe(true);
    expect(isValidAbilityTargetAdjustment(1.3, 10)).toBe(false);
    expect(isValidAbilityTargetAdjustment(0, -101)).toBe(false);
    expect(isValidAbilityTargetAdjustment(0, 1001)).toBe(false);
    expect(applyAbilityTargetDamage(900_000, 300_000, 500)).toBe(1_000_000);
  });
});
