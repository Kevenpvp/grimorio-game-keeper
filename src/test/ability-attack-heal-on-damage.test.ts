import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAbilityAttackDamage } from "@/lib/abilities";
import { onHitHealingDescription } from "@/components/abilities/AbilityAttackOnHitHealingEditor";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const ui = read("src/components/abilities/AbilityAttackOnHitHealingEditor.tsx");
const sheetEditor = read("src/components/abilities/SheetAbilityAttackEditor.tsx");
const catalogEditor = read("src/routes/_authenticated/habilidades.tsx");
const combat = read("src/components/abilities/CharacterAbilities.tsx");
const migration = read("drizzle/migrations/200_attack_heal_on_damage.sql");

describe("Curar no Dano no ataque de habilidade", () => {
  it("habilidades antigas continuam sem cura até o mestre ativar a nova opção", () => {
    const parsed = parseAbilityAttackDamage({ damage_kind: "physical", fixed_damage: 40 });
    expect(parsed.heal_on_damage_enabled).toBe(false);
    expect(parsed.heal_on_damage_mode).toBe("percent");
    expect(parsed.heal_on_damage_amount).toBe(0);
    expect(onHitHealingDescription(parsed)).toBeNull();
  });

  it("configura cura de percentual do dano mitigado ou HP fixo", () => {
    const percent = parseAbilityAttackDamage({
      heal_on_damage_enabled: true, heal_on_damage_mode: "percent",
      heal_on_damage_amount: 35,
    });
    const fixed = parseAbilityAttackDamage({
      heal_on_damage_enabled: true, heal_on_damage_mode: "fixed",
      heal_on_damage_amount: 20,
    });
    expect(onHitHealingDescription(percent)).toContain("35% do dano final");
    expect(onHitHealingDescription(fixed)).toContain("20 HP por alvo acertado");
    expect(parseAbilityAttackDamage({ heal_on_damage_mode: "percent", heal_on_damage_amount: 10000 }).heal_on_damage_amount)
      .toBe(1000);
    expect(parseAbilityAttackDamage({ heal_on_damage_mode: "fixed", heal_on_damage_amount: -10 }).heal_on_damage_amount)
      .toBe(0);
  });

  it("o editor é compartilhado por catálogo e ficha, incluindo habilidades próprias da ficha", () => {
    expect(ui).toContain("Curar no Dano");
    expect(ui).toContain("% do dano final causado");
    expect(ui).toContain("Valor fixo de HP");
    expect(ui).toContain("checked={value.heal_on_damage_enabled}");
    expect(sheetEditor).toContain("<AbilityAttackOnHitHealingEditor value={attackDamage} onChange={setAttackDamage}");
    expect(catalogEditor).toContain("<AbilityAttackOnHitHealingEditor value={attackDamage} onChange={setAttackDamage}");
    expect(catalogEditor).toContain("attack_damage: {");
    expect(combat).toContain("attack_damage: attackDamage");
  });

  it("a cura usa o dano FINAL do runtime após defesa, crítico e scripts, nunca o dano base", () => {
    expect(combat).toContain("const finalDamage = Number(damageResult.total_damage ?? 0)");
    expect(combat).toContain('db.rpc(');
    expect(combat).toContain('"apply_ability_attack_on_hit_healing"');
    expect(combat).toContain("_character_ability_id: attackAbility.id");
    expect(combat).toContain("_target_character_id: target.id");
    expect(combat).toContain("_final_damage: finalDamage");
    expect(combat).toContain("Curar no Dano: +");
    expect(combat.indexOf("const damageResult =")).toBeLessThan(combat.indexOf("const finalDamage = Number(damageResult.total_damage"));
    expect(combat.indexOf("const finalDamage = Number(damageResult.total_damage")).toBeLessThan(combat.indexOf("const appliedEffectsResponse ="));
  });

  it("só recebe cura após acertar; respeita máximo de HP, bloqueio de cura e segurança", () => {
    expect(combat).toContain("for (const target of hitTargets)");
    expect(combat).toContain("if (zeroHpAfterAttack.has(target.id))");
    expect(combat).toContain("if (!shouldApplyAbilityDirectDamage(finalBaseDamage))");
    expect(migration).toContain("public.has_role(auth.uid(), 'master')");
    expect(migration).toContain("public.battle_participants");
    expect(migration).toContain("a.attack_damage");
    expect(migration).toContain("_ability.attack_damage");
    expect(migration).toContain("FLOOR(_final_damage*_amount/100)");
    expect(migration).toContain("public.apply_ability_healing");
    expect(migration).toContain("REVOKE ALL ON FUNCTION");
  });
});
