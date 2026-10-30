import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CUSTOM_ABILITY_SCRIPTS } from "@/lib/custom-ability-scripts";
import { abilityScriptRegistry } from "../../supabase/functions/ability-runtime/scripts/registry.ts";

const read = (path: string) => readFileSync(resolve(process.cwd(),path),"utf8");
const control = read("src/components/combat/FlorinPetalsControl.tsx");
const combat = read("src/routes/_authenticated/combate.tsx");
const damage = read("src/components/combat/DamageApplier.tsx");
const runtime = read("supabase/functions/ability-runtime/index.ts");
const migration = read("drizzle/migrations/205_florin_petals_bleed.sql");

describe("Lágrimas das pétalas: stacks na Espada Florin", () => {
  it("é uma habilidade personalizada vinculada à relíquia e não uma cópia solta", () => {
    expect(CUSTOM_ABILITY_SCRIPTS.some((script) => script.key === "lagrimas_petalas")).toBe(true);
    expect(abilityScriptRegistry.lagrimas_petalas).toBeDefined();
    expect(migration).toContain("UPDATE public.abilities");
    expect(migration).toContain("UPDATE public.character_abilities");
    expect(migration).toContain("4bc9cd81-b5ae-4b68-a3be-9d8a6f833e2c");
    expect(migration).toContain("4e37fe60-fe50-4467-9e2f-15872937face");
    expect(migration).toContain("a3d01c00-b493-4f7a-a647-b5eb37d540ec");
  });

  it("usa StacksMaximos da própria ficha, limita ajustes e só libera o DoT no gatilho", () => {
    expect(migration).toContain("x->>'name'='StacksMaximos'");
    expect(migration).toContain("LEAST(_max,GREATEST(0,_stacks+_value))");
    expect(migration).toContain("IF _stacks<_threshold THEN");
    expect(migration).toContain("IF _stacks<_threshold THEN RAISE EXCEPTION");
    expect(control).toContain("state.stacks>=state.max_stacks");
    expect(control).toContain('run("adjust",1)');
    expect(control).toContain('run("adjust",-1)');
    expect(control).toContain('run("threshold",Number(event.target.value))');
  });

  it("registra Sangramento existente com dano fixo ou percentual e duração escolhida", () => {
    expect(migration).toContain("d00bb7ef-65aa-4360-ac0c-e318d0a47080");
    expect(migration).toContain("public.apply_ability_dot_effect_internal");
    expect(migration).toContain("'florin_pending_bleed'");
    expect(control).toContain("Dano do Sangramento");
    expect(control).toContain("Duração do Sangramento");
    expect(control).toContain("Preparar Sangramento para o próximo ataque");
    expect(control).toContain('mode === "fixed" ? 1000000 : 1000');
  });

  it("o DoT é consumido apenas com a arma equipada, no próximo ataque que causar dano", () => {
    expect(migration).toContain("i.id=_inventory_item_id AND i.character_id=_source_character_id");
    expect(migration).toContain("i.equipped AND t.item_type='weapon'");
    expect(migration).toContain("_final_damage<=0");
    expect(migration).toContain("FOR UPDATE OF ca");
    expect(migration).toContain("SET custom_state=jsonb_set(_state,'{florin_pending_bleed}','null'::jsonb,true)");
    expect(runtime).toContain("if (weaponInventoryItemId && sourceId && battleId && tracker.total > 0");
    expect(runtime).toContain('"consume_florin_weapon_bleed"');
    expect(runtime).toContain("tracker.isInvincible !== true");
    expect(runtime).toContain("florin_bleed: florinBleed");
    expect(damage).toContain("Lágrimas das pétalas: Sangramento");
    expect(damage).toContain('qc.invalidateQueries({ queryKey: ["florin-petals", battleId] })');
  });

  it("mostra controles organizados no cartão de combate somente para o mestre", () => {
    expect(combat).toContain('enabled: isMaster && battle.active');
    expect(combat).toContain("list_florin_petals_battle");
    expect(combat).toContain("isMaster && florinPetals.filter");
    expect(combat).toContain("<FlorinPetalsControl");
    expect(control).toContain("min-h-11");
    expect(control).toContain("sm:grid-cols-2");
    expect(control).toContain("state.stacks} / {state.max_stacks} stacks");
    expect(control).toContain("Sem DoT preparado");
    expect(control).toContain("Cancelar Sangramento preparado");
    expect(control).toContain("setDamage(\"\"); setDuration(\"\"); setMode(\"fixed\")");
  });
});
