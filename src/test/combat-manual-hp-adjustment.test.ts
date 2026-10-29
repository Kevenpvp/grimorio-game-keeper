import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { calculateManualCombatHp } from "@/lib/combat-hp-adjustment";

const combat = readFileSync(resolve(process.cwd(), "src/routes/_authenticated/combate.tsx"), "utf8");

describe("alteração manual de HP pelo mestre no combate", () => {
  it("aumenta e reduz o HP pelo valor digitado", () => {
    expect(calculateManualCombatHp(50, 100, 15, 1)).toBe(65);
    expect(calculateManualCombatHp(50, 100, 15, -1)).toBe(35);
  });

  it("respeita sempre o mínimo zero e o máximo efetivo da ficha", () => {
    expect(calculateManualCombatHp(96, 100, 15, 1)).toBe(100);
    expect(calculateManualCombatHp(4, 100, 15, -1)).toBe(0);
    expect(calculateManualCombatHp(48, 48, 15, 1)).toBe(48);
    expect(calculateManualCombatHp(0, 0, 15, -1)).toBe(0);
    expect(calculateManualCombatHp(50, 80.9, 70, 1)).toBe(80);
  });

  it("rejeita entradas inválidas, fracionadas, negativas ou acima do limite", () => {
    expect(calculateManualCombatHp(20, 100, 0, 1)).toBeNull();
    expect(calculateManualCombatHp(20, 100, -2, 1)).toBeNull();
    expect(calculateManualCombatHp(20, 100, 1.5, 1)).toBeNull();
    expect(calculateManualCombatHp(20, 100, Number.NaN, 1)).toBeNull();
    expect(calculateManualCombatHp(20, 100, 1_000_001, 1)).toBeNull();
    expect(calculateManualCombatHp(20, Number.NaN, 10, 1)).toBeNull();
  });

  it("mostra o novo campo e os dois botões apenas no editor de recursos do mestre", () => {
    expect(combat).toContain("Alterar HP, Mana, Sanidade e Corpo");
    expect(combat).toContain('aria-label="Quantidade de HP para alterar"');
    expect(combat).toContain('aria-label={"Reduzir HP de " + fighter.name}');
    expect(combat).toContain('aria-label={"Aumentar HP de " + fighter.name}');
    expect(combat).toContain("onClick={() => void changeHp(-1)}");
    expect(combat).toContain("onClick={() => void changeHp(1)}");
    expect(combat).toContain('detailTab === "effects" && isMaster && <CombatResourceEditor');
  });

  it("altera apenas o HP atual, sem alterar máximo ou acionar a regeneração", () => {
    expect(combat).toContain('calculateManualCombatHp(current, val(fighter, "hp"), delta, direction)');
    expect(combat).toContain('eq("character_id", fighter.id).eq("attribute_key", "hp")');
    expect(combat).toContain('qc.invalidateQueries({ queryKey: ["battles"] })');
    expect(combat).toContain('qc.invalidateQueries({ queryKey: ["character", fighter.id] })');
  });
});
