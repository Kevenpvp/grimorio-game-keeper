import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { groupCharactersByAccount } from "@/lib/group-characters-by-account";

const dashboard = readFileSync(resolve(process.cwd(), "src/routes/_authenticated/painel.tsx"), "utf8");

const characters = [
  { id: "1", name: "Shadow", player_name: "Tener", owner_id: "user-1" },
  { id: "2", name: "Tener", player_name: "Tener", owner_id: "user-1" },
  { id: "3", name: "Dragão", player_name: "Tener", owner_id: null },
  { id: "4", name: "Lily", player_name: "Lily", owner_id: "user-2" },
  { id: "5", name: "Guarda", player_name: null, owner_id: null },
  { id: "6", name: "Bardo", player_name: "Tener", owner_id: "user-3" },
];
const profiles = [
  { id: "user-1", email: "tener@example.com", display_name: "Tener" },
  { id: "user-2", email: "lily@example.com", display_name: "Lily" },
  { id: "user-3", email: "bardo@example.com", display_name: "Tener" },
];

describe("Biblioteca de fichas agrupada por e-mail", () => {
  it("agrupa diferentes fichas da mesma conta e separa contas distintas com o mesmo apelido", () => {
    const grouped = groupCharactersByAccount(characters, profiles);
    expect(grouped.map((group) => group.email)).toEqual([
      "bardo@example.com", "lily@example.com", "tener@example.com", null,
    ]);
    expect(grouped.find((group) => group.email === "tener@example.com")?.characters.map((c) => c.name))
      .toEqual(["Shadow", "Tener"]);
    expect(grouped.find((group) => group.email === "bardo@example.com")?.characters.map((c) => c.name))
      .toEqual(["Bardo"]);
  });

  it("fichas sem conta vinculada ficam na última categoria: NPCs", () => {
    const npc = groupCharactersByAccount(characters, profiles).at(-1);
    expect(npc?.id).toBe("npc");
    expect(npc?.isNpc).toBe(true);
    expect(npc?.characters.map((character) => character.name)).toEqual(["Dragão", "Guarda"]);
  });

  it("pesquisa por e-mail e nome de perfil, exibindo todas as fichas do grupo correspondente", () => {
    const email = groupCharactersByAccount(characters, profiles, "TENER@EXAMPLE.COM");
    expect(email).toHaveLength(1);
    expect(email[0].characters.map((c) => c.name)).toEqual(["Shadow", "Tener"]);

    const byPlayer = groupCharactersByAccount(characters, profiles, "lily@example");
    expect(byPlayer[0].characters.map((c) => c.name)).toEqual(["Lily"]);
  });

  it("pesquisa por personagem ou apelido mesmo quando ele pertence a um grupo", () => {
    const byName = groupCharactersByAccount(characters, profiles, "Shadow");
    expect(byName).toHaveLength(1);
    expect(byName[0].characters.map((c) => c.id)).toEqual(["1"]);

    const byAlias = groupCharactersByAccount(characters, profiles, "Tener");
    expect(byAlias.some((group) => group.isNpc)).toBe(true);
    expect(byAlias.find((group) => group.isNpc)?.characters.map((c) => c.name)).toEqual(["Dragão"]);
  });

  it("preserva conta vinculada mesmo quando um perfil não tem e-mail disponível", () => {
    const result = groupCharactersByAccount(
      [{ id: "x", name: "Vampiro", player_name: "Jogador", owner_id: "unknown" }],
      [],
    );
    expect(result).toMatchObject([{ id: "account:unknown", isNpc: false, email: null }]);
  });

  it("mantém controle para expandir e recolher categorias e cartões responsivos", () => {
    expect(dashboard).toContain("master-character-owner-profiles");
    expect(dashboard).toContain('.from("profiles")');
    expect(dashboard).toContain('groupCharactersByAccount(list, profiles, q)');
    expect(dashboard).toContain("Expandir todas");
    expect(dashboard).toContain("Recolher todas");
    expect(dashboard).toContain("aria-expanded={expanded}");
    expect(dashboard).toContain("setExpandedGroups");
    expect(dashboard).toContain("Personagens sem conta de jogador vinculada");
    expect(dashboard).toContain("sm:grid-cols-2 sm:p-4 lg:grid-cols-3");
    expect(dashboard).toContain('to="/ficha/$id"');
  });
});
