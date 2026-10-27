import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "drizzle/migrations/187_transformation_duration_manual_end.sql"),
  "utf8",
);
const combat = readFileSync(
  resolve(process.cwd(), "src/routes/_authenticated/combate.tsx"),
  "utf8",
);

describe("Duração e encerramento das transformações", () => {
  it("diminui a duração real sem confundi-la com cooldown", () => {
    expect(migration).toContain("active_duration_remaining=CASE");
    expect(migration).toContain("GREATEST(0,ct.active_duration_remaining-_steps)");
    expect(migration).toContain("cooldown_remaining=GREATEST(0,ct.cooldown_remaining-_steps)");
  });

  it("encerra somente quando a duração chega a zero e aplica a limpeza existente", () => {
    expect(migration).toContain("_state.active_duration_remaining=0");
    expect(migration).toContain("public.end_character_transformation_internal(");
  });

  it("protege a destransformação voluntária por ficha e batalha", () => {
    expect(migration).toContain("public.has_role(auth.uid(),'master')");
    expect(migration).toContain("_character.owner_id IS DISTINCT FROM auth.uid()");
    expect(migration).toContain("_state.active_battle_id IS DISTINCT FROM _battle_id");
    expect(combat).toContain('db.rpc("end_character_transformation"');
  });

  it("exibe Destransformar na ficha de combate e atualiza o contador após passar o turno", () => {
    expect(combat).toContain("activeTransformationState.transformation_id");
    expect(combat).toContain("Destransformar");
    expect(combat).toContain('qc.invalidateQueries({ queryKey: ["battle-character-transformations"] })');
    expect(combat).toContain('["battle-character-transformations"],');
  });
});
