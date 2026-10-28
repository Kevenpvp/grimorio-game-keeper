import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAbilityEffects } from "@/lib/abilities";
import {
  passiveEffectsForDisplay,
  unregisteredPassiveEffectsForDisplay,
  combatEffectBadgeCounts,
} from "@/lib/passive-effect-display";

const combat = readFileSync(resolve(process.cwd(), "src/routes/_authenticated/combate.tsx"), "utf8");

describe("Contagem de buffs e debuffs nos cartões de combate", () => {
  const passives = passiveEffectsForDisplay([
    {
      id: "grande-mago",
      name: "Grande Mago",
      passive_effects: parseAbilityEffects([
        { name: "Redução de uso de Mana", effect_type: "mana_used", polarity: "buff", amount: 50, value_mode: "percent" },
        { name: "Regeneração de mana extra", effect_type: "regeneration", attribute_key: "mana", polarity: "buff", amount: 10, value_mode: "fixed" },
      ]),
    },
  ]);

  it("conta 1 buff registrado e 2 passivos como 3 buffs, sem mudar o combate", () => {
    const active = [{
      name: "Prodigio",
      effect_type: "status",
      polarity: "buff",
      source_character_ability_id: null,
      is_sheet_permanent: true,
    }];
    expect(passives).toHaveLength(2);
    expect(combatEffectBadgeCounts(active, passives)).toEqual({ buffs: 3, debuffs: 0 });
  });

  it("não conta duas vezes um passivo já registrado como efeito permanente", () => {
    const active = [
      {
        name: "Prodigio",
        effect_type: "status",
        polarity: "buff",
        source_character_ability_id: null,
        is_sheet_permanent: true,
      },
      {
        name: "Redução de uso de Mana",
        effect_type: "mana_used",
        polarity: "buff",
        source_character_ability_id: "grande-mago",
        is_sheet_permanent: true,
      },
    ];
    expect(unregisteredPassiveEffectsForDisplay(passives, active)).toHaveLength(1);
    expect(combatEffectBadgeCounts(active, passives)).toEqual({ buffs: 3, debuffs: 0 });
  });

  it("usa exatamente a mesma deduplicação para o painel e para o cartão", () => {
    expect(combat).toContain("combatEffectBadgeCounts(fighterEffects, passiveEffectsForDisplay(abilitiesOf(f.id)))");
    expect(combat).toContain("unregisteredPassiveEffectsForDisplay(passiveEffects, effects)");
  });

  it("inclui debuffs passivos e não mistura habilidades de outros personagens", () => {
    const negative = passiveEffectsForDisplay([{
      id: "fraqueza-passiva",
      name: "Maldição",
      passive_effects: parseAbilityEffects([{
        name: "Fraqueza", effect_type: "status", attribute_key: "strength",
        polarity: "debuff", amount: 5, value_mode: "fixed",
      }]),
    }]);
    expect(combatEffectBadgeCounts([], negative)).toEqual({ buffs: 0, debuffs: 1 });
    expect(combatEffectBadgeCounts([], passives)).toEqual({ buffs: 2, debuffs: 0 });
  });
});
