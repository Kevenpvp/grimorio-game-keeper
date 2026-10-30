import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_WEAPON_DAMAGE, parseWeaponDamage, weaponDamageSummary, itemGrantSummary,
} from "@/lib/inventory";

const read = (name: string) => readFileSync(resolve(process.cwd(), name), "utf8");
const catalog = read("src/routes/_authenticated/itens.tsx");
const inventory = read("src/components/inventory/InventoryPanel.tsx");
const damage = read("src/components/combat/DamageApplier.tsx");
const runtime = read("supabase/functions/ability-runtime/index.ts");
const sql = read("drizzle/migrations/204_weapon_items_and_damage.sql");

describe("Armas e acessórios no catálogo", () => {
  it("mantém acessórios existentes e cria categoria Armas com as mesmas concessões", () => {
    expect(catalog).toContain('create("weapon")');
    expect(catalog).toContain('create("accessory")');
    expect(catalog).toContain('type === "weapon" ? "Armas" : "Acessórios"');
    expect(catalog).toContain('item_type: type');
    expect(catalog).toContain("GrantedResources title=\"Habilidades concedidas\"");
    expect(catalog).toContain("GrantedResources title=\"Transformações concedidas\"");
    expect(catalog).toContain("GrantedResources title=\"Invocações concedidas\"");
    expect(catalog).toContain("<AbilityEffectsEditor");
    expect(inventory).toContain("Selecionar acessório ou arma cadastrada");
    expect(inventory).toContain("Equipamentos ativos");
  });

  it("configura tipos físico, mágico, híbrido e verdadeiro, com porcentagem ou dano fixo", () => {
    expect(catalog).toContain('Categoria de dano da arma');
    expect(catalog).toContain('Modo de bônus da arma');
    expect(catalog).toContain('Tipo de dano físico');
    expect(catalog).toContain('Tipo de dano mágico');
    expect(catalog).toContain('Grau da magia');
    expect(catalog).toContain('weapon_damage: weaponDamage');
    const parsed = parseWeaponDamage({
      damage_kind:"hybrid",bonus_mode:"percent",bonus_amount:35.5,
      damage_type_id:"magic-id",physical_damage_type_id:"physical-id",magic_level:"alta",
    });
    expect(parsed).toEqual({
      damage_kind:"hybrid",bonus_mode:"percent",bonus_amount:35.5,
      damage_type_id:"magic-id",physical_damage_type_id:"physical-id",magic_level:"alta",
    });
    expect(weaponDamageSummary(parsed)).toContain("Híbrido · +35.5%");
    expect(parseWeaponDamage({damage_kind:"true",bonus_mode:"fixed",bonus_amount:12.8}).bonus_amount).toBe(12);
    expect(parseWeaponDamage({damage_kind:"hybrid",bonus_mode:"percent",bonus_amount:-5}).bonus_amount).toBe(0);
    expect(DEFAULT_WEAPON_DAMAGE.damage_kind).toBe("physical");
  });

  it("mostra o dano e mantém os outros benefícios no inventário", () => {
    const text = itemGrantSummary({
      item_type:"weapon",
      weapon_damage:{...DEFAULT_WEAPON_DAMAGE,bonus_amount:20},
      effects:[{ name:"Armadura",effect_type:"status",attribute_key:"phys_def",amount:10,
        duration:1,polarity:"buff",value_mode:"fixed" }],
      ability_ids:["ability"],
      transformation_ids:[],
      summon_character_ids:["summon"],
    });
    expect(text).toContain("Físico · +20 fixo(s)");
    expect(text).toContain("1 efeito(s)");
    expect(text).toContain("1 habilidade(s)");
    expect(text).toContain("1 invocação(ões)");
    expect(inventory).toContain('selected.item_templates.item_type === "weapon"');
    expect(inventory).toContain("weaponDamageSummary(selected.item_templates.weapon_damage)");
  });
});

describe("Aplicar dano em com arma equipada", () => {
  it("todos os locais que usam DamageApplier recebem seleção de arma do atacante", () => {
    expect(damage).toContain("Arma utilizada no ataque (opcional)");
    expect(damage).toContain('queryKey: ["equipped-weapons-for-damage", sourceId]');
    expect(damage).toContain('.eq("character_id", sourceId!).eq("equipped", true)');
    expect(damage).toContain('template?.item_type === "weapon"');
    expect(damage).toContain('onChange={(e) => { setSourceCharacterId(e.target.value); setWeaponInventoryItemId(""); }}');
    expect(damage).toContain("_weapon_inventory_item_id: selectedWeapon?.id ?? null");
    expect(damage).toContain("weaponSummary");
  });

  it("server sempre lê configuração cadastrada e valida arma equipada do dono", () => {
    expect(runtime).toContain('userClient.rpc(\n      "prepare_equipped_weapon_damage"');
    expect(runtime).toContain('_inventory_item_id: weaponInventoryItemId');
    expect(runtime).toContain('rawValues = updatedValues.map');
    expect(runtime.indexOf('prepare_equipped_weapon_damage')).toBeLessThan(runtime.indexOf('// A critical multiplies each RAW hit'));
    expect(sql).toContain('t.item_type=\'weapon\'');
    expect(sql).toContain('i.character_id=_source_character_id');
    expect(sql).toContain('i.equipped=true');
    expect(sql).toContain('bp.character_id=_source_character_id');
    expect(sql).toContain("public.has_role(auth.uid(),'master')");
    expect(sql).toContain('jsonb_array_length(_damage_values) NOT BETWEEN 1 AND 200');
    expect(sql).toContain('_adjusted>1000000');
    expect(sql).toContain("dt.category='magical'");
  });

  it("aplica dano antes da defesa, sem modificar outras rotas de dano sem arma", () => {
    expect(runtime).toContain("if (weaponInventoryItemId) {");
    expect(runtime).toContain("const calculatedRawValues = critical ? rawValues.map");
    expect(runtime).toContain('userClient.rpc("apply_battle_damage"');
    expect(runtime).toContain('weapon_name: weaponInfo.weapon_name');
    expect(sql).toContain("CASE WHEN _mode='percent'");
    expect(sql).toContain("ELSE _amount END");
    expect(sql).toContain('damage_kind');
    expect(sql).toContain('damage_type_id');
    expect(sql).toContain('physical_damage_type_id');
    expect(sql).toContain('magic_level');
  });
});
