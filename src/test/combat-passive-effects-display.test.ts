import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAbilityEffects } from "@/lib/abilities";
import { passiveEffectsForDisplay } from "@/lib/passive-effect-display";

const combat = readFileSync(resolve(process.cwd(), "src/routes/_authenticated/combate.tsx"), "utf8");

describe("Efeitos passivos na aba Efeitos ativos do combate", () => {
  it("exibe os passivos de Grande Mago, inclusive redução de Mana e regeneração", () => {
    const effects = parseAbilityEffects([
      { name: "Redução de uso de Mana", amount: 50, polarity: "buff", value_mode: "percent", effect_type: "mana_used", attribute_key: null },
      { name: "Regeneração de mana extra", amount: 10, polarity: "buff", value_mode: "fixed", effect_type: "regeneration", attribute_key: "mana" },
    ]);
    const cards = passiveEffectsForDisplay([{ id: "grand-mage-1", name: "Grande Mago", passive_effects: effects }]);
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.id)).toEqual(["passive:grand-mage-1:0", "passive:grand-mage-1:1"]);
    expect(cards.map((c) => [c.effect.effect_type, c.effect.amount])).toEqual([
      ["mana_used", 50],
      ["regeneration", 10],
    ]);
    expect(cards.every((c) => c.abilityName === "Grande Mago")).toBe(true);
  });

  it("não mistura efeitos de outras fichas ou de habilidades removidas", () => {
    expect(passiveEffectsForDisplay([])).toEqual([]);
    const first = parseAbilityEffects([{ name: "Escudo", effect_type: "status", attribute_key: "phys_def", amount: 15 }]);
    const second = parseAbilityEffects([{ name: "Barreira", effect_type: "status", attribute_key: "mag_def", amount: 20 }]);
    const a = passiveEffectsForDisplay([{ id: "character-a", name: "A", passive_effects: first }]);
    const b = passiveEffectsForDisplay([{ id: "character-b", name: "B", passive_effects: second }]);
    expect(a[0].id).not.toBe(b[0].id);
    expect(a.map((row) => row.effect.name)).toEqual(["Escudo"]);
    expect(b.map((row) => row.effect.name)).toEqual(["Barreira"]);
  });

  it("preserva a origem de acessórios e separa as cópias individuais", () => {
    const effects = parseAbilityEffects([{ name: "Vitalidade", effect_type: "status", attribute_key: "hp", amount: 10 }]);
    const cards = passiveEffectsForDisplay([
      { id: "ability-copy-1", name: "Bênção do Anel", source_inventory_item_id: "ring-1", passive_effects: effects },
      { id: "ability-copy-2", name: "Bênção do Anel", source_inventory_item_id: "ring-2", passive_effects: effects },
    ]);
    expect(cards.map((card) => card.sourceInventoryItemId)).toEqual(["ring-1", "ring-2"]);
    expect(new Set(cards.map((card) => card.id)).size).toBe(2);
  });

  it("reaproveita o painel e filtros existentes sem gravar passivos como battle_effects", () => {
    expect(combat).toContain("passiveEffects={passiveEffectsForDisplay(abilitiesOf(f.id))}");
    expect(combat).toContain("const allEffects: VisibleCombatEffect[] = [...effects, ...passiveCards]");
    expect(combat).toContain("({allEffects.length})");
    expect(combat).toContain('filter === "dots"');
    expect(combat).toContain("Passivo de habilidade");
    expect(combat).toContain("Permanente (passivo)");
    expect(combat).toContain("Enquanto a habilidade estiver concedida à ficha");
    expect(combat).toContain("effectSummary(effect.passiveDefinition, defs, damageTypes, effectRaces)");
    expect(combat).not.toContain("insert({ ...effect, is_sheet_permanent: true");
  });
});
