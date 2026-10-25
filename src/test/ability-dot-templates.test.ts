import { describe, expect, it } from "vitest";
import { applyRegisteredDotTemplate, findRegisteredDotTemplate, registerAbilityDotTemplates } from "@/lib/ability-dot-templates";
import type { AbilityDotEffect, DotTemplateOption } from "@/lib/abilities";

const templates = [{
  id: "sangramento-id", name: "Sangramento", damage_kind: "physical",
  physical_damage_type_id: "fisico-id", damage_type_id: null, magic_level: null,
}, {
  id: "veneno-id", name: "Veneno de Aranha", damage_kind: "magical",
  physical_damage_type_id: null, damage_type_id: "magico-id", magic_level: "baixa",
}] as DotTemplateOption[];

const saved: AbilityDotEffect = {
  id: "attack-dot", template_id: null, name: "sangramento", damage_kind: "physical",
  physical_damage_type_id: "fisico-id", damage_type_id: null, magic_level: null,
  damage_mode: "fixed", damage_amount: 48, attribute_key: null, attribute_percent: 100,
  fixed_damage: 0, duration: 7,
};

describe("DoTs de habilidades reutilizam os modelos registrados", () => {
  it("identifica configuração legada pelo nome e pelo tipo", () => {
    expect(findRegisteredDotTemplate(saved, templates)?.id).toBe("sangramento-id");
  });
  it("mantém somente dano e duração editáveis", () => {
    const changed = applyRegisteredDotTemplate(saved, templates[1]);
    expect(changed).toMatchObject({
      template_id: "veneno-id", name: "Veneno de Aranha", damage_kind: "magical",
      physical_damage_type_id: null, damage_type_id: "magico-id", magic_level: "baixa",
      damage_amount: 48, duration: 7, id: "attack-dot",
    });
  });
  it("normaliza antigos sem mudar o dano salvo", () => {
    expect(registerAbilityDotTemplates([saved], templates)[0]).toMatchObject({
      template_id: "sangramento-id", name: "Sangramento", damage_amount: 48, duration: 7,
    });
  });
  it("não troca referências apagadas por modelos parecidos", () => {
    const deleted = { ...saved, template_id: "apagado" };
    expect(findRegisteredDotTemplate(deleted, templates)).toBeUndefined();
  });
});