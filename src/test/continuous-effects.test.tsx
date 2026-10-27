import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import {
  defaultContinuousRule, parseContinuousRules, pendingContinuousInstances,
  continuousDamageExpression, continuousDamageAdjusted, type ContinuousInstance,
} from "@/lib/continuous-effects";
import { ContinuousRulesEditor } from "@/components/abilities/ContinuousRulesEditor";

describe("Efeitos contínuos", () => {
  const target = "alvo";
  const caster = "origem";
  const rules = [
    {
      name: "Desgraça Física (configuração de teste)",
      trigger: "target",
      linger_turns: 3,
      actions: [
        { kind: "status", polarity: "debuff", attributes: [
          { key: "strength", mode: "percent", step: 5, cap: 100 },
          { key: "speed", mode: "percent", step: 5, cap: 100 },
        ] },
      ],
    },
    {
      name: "Desgraça Viva (configuração de teste)",
      trigger: "target",
      linger_turns: 0,
      actions: [
        { kind: "damage", damage_kind: "true", dice_count: 1, dice_sides: 50, flat: 0, neutralizable: true },
      ],
    },
  ];

  it("permite duas regras no mesmo catálogo sem criar habilidades no banco", () => {
    const parsed = parseContinuousRules(rules);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].linger_turns).toBe(3);
    expect(parsed[0].actions[0].kind).toBe("status");
    expect(parsed[1].actions[0].kind).toBe("damage");
  });

  it("permite limitar alvos e exigir escolha sem alterar configurações antigas", () => {
    const [rule] = parseContinuousRules([{
      name: "Agarrão", trigger: "target", linger_turns: 3,
      max_targets: 1, on_limit: "choose",
      stop_on_caster_leave: true, stop_on_caster_death: true, stop_on_caster_stun: true,
      actions: [{ kind: "status", polarity: "debuff", attributes: [
        { key: "strength", mode: "percent", step: 5, cap: 100 },
      ] }],
    }]);
    expect(rule.max_targets).toBe(1);
    expect(rule.on_limit).toBe("choose");
    expect(rule.stop_on_caster_death).toBe(true);
    expect(rule.stop_on_caster_stun).toBe(true);
    expect(rule.linger_turns).toBe(3);
    const [legacy] = parseContinuousRules([{
      ...rule, max_targets: undefined, on_limit: undefined,
      stop_on_caster_leave: undefined, stop_on_caster_death: undefined,
      stop_on_caster_stun: undefined,
    }]);
    expect(legacy.max_targets).toBeNull();
    expect(legacy.on_limit).toBe("replace_oldest");
    expect(legacy.stop_on_caster_leave).toBe(true);
    expect(legacy.stop_on_caster_death).toBe(false);
    expect(legacy.stop_on_caster_stun).toBe(false);
  });

  it("aceita DoTs registrados e efeitos secundários opcionais", () => {
    const parsed = parseContinuousRules([{
      name: "Efeitos diversos", trigger: "global", linger_turns: 0,
      actions: [
        { kind: "dot", template_id: "abc", damage_mode: "fixed", damage_amount: 12, duration: 2, repeat: false },
        { kind: "effect", effect_type: "stun", name: "Atordoar", duration: 1, repeat: true },
      ],
    }]);
    expect(parsed[0].actions).toHaveLength(2);
    expect(parsed[0].actions[0].kind).toBe("dot");
    expect(parsed[0].actions[1].kind).toBe("effect");
  });

  it("salva regras sem ações e mantém a grudagem exclusiva", () => {
    const grip = { ...defaultContinuousRule(), name: "Agarrar", exclusive_grip: true, max_targets: 1, actions: [] };
    expect(defaultContinuousRule().actions).toEqual([]);
    expect(parseContinuousRules([grip])).toMatchObject([{ name: "Agarrar", exclusive_grip: true, actions: [] }]);
    expect(parseContinuousRules([{ ...grip, actions: [{ kind: "unknown" }] }])[0]?.actions).toEqual([]);
    expect(parseContinuousRules([{ name: "Sem ações", trigger: "target" }])[0]?.actions).toEqual([]);
  });

  it("pula confirmações vazias, mas conserva a grudagem ativa", () => {
    const blank = { ...defaultContinuousRule(), actions: [] };
    const withEffect = { ...defaultContinuousRule(), actions: [{ kind: "status" as const, polarity: "debuff" as const, attributes: [] }] };
    const grips = [
      { id: "grip", active: true, rule: blank, target_character_id: target, caster_character_id: caster },
      { id: "effect", active: true, rule: withEffect, target_character_id: target, caster_character_id: caster },
    ] as ContinuousInstance[];
    expect(pendingContinuousInstances(grips, target).map(item => item.id)).toEqual(["effect"]);
    expect(grips[0].active).toBe(true);
  });

  it("seleciona somente os vínculos pertinentes ao turno", () => {
    const withEffect = { ...defaultContinuousRule(), actions: [{ kind: "status" as const, polarity: "debuff" as const, attributes: [] }] };
    const items = [
      { id: "1", active: true, rule: { ...withEffect, trigger: "target" }, target_character_id: target, caster_character_id: caster },
      { id: "2", active: true, rule: { ...withEffect, trigger: "caster" }, target_character_id: target, caster_character_id: caster },
      { id: "3", active: true, rule: { ...withEffect, trigger: "global" }, target_character_id: target, caster_character_id: caster },
      { id: "4", active: false, rule: defaultContinuousRule(), target_character_id: target, caster_character_id: caster },
    ] as ContinuousInstance[];
    expect(pendingContinuousInstances(items, target).map(i => i.id)).toEqual(["1"]);
    expect(pendingContinuousInstances(items, caster).map(i => i.id)).toEqual(["2"]);
    expect(pendingContinuousInstances(items, null).map(i => i.id)).toEqual(["3"]);
  });

  it("mantém 1d50 como instrução de rolagem no Discord, sem rolar no site", () => {
    const [rule] = parseContinuousRules([{name:"Mordida",trigger:"target",actions:[{
      kind:"damage",dice_count:1,dice_sides:50,flat:0,damage_kind:"true",neutralizable:true,
    }]}]);
    const action = rule.actions[0];
    expect(action.kind).toBe("damage");
    if(action.kind!=="damage")return;
    expect(action.damage_source).toBe("dice");
    expect(continuousDamageExpression(action)).toBe("1d50");
  });

  it("permite dano fixo e baseado em atributo com bônus e penalidade manual", () => {
    const [rule] = parseContinuousRules([{name:"Desgraça",trigger:"target",actions:[{
      kind:"damage",damage_source:"attribute",attribute_key:"strength",attribute_percent:50,
      fixed_damage:5,damage_kind:"physical",
    }]}]);
    expect(rule.actions[0]).toMatchObject({kind:"damage",damage_source:"attribute",attribute_percent:50,fixed_damage:5});
    expect(continuousDamageAdjusted(50,10,-25)).toBe(45);
    expect(continuousDamageAdjusted(50,-100,0)).toBe(0);
    expect(continuousDamageAdjusted(0,0,0)).toBe(0);
  });

  it("renderiza o editor mobile sem consultar personagens reais", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ContinuousRulesEditor
          rules={[defaultContinuousRule()]} onChange={() => {}}
          defs={[{ key: "strength", label: "Força" }, { key: "speed", label: "Velocidade" }]} />
      </QueryClientProvider>,
    );
    expect(html).toContain("Efeitos contínuos");
    expect(html).toContain("Nova regra");
    expect(html).toContain("Somente grudagem");
    expect(html).toContain("Só vínculo");
  });
});