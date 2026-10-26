import { describe, expect, it } from "vitest";
import { parseAbilityEffects, passiveStatusModifiers, statusEffectModifiers } from "@/lib/abilities";
import { activationEffectValueFields, parseActivationValueOverrides } from "@/lib/activation-effect-values";
import { parseAttributeStatusModifiers } from "@/lib/multi-attribute-effects";

const multi = {
  effect_type: "status",
  name: "Maldição geral",
  attribute_key: "strength",
  polarity: "debuff",
  value_mode: "fixed",
  amount: 10,
  duration: 3,
  modify_on_activate: true,
  attribute_modifiers: [
    { attribute_key: "strength", amount: 10, value_mode: "fixed" },
    { attribute_key: "speed", amount: 20, value_mode: "percent" },
    { attribute_key: "phys_def", amount: 5, value_mode: "fixed" },
  ],
};

describe("Buff/debuff multiatributo", () => {
  it("mantém um único efeito editável com valores independentes", () => {
    const parsed = parseAbilityEffects([multi]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].attribute_modifiers).toEqual(multi.attribute_modifiers);
  });

  it("suporta a versão antiga com um só atributo", () => {
    const [legacy] = parseAbilityEffects([{ ...multi, attribute_modifiers: undefined }]);
    expect(legacy.attribute_modifiers).toEqual([]);
    expect(statusEffectModifiers([{ ...legacy, id: "x", character_id: "x", battle_id: null, duration_scope: "global", source_character_ability_id: null }], "strength").fixed).toBe(-10);
  });

  it("aplica valores distintos às passivas sem duplicar o efeito na ficha", () => {
    const [parsed] = parseAbilityEffects([multi]);
    const buffs = passiveStatusModifiers([{ passive_effects: [parsed] } as any]);
    expect(buffs.strength.fixed).toBe(-10);
    expect(buffs.speed.percent).toBe(-20);
    expect(buffs.phys_def.fixed).toBe(-5);
    expect(buffs.mana).toBeUndefined();
  });

  it("permite modificar cada atributo no popup, sem alterar a configuração salva", () => {
    const [parsed] = parseAbilityEffects([multi]);
    const fields = activationEffectValueFields(parsed);
    expect(fields.map((field) => field.key)).toEqual([
      "attribute_amount__strength", "attribute_amount__speed", "attribute_amount__phys_def",
    ]);
    const selected = parseActivationValueOverrides([parsed], {
      "0": {
        "attribute_amount__strength": "11",
        "attribute_amount__speed": "35",
        "attribute_amount__phys_def": "3",
      },
    });
    expect(selected?.["0"]).toEqual({
      "attribute_amount__strength": 11,
      "attribute_amount__speed": 35,
      "attribute_amount__phys_def": 3,
    });
    expect(parsed.attribute_modifiers?.[0].amount).toBe(10);
  });

  it("descarta chaves duplicadas e valores inválidos", () => {
    expect(parseAttributeStatusModifiers([
      { attribute_key: "speed", value_mode: "fixed", amount: 5 },
      { attribute_key: "speed", value_mode: "fixed", amount: 100 },
      { attribute_key: "strength", value_mode: "fixed", amount: -100 },
    ])).toEqual([{ attribute_key: "speed", value_mode: "fixed", amount: 5 }]);
  });
});
