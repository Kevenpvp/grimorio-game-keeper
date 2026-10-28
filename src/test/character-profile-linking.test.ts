import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sheet = readFileSync(resolve(process.cwd(), "src/routes/_authenticated/ficha.$id.tsx"), "utf8");

describe("vincular ficha a conta recém-cadastrada", () => {
  it("permite encontrar contas pelo e-mail ou nome de exibição", () => {
    expect(sheet).toContain("Buscar conta por nome ou e-mail");
    expect(sheet).toContain("[p.display_name, p.email]");
    expect(sheet).toContain("visibleProfiles.map");
  });

  it("reconsulta perfis ao abrir o seletor ou clicar Atualizar", () => {
    expect(sheet).toContain("refetch: refreshProfiles");
    expect(sheet).toContain("refetchInterval: 15000");
    expect(sheet).toContain("if (open) void refreshProfiles()");
    expect(sheet).toContain("onClick={() => void refreshProfiles()}");
  });

  it("mostra erros de consulta em vez de fingir que não há usuários", () => {
    expect(sheet).toContain("if (error) throw error;");
    expect(sheet).toContain("Falha ao carregar contas:");
  });
});
