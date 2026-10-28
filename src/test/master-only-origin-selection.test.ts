import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (name: string) => readFileSync(resolve(process.cwd(), name), "utf8");
const migration = read("drizzle/migrations/196_master_only_origin_selection.sql");
const panel = read("src/routes/_authenticated/painel.tsx");
const sheet = read("src/routes/_authenticated/ficha.$id.tsx");
const racePicker = read("src/components/sheet/RacePicker.tsx");
const classPicker = read("src/components/sheet/ClassPicker.tsx");
const overview = read("src/components/sheet/CharacterOriginOverview.tsx");

describe("origens de personagem: somente o mestre escolhe", () => {
  it("bloqueia todos os endpoints de escolha, incluindo chamadas antigas e sobrecargas", () => {
    for (const signature of [
      "choose_character_race(uuid,uuid)",
      "choose_character_virtue(uuid,uuid)",
      "choose_character_class(uuid,uuid)",
      "choose_character_class(uuid,uuid,jsonb)",
      "choose_character_traits(uuid,uuid,uuid)",
      "choose_race(uuid,uuid)",
    ]) {
      expect(migration).toContain(signature);
    }
    expect(migration).toContain("auth.uid() IS NULL OR NOT public.has_role(auth.uid(), ''master'')");
    expect(migration).toContain("Apenas o mestre pode escolher ou alterar Raça, Virtude e Classe");
  });

  it("substitui o seletor do jogador por uma apresentação somente de leitura", () => {
    expect(panel).toContain("<CharacterOriginOverview character={data.character} />");
    expect(sheet).toContain("<CharacterOriginOverview character={data.character} />");
    expect(panel).not.toContain('isMaster={false} />');
    expect(sheet).not.toContain('<RacePicker character={data.character} isMaster={false} />');
    expect(sheet).not.toContain('<ClassPicker character={data.character} isMaster={false} />');
    expect(overview).toContain("Aguardando definição do mestre.");
    expect(overview).toContain("exclusivamente pelo mestre");
    expect(overview).not.toContain("choose_character_");
  });

  it("mantém os editores apenas para o mestre, mesmo se importados por engano", () => {
    expect(racePicker).toContain("const canChooseRace = isMaster;");
    expect(racePicker).toContain("const canChooseVirtue = isMaster;");
    expect(racePicker).toContain("if (!isMaster || !races || !virtues || !defs) return null;");
    expect(classPicker).toContain("if (!isMaster || !classes || !defs) return null;");
    expect(sheet).toContain("<RacePicker character={character} isMaster />");
    expect(sheet).toContain("<ClassPicker character={character} isMaster />");
  });
});
