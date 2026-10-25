import type { AbilityDotEffect, DotTemplateOption } from "@/lib/abilities";

/** Catalog fields are immutable on the ability; only its damage settings vary. */
export function applyRegisteredDotTemplate(
  dot: AbilityDotEffect,
  template: DotTemplateOption,
): AbilityDotEffect {
  return {
    ...dot,
    template_id: template.id,
    name: template.name,
    damage_kind: template.damage_kind,
    physical_damage_type_id: template.damage_kind === "physical" ? template.physical_damage_type_id : null,
    damage_type_id: template.damage_kind === "magical" ? template.damage_type_id : null,
    magic_level: template.damage_kind === "magical" ? template.magic_level : null,
  };
}

/** Match old saved ability DoTs without changing their current damage/duration. */
export function findRegisteredDotTemplate(
  dot: AbilityDotEffect,
  templates: DotTemplateOption[],
): DotTemplateOption | undefined {
  if (dot.template_id) {
    return templates.find((template) => template.id === dot.template_id);
  }
  return templates.find((template) =>
    template.name.trim().toLocaleLowerCase() === dot.name.trim().toLocaleLowerCase()
    && template.damage_kind === dot.damage_kind
    && template.physical_damage_type_id === dot.physical_damage_type_id
    && template.damage_type_id === dot.damage_type_id
    && (template.magic_level ?? null) === (dot.magic_level ?? null)
  );
}

export function registerAbilityDotTemplates(
  dots: AbilityDotEffect[],
  templates: DotTemplateOption[],
): AbilityDotEffect[] {
  return dots.map((dot) => {
    const matched = findRegisteredDotTemplate(dot, templates);
    return matched ? applyRegisteredDotTemplate(dot, matched) : dot;
  });
}
