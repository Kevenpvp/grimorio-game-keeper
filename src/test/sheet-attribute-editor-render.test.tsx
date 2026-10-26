import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PointsDistribution } from "@/components/sheet/PointsDistribution";
import { PhysicalPointsDistribution } from "@/components/sheet/PhysicalPointsDistribution";
import { QuickMasterAttributes } from "@/components/sheet/QuickMasterAttributes";
import type { AttributeDef, Character, CharacterAttr } from "@/lib/sheets";

// Render the real editor components. A production regression previously escaped
// the build because <Input> was used in PointsDistribution without an import.
const character = {
  id: "character-test",
  body: 100,
  sanity: 100,
  available_points: 10,
  race_points_granted: 0,
  virtue_points_granted: 0,
  class_points_granted: 0,
  race_attribute_allocations: {},
  virtue_attribute_allocations: {},
  class_attribute_allocations: {},
  race_physical_allocations: {},
  virtue_physical_allocations: {},
  class_physical_allocations: {},
} as unknown as Character;
const defs = [{
  key: "strength",
  label: "Força",
  icon: "dumbbell",
  accepts_points: true,
  base_value: 0,
  points_multiplier: 1,
}] as AttributeDef[];
const attrs = [{
  attribute_key: "strength",
  character_id: "character-test",
  points: 2,
  bonus: 0,
  current_value: 2,
  max_value: 2,
}] as CharacterAttr[];

function page(children: React.ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>,
  );
}

describe("Editor de atributos e distribuição de pontos da ficha", () => {
  it("renderiza a distribuição geral do mestre com campo numérico", () => {
    const html = page(<PointsDistribution character={character} attrs={attrs} defs={defs} canRemove />);
    expect(html).toContain("Ajustar pontos");
    expect(html).toContain("Força");
  });

  it("renderiza distribuição física do mestre sem quebrar a página", () => {
    const html = page(<PhysicalPointsDistribution character={character} attrs={attrs} defs={defs} masterQuickEntry />);
    expect(html).toContain("Pontos Extras de Atributos Físicos");
  });

  it("renderiza a edição direta com total atual e opção de salvar", () => {
    const html = page(<QuickMasterAttributes
      character={character}
      attrs={attrs}
      defs={defs}
      traitModifiers={{}}
      statusModifiers={{}}
      noMana={false}
      onSaved={() => {}}
    />);
    expect(html).toContain("Definir atributos diretamente");
    expect(html).toContain('value="2"');
  });
});
