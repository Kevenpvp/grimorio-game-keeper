import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAbilityDotEffects } from "@/lib/abilities";
import { applyRegisteredDotTemplate } from "@/lib/ability-dot-templates";

const read = (name: string) => readFileSync(resolve(process.cwd(), name), "utf8");
const combat = read("src/components/abilities/CharacterAbilities.tsx");
const dotEditor = read("src/components/abilities/SheetAbilityAttackEditor.tsx");
const migration = read("drizzle/migrations/199_temporary_battle_ability_dots.sql");

describe("DoTs temporários na habilidade durante combate", () => {
  it("permite adicionar apenas modelos registrados, com dano e duração ajustáveis", () => {
    expect(combat).toContain("DoTs temporários nesta batalha");
    expect(combat).toContain("<AbilityDotEffectsEditor");
    expect(combat).toContain("dotEffects");
    expect(combat).toContain("findRegisteredDotTemplate(dot, dotTemplates)");
    expect(combat).toContain("registerAbilityDotTemplates(dotEffects, dotTemplates)");
    expect(combat).toContain("dot_effects: registerAbilityDotTemplates(dotEffects, dotTemplates)");
    expect(dotEditor).toContain("Adicionar DoT registrado");
    expect(dotEditor).toContain("Duração (turnos do alvo)");
    const template = {
      id: "dot-registered", name: "Sangramento",
      damage_kind: "physical" as const,
      physical_damage_type_id: "physical-type", damage_type_id: null, magic_level: null,
    };
    const dot = parseAbilityDotEffects([{
      id: "per-battle", name: template.name,
      damage_kind: template.damage_kind, damage_mode: "fixed",
      damage_amount: 27, duration: 3,
    }])[0];
    expect(applyRegisteredDotTemplate(dot, template)).toMatchObject({
      template_id: template.id, name: "Sangramento",
      damage_amount: 27, duration: 3,
    });
  });

  it("carrega os DoTs temporários também ao Ativar e ao Atacar", () => {
    expect(combat).toContain("values.dot_effects");
    expect(combat).toContain("dotEffects: effectiveDots");
    expect(combat).toContain("activationSetup.dotEffects");
    expect(combat).toContain("const guaranteedDots = guaranteedAttackDots;");
    expect(combat).toContain("activeAttackOverride.override_values.dot_effects");
    expect(combat).toContain("battle-ability-override");
    expect(combat).toContain("_dot_target_selections: chosenTargets.map");
  });

  it("o servidor usa a lista temporária antes de eliminar uma alteração de uso único", () => {
    expect(migration).toContain("bo.override_values->'dot_effects'");
    expect(migration).toContain("_guaranteed_dots:=_current_guaranteed_dots;");
    expect(migration).toContain("public.apply_character_ability_dots");
    expect(migration).toContain("keep_after_use = false");
    expect(migration).toContain("activate_character_ability_attack");
    expect(migration).toContain("activate_character_ability");
    expect(migration).toContain("Limite de 100 DoTs temporários por habilidade");
  });

  it("não altera o catálogo ou a habilidade permanente ao salvar os DoTs temporários", () => {
    expect(combat).toContain('db.from("battle_ability_overrides").upsert');
    expect(combat).toContain("keep_after_use: keepAfterUse");
    expect(combat).toContain("Restaurar valores originais");
    expect(migration).not.toContain("UPDATE public.character_abilities SET dot_effects");
    expect(migration).not.toContain("UPDATE public.abilities SET dot_effects");
  });
});
