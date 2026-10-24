import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import type { AbilityEffectDefinition } from "@/lib/abilities";

const resistance: AbilityEffectDefinition = {
  name: "Proteção contra venenos",
  effect_type: "dot_resistance",
  attribute_key: null,
  polarity: "buff",
  value_mode: "percent",
  amount: 25,
  duration: 2,
  damage_scope: "any",
  dot_resistance_scope: "all",
  dot_resistance_mode: "damage",
  dot_resistance_value_mode: "percent",
  dot_resistance_amount: 25,
  dot_resistance_template_ids: [],
};

function renderEditor(permanent: boolean, effects: AbilityEffectDefinition[]) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AbilityEffectsEditor
        effects={effects}
        onChange={() => {}}
        permanent={permanent}
        defs={[]}
      />
    </QueryClientProvider>,
  );
}

describe("editor de Resistência a DoTs", () => {
  it.each([true, false])("renderiza os campos sem derrubar a página (permanente=%s)", (permanent) => {
    const markup = renderEditor(permanent, [resistance]);
    expect(markup).toContain("Quais DoTs são afetados?");
    expect(markup).toContain("Valor da resistência");
    expect(markup).toContain("Reduzir");
    expect(markup).toContain("Duração do DoT");
    expect(markup).toContain("Proteção contra venenos");
  });

  it("oferece Resistência a DoTs no menu de efeitos da habilidade", () => {
    const markup = renderEditor(false, []);
    expect(markup).toContain("Adicionar efeito");
    const withEffect = renderEditor(false, [{ ...resistance, effect_type: "status", attribute_key: "strength" }]);
    expect(withEffect).toContain('value="dot_resistance"');
    expect(withEffect).toContain("Resistência a DoTs");
  });
});
