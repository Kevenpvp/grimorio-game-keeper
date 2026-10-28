import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "drizzle/migrations/192_battle_mana_regen_toggle.sql"), "utf8",
);
const combat = readFileSync(
  resolve(process.cwd(), "src/routes/_authenticated/combate.tsx"), "utf8",
);

describe("Regenerar Mana por Turno", () => {
  it("começa desligado e com 40 de Mana fixa, armazenados por combatente", () => {
    expect(migration).toContain("mana_regen_enabled boolean NOT NULL DEFAULT false");
    expect(migration).toContain("mana_regen_mode text NOT NULL DEFAULT 'fixed'");
    expect(migration).toContain("mana_regen_amount numeric NOT NULL DEFAULT 40");
    expect(combat).toContain("mana_regen_amount ?? 40");
    expect(combat).toContain('mana_regen_mode ?? "fixed"');
  });

  it("o checkbox está no cartão e somente o mestre pode alterá-lo", () => {
    expect(combat).toContain('aria-label={`Regenerar Mana por Turno de ${f.name}`}');
    expect(combat).toContain("checked={!!f.mana_regen_enabled}");
    expect(combat).toContain("{isMaster && (");
    expect(combat).toContain('db.rpc("configure_battle_mana_regeneration"');
    expect(migration).toContain("public.has_role(auth.uid(),'master')");
  });

  it("o servidor respeita a opção salva, tanto no turno global quanto no individual", () => {
    expect(migration).toContain("bp.mana_regen_enabled");
    expect(migration).toContain("(_character_id IS NULL OR bp.character_id=_character_id)");
    expect(migration).toContain("jsonb_object_agg(bp.character_id::text");
    expect(migration).toContain("A rotina de turnos mudou");
    expect(combat).toContain("const manaRegenerationSettingsForTurn: Record<string, never> = {};");
  });

  it("o mestre pode alterar modo e quantidade nos Recursos e salvar", () => {
    expect(combat).toContain("Salvar regeneração");
    expect(combat).toContain("onManaRegenSave");
    expect(combat).toContain("onManaRegenModeChange");
    expect(combat).toContain("onManaRegenAmountChange");
  });
});
