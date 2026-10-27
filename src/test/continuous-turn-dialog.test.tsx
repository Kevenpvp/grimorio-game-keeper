import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ContinuousTurnDialog } from "@/components/combat/ContinuousTurnDialog";
import { parseContinuousRules, type ContinuousInstance } from "@/lib/continuous-effects";

describe("Confirmação de dano periódico", () => {
  it("monta a janela da Desgraça Viva sem ReferenceError em estados aninhados", () => {
    const [rule] = parseContinuousRules([{
      name: "Mordida da Desgraça Viva",
      trigger: "target",
      linger_turns: 0,
      actions: [{
        kind: "damage", damage_source: "dice", dice_expression: "1d50",
        damage_kind: "true", neutralizable: true,
      }],
    }]);
    const item:ContinuousInstance = {
      id:"effect-1",battle_id:"battle-1",character_ability_id:"ability-1",
      caster_character_id:"caster-1",target_character_id:"target-1",
      rule_index:0,name:rule.name,rule,ticks:0,active:true,
    };
    expect(() => renderToStaticMarkup(
      <ContinuousTurnDialog
        items={[item]} title="Turno do alvo" busy={false}
        fighterNames={{"caster-1":"Desgraça Viva","target-1":"Vítima"}}
        casterAttributes={{"caster-1":{strength:10}}}
        damageTypes={[]}
        onCancel={() => {}} onConfirm={() => {}}
      />
    )).not.toThrow();
  });
});
