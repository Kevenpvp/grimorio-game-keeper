import { describe, expect, it } from "vitest";
import { parseAbilityEffects } from "@/lib/abilities";

const physicalId = "0fcf2a05-5b5c-4eda-97b8-a37bf49569b4";
const prataId = "a70ae970-1d88-4d4e-9731-529ed6377b8c";
const fogoId = "9b1e889a-ccf1-450d-ab58-409d74c0eabe";
const luzId = "5f615ac8-ca52-4f5a-8478-5b1aec6e83d3";

describe("Mitigação de dano físico e mágico com blacklist", () => {
  it("preserva duas categorias no mesmo efeito e suas listas distintas", () => {
    const [effect] = parseAbilityEffects([{
      name: "Armadura anti-magia", effect_type: "damage_reduction",
      amount: 25, value_mode: "percent", duration: 4,
      damage_reduction_scope: "both",
      damage_reduction_physical_type_ids: [physicalId],
      damage_reduction_magic_type_ids: [luzId],
      damage_reduction_physical_blacklist_ids: [prataId],
      damage_reduction_magic_blacklist_ids: [fogoId],
      damage_reduction_magic_levels: ["baixa","alta"],
      damage_reduction_magic_level_blacklist: ["alta"],
    }]);
    expect(effect).toMatchObject({
      damage_reduction_scope: "both",
      damage_reduction_physical_type_ids: [physicalId],
      damage_reduction_magic_type_ids: [luzId],
      damage_reduction_physical_blacklist_ids: [prataId],
      damage_reduction_magic_blacklist_ids: [fogoId],
      damage_reduction_magic_levels: ["baixa", "alta"],
      damage_reduction_magic_level_blacklist: ["alta"],
      amount: 25,
      value_mode: "percent",
    });
  });

  it("mantém a seleção antiga dos buffs apenas físicos", () => {
    const [effect] = parseAbilityEffects([{
      name:"Redução física",effect_type:"damage_reduction",
      damage_reduction_scope:"physical",damage_reduction_type_ids:[physicalId],
    }]);
    expect(effect.damage_reduction_physical_type_ids).toEqual([physicalId]);
    expect(effect.damage_reduction_magic_type_ids).toEqual([]);
    expect(effect.damage_reduction_scope).toBe("physical");
  });

  it("mantém a seleção antiga dos buffs apenas mágicos", () => {
    const [effect] = parseAbilityEffects([{
      name:"Redução mágica",effect_type:"damage_reduction",
      damage_reduction_scope:"magical",damage_reduction_type_ids:[fogoId],
      damage_reduction_magic_levels:["baixa"],
    }]);
    expect(effect.damage_reduction_magic_type_ids).toEqual([fogoId]);
    expect(effect.damage_reduction_physical_type_ids).toEqual([]);
    expect(effect.damage_reduction_magic_levels).toEqual(["baixa"]);
  });

  it("remove duplicações da blacklist e descarta graus inválidos", () => {
    const [effect] = parseAbilityEffects([{
      name:"Muralha",effect_type:"damage_reduction",
      damage_reduction_scope:"both",
      damage_reduction_magic_blacklist_ids:[fogoId,fogoId],
      damage_reduction_magic_level_blacklist:["media","desconhecido","media"],
    }]);
    expect(effect.damage_reduction_magic_blacklist_ids).toEqual([fogoId]);
    expect(effect.damage_reduction_magic_level_blacklist).toEqual(["media"]);
  });
});
