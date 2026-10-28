import { describe, expect, it } from "vitest";
import { parseAbilityAttackDamage } from "@/lib/abilities";
import { abilityAttackAttributeSources, calculateAbilityAttackBaseDamage } from "@/lib/ability-attack-damage";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const editor = readFileSync(resolve(process.cwd(), "src/components/abilities/SheetAbilityAttackEditor.tsx"), "utf8");
const combat = readFileSync(resolve(process.cwd(), "src/components/abilities/CharacterAbilities.tsx"), "utf8");

describe("Ataque híbrido com múltiplos atributos", () => {
  const stats: Record<string, number> = { magic_damage: 80, strength: 50, speed: 30 };
  const stat = (key: string) => stats[key] ?? 0;

  it("soma Dano Mágico + Força + dano fixo antes da defesa, em um único ataque", () => {
    const config = parseAbilityAttackDamage({
      damage_kind: "hybrid",
      attribute_key: "magic_damage",
      attribute_percent: 100,
      additional_attributes: [{ attribute_key: "strength", attribute_percent: 100 }],
      fixed_damage: 20,
    });
    expect(calculateAbilityAttackBaseDamage(config, stat)).toBe(150);
    expect(abilityAttackAttributeSources(config)).toEqual([
      { attribute_key: "magic_damage", attribute_percent: 100 },
      { attribute_key: "strength", attribute_percent: 100 },
    ]);
  });

  it("permite percentuais diferentes e mais de duas fontes, arredondando o total só uma vez", () => {
    const config = parseAbilityAttackDamage({
      damage_kind: "hybrid",
      attribute_key: "magic_damage", attribute_percent: 50,
      additional_attributes: [
        { attribute_key: "strength", attribute_percent: 75 },
        { attribute_key: "speed", attribute_percent: 25 },
      ],
      fixed_damage: 3,
    });
    expect(calculateAbilityAttackBaseDamage(config, stat)).toBe(88);
  });

  it("mantém habilidades antigas funcionando, sem exigir novos campos", () => {
    const config = parseAbilityAttackDamage({
      damage_kind: "physical",
      attribute_key: "strength", attribute_percent: 100, fixed_damage: 10,
    });
    expect(config.additional_attributes).toEqual([]);
    expect(calculateAbilityAttackBaseDamage(config, stat)).toBe(60);
  });

  it("não aplica extras de um ataque híbrido quando muda para outro tipo", () => {
    const hybrid = parseAbilityAttackDamage({
      damage_kind: "hybrid",
      attribute_key: "strength", attribute_percent: 100,
      additional_attributes: [{ attribute_key: "magic_damage", attribute_percent: 100 }],
      fixed_damage: 0,
    });
    expect(calculateAbilityAttackBaseDamage(hybrid, stat)).toBe(130);
    expect(calculateAbilityAttackBaseDamage({ ...hybrid, damage_kind: "physical" }, stat)).toBe(50);
  });

  it("descarta duplicados e entradas inválidas sem multiplicar dano indevidamente", () => {
    const config = parseAbilityAttackDamage({
      damage_kind: "hybrid",
      attribute_key: "magic_damage", attribute_percent: 100,
      additional_attributes: [
        { attribute_key: "magic_damage", attribute_percent: 100 },
        { attribute_key: "strength", attribute_percent: 200 },
        { attribute_key: "strength", attribute_percent: 100 },
        { attribute_key: "speed", attribute_percent: -30 },
      ],
      fixed_damage: 0,
    });
    expect(config.additional_attributes).toEqual([{ attribute_key: "strength", attribute_percent: 200 }]);
    expect(calculateAbilityAttackBaseDamage(config, stat)).toBe(180);
  });

  it("usa o editor compartilhado por catálogo e ficha, com adicionar/remover e campos por atributo", () => {
    expect(editor).toContain("Fontes adicionais de dano");
    expect(editor).toContain("Adicionar atributo");
    expect(editor).toContain("additional_attributes");
    expect(editor).toContain("Remover");
    expect(combat).toContain("calculateAbilityAttackBaseDamage(attackConfig");
    expect(combat).toContain("abilityAttackAttributeSources(attackConfig)");
  });
});
