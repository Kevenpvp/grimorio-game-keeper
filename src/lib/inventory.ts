import { useQuery, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { parseAbilityEffects, type AbilityEffectDefinition } from "@/lib/abilities";

const db = supabase as any;

export type WeaponDamageKind = "physical" | "magical" | "hybrid" | "true";
export type WeaponDamageConfig = {
  damage_kind: WeaponDamageKind;
  bonus_mode: "fixed" | "percent";
  bonus_amount: number;
  physical_damage_type_id: string | null;
  damage_type_id: string | null;
  magic_level: "baixa" | "media" | "alta";
};
export const DEFAULT_WEAPON_DAMAGE: WeaponDamageConfig = {
  damage_kind: "physical",
  bonus_mode: "fixed",
  bonus_amount: 0,
  physical_damage_type_id: null,
  damage_type_id: null,
  magic_level: "baixa",
};
export function parseWeaponDamage(raw: unknown): WeaponDamageConfig {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  const amount = Number(source.bonus_amount ?? 0);
  const mode = source.bonus_mode === "percent" ? "percent" : "fixed";
  return {
    damage_kind: ["physical","magical","hybrid","true"].includes(String(source.damage_kind))
      ? source.damage_kind as WeaponDamageKind : "physical",
    bonus_mode: mode,
    bonus_amount: Number.isFinite(amount)
      ? Math.max(0, Math.min(mode === "percent" ? 1000 : 1_000_000, mode === "fixed" ? Math.floor(amount) : amount))
      : 0,
    physical_damage_type_id: typeof source.physical_damage_type_id === "string" && source.physical_damage_type_id
      ? source.physical_damage_type_id : null,
    damage_type_id: typeof source.damage_type_id === "string" && source.damage_type_id ? source.damage_type_id : null,
    magic_level: source.magic_level === "media" || source.magic_level === "alta" ? source.magic_level : "baixa",
  };
}

export function weaponDamageSummary(config: WeaponDamageConfig): string {
  const kind = {physical:"Físico",magical:"Mágico",hybrid:"Híbrido",true:"Verdadeiro"}[config.damage_kind];
  return `${kind} · +${config.bonus_amount}${config.bonus_mode === "percent" ? "%" : " fixo(s)"} por golpe`;
}

export type ItemTemplate = {
  id: string;
  name: string;
  description: string;
  item_type: "accessory" | "weapon";
  weapon_damage: WeaponDamageConfig;
  image_path: string | null;
  effects: AbilityEffectDefinition[];
  ability_ids: string[];
  transformation_ids: string[];
  summon_character_ids: string[];
  updated_at: string;
};

export type InventoryItem = {
  id: string;
  character_id: string;
  item_template_id: string;
  slot_index: number;
  equipped: boolean;
  item_templates: ItemTemplate;
};

export function accessoryPhoto(path: string | null | undefined): string | null {
  return path ? supabase.storage.from("item-images").getPublicUrl(path).data.publicUrl : null;
}

function normalizeTemplate(raw: any): ItemTemplate {
  return {
    ...raw,
    effects: parseAbilityEffects(raw.effects),
    item_type: raw.item_type === "weapon" ? "weapon" : "accessory",
    weapon_damage: parseWeaponDamage(raw.weapon_damage),
    ability_ids: Array.isArray(raw.ability_ids) ? raw.ability_ids : [],
    transformation_ids: Array.isArray(raw.transformation_ids) ? raw.transformation_ids : [],
    summon_character_ids: Array.isArray(raw.summon_character_ids) ? raw.summon_character_ids : [],
  } as ItemTemplate;
}

export function useItemTemplates(enabled = true) {
  return useQuery<ItemTemplate[]>({
    queryKey: ["inventory-templates"],
    enabled,
    queryFn: async () => {
      const { data, error } = await db.from("item_templates").select("*").order("name");
      if (error) throw error;
      return (data ?? []).map(normalizeTemplate);
    },
    refetchOnWindowFocus: true,
  });
}

export function useCharacterInventory(characterId: string) {
  return useQuery<{ slots: number; ownerId: string | null; items: InventoryItem[] }>({
    queryKey: ["inventory", characterId],
    enabled: !!characterId,
    refetchInterval: 8000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const [{ data: character, error: characterError }, { data, error }] = await Promise.all([
        db.from("characters").select("inventory_slots,owner_id").eq("id", characterId).single(),
        db.from("character_inventory").select("*,item_templates(*)").eq("character_id", characterId).order("slot_index"),
      ]);
      if (characterError) throw characterError;
      if (error) throw error;
      return {
        slots: Number(character?.inventory_slots ?? 10),
        ownerId: character?.owner_id ?? null,
        items: (data ?? []).filter((item: any) => item.item_templates)
          .map((item: any) => ({ ...item, item_templates: normalizeTemplate(item.item_templates) })),
      };
    },
  });
}

export function invalidateInventory(qc: QueryClient, characterId: string) {
  void Promise.all([
    qc.invalidateQueries({ queryKey: ["inventory", characterId] }),
    qc.invalidateQueries({ queryKey: ["inventory-templates"] }),
    qc.invalidateQueries({ queryKey: ["character", characterId] }),
    qc.invalidateQueries({ queryKey: ["character-abilities", characterId] }),
    qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
    qc.invalidateQueries({ queryKey: ["battle-character-transformations"] }),
    qc.invalidateQueries({ queryKey: ["character-transformations", characterId] }),
    qc.invalidateQueries({ queryKey: ["transformations"] }),
    qc.invalidateQueries({ queryKey: ["summon-grants"] }),
    qc.invalidateQueries({ queryKey: ["battle-effects"] }),
    qc.invalidateQueries({ queryKey: ["battles"] }),
  ]);
}

export function itemGrantSummary(template: Pick<ItemTemplate, "effects" | "ability_ids" | "transformation_ids" | "summon_character_ids"> & Partial<Pick<ItemTemplate,"item_type" | "weapon_damage">>) {
  return [
    template.item_type === "weapon" && template.weapon_damage ? weaponDamageSummary(template.weapon_damage) : "",
    template.effects.length ? template.effects.length + " efeito(s)" : "",
    template.ability_ids.length ? template.ability_ids.length + " habilidade(s)" : "",
    template.transformation_ids.length ? template.transformation_ids.length + " transformação(ões)" : "",
    template.summon_character_ids.length ? template.summon_character_ids.length + " invocação(ões)" : "",
  ].filter(Boolean).join(" · ") || "Sem benefícios configurados";
}
