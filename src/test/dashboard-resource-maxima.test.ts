import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dashboard = readFileSync(
  resolve(process.cwd(), "src/routes/_authenticated/painel.tsx"), "utf8",
);
const migration = readFileSync(
  resolve(process.cwd(), "drizzle/migrations/188_master_dashboard_resource_maxima.sql"), "utf8",
);

describe("máximos de HP e Mana no painel", () => {
  it("obtém o máximo autoritativo do banco, sem ignorar bônus personalizados de classe", () => {
    expect(dashboard).toContain('rpc("list_character_resource_maxima")');
    expect(dashboard).toContain("maximaByCharacter.get(c.id)");
    expect(dashboard).toContain("authoritativeMaxima?.mana_max");
    expect(dashboard).toContain("authoritativeMaxima?.hp_max");
    expect(dashboard).not.toContain('computeValue(def, (attr.points ?? 0) + modifier');
  });

  it("mantém valores atualizados e não mostra um máximo falso enquanto carrega", () => {
    expect(dashboard).toContain("isLoading || maximaLoading");
    expect(dashboard).toContain("refetchInterval: 8000");
    expect(dashboard).toContain("Não foi possível consultar a Mana e o HP máximos");
  });

  it("só permite ao mestre consultar os máximos de todo o elenco", () => {
    expect(migration).toContain("public.has_role(auth.uid(),'master')");
    expect(migration).toContain("SECURITY INVOKER");
    expect(migration).toContain("public.calculate_character_resource_max(c.id, 'mana')");
    expect(migration).toContain("public.calculate_character_resource_max(c.id, 'hp')");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.list_character_resource_maxima() FROM PUBLIC,anon");
  });
});
