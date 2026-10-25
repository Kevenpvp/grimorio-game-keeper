import { describe, expect, it } from "vitest";
import { classSelectionHasChanges } from "@/lib/class-selection";

const defaults = {
  selectedClassId: "warrior",
  confirmedClassId: "warrior",
  draftModifiers: {} as Record<string, string>,
  confirmedModifiers: {} as Record<string, number>,
  isMaster: true,
};

describe("confirmação da classe", () => {
  it("desativa o botão após confirmar a mesma classe sem alterações", () => {
    expect(classSelectionHasChanges(defaults)).toBe(false);
  });
  it("ativa ao selecionar outra classe ou remover a classe", () => {
    expect(classSelectionHasChanges({ ...defaults, selectedClassId: "archer" })).toBe(true);
    expect(classSelectionHasChanges({ ...defaults, selectedClassId: null })).toBe(true);
  });
  it("ativa ao editar somente os bônus extras da ficha", () => {
    expect(classSelectionHasChanges({
      ...defaults,
      draftModifiers: { phys_def: "5" },
    })).toBe(true);
    expect(classSelectionHasChanges({
      ...defaults,
      draftModifiers: { phys_def: "8" },
      confirmedModifiers: { phys_def: 5 },
    })).toBe(true);
  });
  it("ignora espaços, zeros e formatação numérica equivalente", () => {
    expect(classSelectionHasChanges({
      ...defaults,
      draftModifiers: { phys_def: " 05 ", strength: "", speed: "0" },
      confirmedModifiers: { phys_def: 5 },
    })).toBe(false);
  });
  it("ativa ao zerar um bônus antes existente", () => {
    expect(classSelectionHasChanges({
      ...defaults,
      draftModifiers: { strength: "" },
      confirmedModifiers: { strength: 20 },
    })).toBe(true);
  });
  it("mantém seleção confirmada bloqueada para jogador e permite trocar classe", () => {
    expect(classSelectionHasChanges({ ...defaults, isMaster: false, draftModifiers: { phys_def: "10" } })).toBe(false);
    expect(classSelectionHasChanges({ ...defaults, isMaster: false, selectedClassId: "archer" })).toBe(true);
  });
  it("não permite confirmar sem classe nem alterações", () => {
    expect(classSelectionHasChanges({ ...defaults, selectedClassId: null, confirmedClassId: null })).toBe(false);
  });
});
