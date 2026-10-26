import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import {
  defaultContinuousRule, parseContinuousRules, pendingContinuousInstances,
  previewContinuousDamage, type ContinuousInstance,
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

  it("seleciona somente os vínculos pertinentes ao turno", () => {
    const items = [
      { id: "1", active: true, rule: { ...defaultContinuousRule(), trigger: "target" }, target_character_id: target, caster_character_id: caster },
      { id: "2", active: true, rule: { ...defaultContinuousRule(), trigger: "caster" }, target_character_id: target, caster_character_id: caster },
      { id: "3", active: true, rule: { ...defaultContinuousRule(), trigger: "global" }, target_character_id: target, caster_character_id: caster },
      { id: "4", active: false, rule: defaultContinuousRule(), target_character_id: target, caster_character_id: caster },
    ] as ContinuousInstance[];
    expect(pendingContinuousInstances(items, target).map(i => i.id)).toEqual(["1"]);
    expect(pendingContinuousInstances(items, caster).map(i => i.id)).toEqual(["2"]);
    expect(pendingContinuousInstances(items, null).map(i => i.id)).toEqual(["3"]);
  });

  it("rola 1d50 com limites corretos", () => {
    const action = { kind: "damage" as const, dice_count: 1, dice_sides: 50, flat: 0, damage_kind: "true" as const, neutralizable: true };
    const rand = vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.9999999);
    expect(previewContinuousDamage(action)).toBe(1);
    expect(previewContinuousDamage(action)).toBe(50);
    rand.mockRestore();
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
  });
});