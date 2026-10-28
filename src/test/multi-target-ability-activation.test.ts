import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseActivationValueOverrides } from "@/lib/activation-effect-values";
import { parseAbilityEffects } from "@/lib/abilities";

const load = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const original = load("drizzle/migrations/197_multi_target_ability_activation.sql");
const fix = load("drizzle/migrations/198_multi_target_uuid_parse_fix.sql");
const panel = load("src/components/abilities/CharacterAbilities.tsx");
const picker = load("src/components/abilities/ActivationEffectValuesDialog.tsx");

describe("Ativar habilidades com vários destinatários", () => {
  it("abre a seleção ao ativar, mesmo sem valores modificáveis", () => {
    expect(panel).toContain("setActivationSetup({");
    expect(panel).toContain("initialTargetIds: ability.self_target_only ? [characterId] : []");
    expect(panel).toContain("recipients={activationSetup.ability.self_target_only");
    expect(panel).toContain("selectedTargetIds: string[]");
    expect(panel).not.toContain("Alvo da próxima habilidade");
    expect(picker).toContain("Ativar em ");
    expect(picker).toContain("Selecionar todos");
    expect(picker).toContain("Limpar seleção");
    expect(picker).toContain("selected.length === 0");
    expect(parseActivationValueOverrides(parseAbilityEffects([]), {})).toEqual({});
  });

  it("confirma a lista uma única vez e envia todos os destinatários ao servidor", () => {
    expect(panel).toContain("const actualTargetId = chosenTargets[0]");
    expect(panel).toContain("__activation_target_ids: chosenTargets");
    expect(panel).toContain("chosenTargets.map((id) => ({ target_id: id, hit: true, group_ids: [] }))");
    expect(panel).toContain("onConfirm={async (values, selectedIds)");
    expect(panel).toContain("await activate(activationSetup.ability, values, selectedIds)");
    expect(original).toContain("Selecione entre 1 e 25 destinatários");
    expect(original).toContain("Seleção contém destinatários repetidos");
    expect(original).toContain("Todos os destinatários precisam participar do mesmo combate");
    expect(original).toContain("O alvo principal deve ser o primeiro destinatário");
    expect(fix).toContain("(selected.value #>> ''{}'')::uuid");
  });

  it("preserva Caster / Alvo / Ambos e não duplica custo, cooldown ou invocações", () => {
    expect(original).toContain("_activation_target_id = _assignment.character_id");
    expect(original).toContain("_target_scope IN ('caster','both')");
    expect(original).toContain("_target_scope IN ('target','both')");
    expect(original).toContain("_activation_target_id = ANY(_effect_character_ids)");
    expect(original).toContain("array_append(_effect_character_ids,_activation_target_id)");
    expect(original).toContain("PERFORM public.begin_continuous_effects");
    expect(original).not.toContain("PERFORM public.activate_character_ability(");
  });

  it("só permite o próprio personagem quando a habilidade é exclusiva para si", () => {
    expect(picker).toContain("disabled={pending || selfOnly}");
    expect(picker).toContain("Esta habilidade só pode ser ativada no próprio personagem");
    expect(original).toContain("IF _assignment.self_target_only");
    expect(original).toContain("_activation_target_ids <> ARRAY[_assignment.character_id]");
  });
});
