import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { masterExtraPoints, signedAttributeDisplayValue, unspentOriginPoints } from "@/lib/sheets";

const masterSheet = readFileSync(resolve(process.cwd(), "src/routes/_authenticated/ficha.$id.tsx"), "utf8");
const playerView = readFileSync(resolve(process.cwd(), "src/routes/_authenticated/painel.tsx"), "utf8");
const sheetView = readFileSync(resolve(process.cwd(), "src/components/sheet/CharacterSheetView.tsx"), "utf8");

describe("atributos negativos apenas na interface", () => {
  it("mostra a Força negativa sem alterar o limite usado pelo combate", () => {
    expect(signedAttributeDisplayValue({ body: 100, sanity: 100 }, "strength", -3)).toBe(-3);
    expect(signedAttributeDisplayValue({ body: 100, sanity: 100 }, "strength", -11)).toBe(-11);
    expect(signedAttributeDisplayValue({ body: 50, sanity: 100 }, "speed", -10)).toBe(-5);
    expect(signedAttributeDisplayValue({ body: 100, sanity: 50 }, "mental", -8)).toBe(-4);
    expect(sheetView).toContain("signedAttributeDisplayValue(character, d.key, calculatedValue)");
    expect(masterSheet).toContain("const visualTotal =");
  });
});

describe("pontos extras do mestre", () => {
  const makeCharacter = (patch: Record<string, unknown> = {}) => ({
    available_points: 9,
    race_points_granted: 9,
    race_attribute_allocations: {},
    virtue_points_granted: 0,
    virtue_attribute_allocations: {},
    class_points_granted: 0,
    class_attribute_allocations: {},
    ...patch,
  });

  it("não confunde os 9 pontos raciais com os extras do mestre", () => {
    const character = makeCharacter();
    expect(unspentOriginPoints(character)).toBe(9);
    expect(masterExtraPoints(character)).toBe(0);
    expect(masterExtraPoints(makeCharacter({ available_points: 19 }))).toBe(10);
  });

  it("subtrai apenas os pontos de origem ainda não distribuídos", () => {
    const character = makeCharacter({
      available_points: 16,
      race_attribute_allocations: { strength: 4 },
      virtue_points_granted: 5,
      virtue_attribute_allocations: { iq: 2 },
      class_points_granted: 3,
      class_attribute_allocations: { speed: 1 },
    });
    // Raça 5 + Virtude 3 + Classe 2 = 10; sobram 6 do mestre.
    expect(unspentOriginPoints(character)).toBe(10);
    expect(masterExtraPoints(character)).toBe(6);
  });

  it("converte o valor exibido novamente para o saldo agregado ao salvar", () => {
    expect(masterSheet).toContain("Pontos extras do mestre");
    expect(masterSheet).toContain("available_points: v + unspentOriginPoints(character)");
  });
});

describe("jogador com várias fichas", () => {
  it("consulta todas as fichas de seu próprio e-mail e permite escolher qual visualizar", () => {
    expect(playerView).toContain('eq("owner_id", userId)');
    expect(playerView).toContain('eq("is_summon_snapshot", false)');
    expect(playerView).not.toContain(".limit(1).maybeSingle()");
    expect(playerView).toContain("Minhas fichas");
    expect(playerView).toContain("setSelectedCharacterId(character.id)");
    expect(playerView).toContain("<PlayerSheet key={selected.id} id={selected.id} />");
    expect(playerView).toContain('to="/ficha/$id"');
  });
});
