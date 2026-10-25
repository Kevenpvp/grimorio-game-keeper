import { describe, expect, it } from "vitest";
import { parseAbilityEffects } from "@/lib/abilities";

describe("tags visuais, congelamento temporal e remoção ao sofrer dano", () => {
  it("preserva o nome escolhido para tags em efeitos de habilidades", () => {
    const effects = parseAbilityEffects([{
      effect_type: "visual_tag", name: "Marca do Dragão",
      amount: 0, duration: 4, value_mode: "fixed",
      remove_on_hit: true, target_scope: "both",
    }]);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      name: "Marca do Dragão", effect_type: "visual_tag",
      amount: 0, duration: 4, remove_on_hit: true,
      target_scope: "both",
    });
  });

  it("congela os atributos com polaridade de buff e mantém a opção de remoção", () => {
    const [effect] = parseAbilityEffects([{
      name: "Estase temporal", effect_type: "temporal_freeze",
      polarity: "debuff", duration: 2, remove_on_hit: false,
    }]);
    expect(effect.effect_type).toBe("temporal_freeze");
    expect(effect.polarity).toBe("buff");
    expect(effect.duration).toBe(2);
    expect(effect.remove_on_hit).toBe(false);
  });

  it("permite tags aninhadas em efeitos que surgem por vulnerabilidade", () => {
    const [effect] = parseAbilityEffects([{
      effect_type: "damage_vulnerability", name: "Marca ao receber dano",
      damage_vulnerability_effects: [{
        name: "Marcado", effect_type: "visual_tag",
        duration: 3, remove_on_hit: true,
      }],
    }]);
    expect(effect.damage_vulnerability_effects).toMatchObject([
      { effect_type: "visual_tag", name: "Marcado", remove_on_hit: true },
    ]);
  });
});
