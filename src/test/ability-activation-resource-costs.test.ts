import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseSustainedCosts, validateSustainedCosts, sustainedCostsSummary,
} from "@/components/abilities/SustainedCostsEditor";

const read=(path:string)=>readFileSync(resolve(process.cwd(),path),"utf8");
const editor=read("src/components/abilities/SustainedCostsEditor.tsx");
const catalog=read("src/routes/_authenticated/habilidades.tsx");
const character=read("src/components/abilities/CharacterAbilities.tsx");
const migration=read("drizzle/migrations/206_ability_activation_resource_costs.sql");

describe("Custos adicionais das habilidades — HP, Corpo e Sanidade",()=>{
  it("aceita HP fixo ou percentual e Corpo/Sanidade apenas em porcentagem",()=>{
    const parsed=parseSustainedCosts([
      {resource:"hp",mode:"percent",amount:12.5},
      {resource:"body",mode:"percent",amount:5},
      {resource:"sanity",mode:"percent",amount:7},
    ]);
    expect(validateSustainedCosts(parsed)).toBeNull();
    expect(sustainedCostsSummary(parsed)).toBe("12.5% HP · 5% Corpo · 7% Sanidade");
    expect(validateSustainedCosts([{resource:"body",mode:"fixed",amount:10}])).not.toBeNull();
    expect(validateSustainedCosts([{resource:"hp",mode:"fixed",amount:1.5}])).not.toBeNull();
    expect(validateSustainedCosts([{resource:"sanity",mode:"percent",amount:101}])).not.toBeNull();
    expect(validateSustainedCosts([{resource:"hp",mode:"fixed",amount:10},{resource:"hp",mode:"fixed",amount:10}])).not.toBeNull();
  });

  it("mostra um editor responsivo específico de utilização sem duplicar Mana",()=>{
    expect(editor).toContain('usage?: "turn" | "activation"');
    expect(editor).toContain('usage === "turn" || resource !== "mana"');
    expect(editor).toContain("Custos adicionais ao usar");
    expect(editor).toContain("Em ataques com múltiplos alvos, cobra apenas na primeira utilização");
    expect(editor).toContain("sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]");
  });

  it("é configurável no catálogo e nas habilidades individuais, inclusive vindas de acessórios e armas",()=>{
    expect(catalog).toContain('usage="activation" value={activationCosts} onChange={setActivationCosts}');
    expect(character).toContain('usage="activation" value={activationCosts} onChange={setActivationCosts}');
    expect(catalog).toContain("activation_costs: canActivate ? activationCosts : []");
    expect(character).toContain("activation_costs: canActivate ? activationCosts : []");
    expect(character).toContain("activation_costs: (ability as Ability & { activation_costs?: unknown }).activation_costs ?? []");
    expect(character).toContain("Custo adicional:");
    expect(character).toContain("source_inventory_item_id");
  });

  it("cobra dentro da mesma transação de Mana em Ativar e no primeiro Atacar",()=>{
    expect(migration).toContain("charge_ability_activation_costs_internal");
    expect(migration).toContain("activate_character_ability_attack");
    expect(migration).toContain("activate_character_ability");
    expect(migration).toContain("WHERE character_id=_caster_id AND attribute_key='hp'");
    expect(migration).toContain("public.calculate_character_resource_max(_caster_id,'hp')");
    expect(migration).toContain("CEIL(GREATEST(0,_maximum)*_amount/100)");
    expect(migration).toContain("UPDATE public.characters SET sanity=sanity-_drain");
    expect(migration).toContain("UPDATE public.characters SET body=body-_drain");
    expect(migration).not.toContain("repeat_character_ability_attack',");
    expect(migration).toContain("HP insuficiente para usar a habilidade");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.charge_ability_activation_costs_internal(uuid)");
  });

  it("sincroniza alterações do catálogo sem apagar custos personalizados das fichas",()=>{
    expect(migration).toContain("assign_catalog_activation_costs");
    expect(migration).toContain("sync_catalog_activation_costs");
    expect(migration).toContain("ca.activation_costs=OLD.activation_costs OR ca.activation_costs='[]'::jsonb");
  });
});
