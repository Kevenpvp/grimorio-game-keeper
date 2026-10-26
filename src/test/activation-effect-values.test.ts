import { describe, expect, it } from "vitest";
import {
  activationEffectValueFields, customizableActivationEffects, parseActivationValueOverrides,
} from "@/lib/activation-effect-values";
import type { AbilityEffectDefinition } from "@/lib/abilities";

const make = (values: Partial<AbilityEffectDefinition> = {}): AbilityEffectDefinition => ({
  name: "Força", effect_type: "status", attribute_key: "strength",
  polarity: "buff", value_mode: "fixed", amount: 10, duration: 2, damage_scope: "any",
  ...values,
});

describe("modificar efeito ao ativar", () => {
  it("seleciona apenas efeitos marcados com valor editável", () => {
    const effects = [
      make({ name: "normal" }),
      make({ name: "configurável", modify_on_activate: true }),
      make({ name: "invencível", effect_type: "invincible", modify_on_activate: true }),
    ];
    expect(customizableActivationEffects(effects).map(x => x.index)).toEqual([1]);
  });
  it("aceita novo valor sem alterar o efeito salvo", () => {
    const effect = make({ modify_on_activate: true });
    expect(parseActivationValueOverrides([effect], { "0": { amount: "35" } }))
      .toEqual({ "0": { amount: 35 } });
    expect(effect.amount).toBe(10);
  });
  it("permite 0 e rejeita valores inválidos", () => {
    const effects = [make({ modify_on_activate: true })];
    expect(parseActivationValueOverrides(effects, { "0": { amount: "0" } })).toEqual({ "0": { amount: 0 } });
    expect(parseActivationValueOverrides(effects, { "0": { amount: "-1" } })).toBeNull();
    expect(parseActivationValueOverrides(effects, { "0": { amount: "abc" } })).toBeNull();
  });
  it("expõe os recursos ativos de uma cura e os limites percentuais", () => {
    const fields = activationEffectValueFields(make({
      effect_type: "healing",
      healing_hp_enabled: true, healing_hp_amount: 25, healing_hp_mode: "percent",
      healing_mana_enabled: true, healing_mana_amount: 40, healing_mana_mode: "fixed",
    }));
    expect(fields.map(f => f.key)).toEqual(["healing_hp_amount", "healing_mana_amount"]);
    expect(fields[0].max).toBe(100);
  });
});
