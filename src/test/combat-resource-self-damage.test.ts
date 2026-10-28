import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const combat = readFileSync(resolve(process.cwd(), "src/routes/_authenticated/combate.tsx"), "utf8");
const damageApplier = readFileSync(resolve(process.cwd(), "src/components/combat/DamageApplier.tsx"), "utf8");

describe("Aplicar dano no próprio cartão de Recursos e efeitos", () => {
  it("disponibiliza a ferramenta apenas na aba restrita ao mestre", () => {
    expect(combat).toContain('detailTab === "effects" && isMaster && <CombatResourceEditor');
    expect(combat).toContain("Aplicar dano em {fighter.name}");
    expect(combat).toContain('target={{ id: fighter.id, name: fighter.name }}');
  });

  it("reutiliza o mesmo formulário completo e vincula dano à batalha e aos combatentes", () => {
    expect(combat).toContain("battleId={battle.id} damageSources={fighters.map");
    expect(combat).toContain("<DamageApplier");
    expect(combat).toContain("battleId={battleId}");
    expect(combat).toContain("sources={damageSources}");
    expect(damageApplier).toContain('action: "apply_damage"');
    expect(damageApplier).toContain("_character_id: target.id");
    expect(damageApplier).toContain("_source_character_id: effectiveSourceCharacterId");
    expect(damageApplier).toContain("Dano Crítico");
    expect(damageApplier).toContain("Dano verdadeiro");
    expect(damageApplier).toContain("Efeitos e DoTs");
  });

  it("mantém atualização do HP, batalha, efeitos e habilidades após dano", () => {
    expect(damageApplier).toContain('qc.invalidateQueries({ queryKey: ["battles"] })');
    expect(damageApplier).toContain('qc.invalidateQueries({ queryKey: ["battle-effects"] })');
    expect(damageApplier).toContain('qc.invalidateQueries({ queryKey: ["character-abilities-battle"] })');
  });
});
