import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type Character = Tables<"characters">;
export type AttributeDef = Tables<"attribute_definitions">;
export type CharacterAttr = Tables<"character_attributes">;

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    // Sharing this result between mounted components avoids repeating auth.getUser,
    // sync_my_role, profile and role queries on every remount. Auth events still
    // invalidate the query immediately in the root component.
    staleTime: 60_000,
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return null;
      await supabase.rpc("sync_my_role");
      const [{ data: roles }, { data: profile }] = await Promise.all([
        supabase.from("user_roles").select("role").eq("user_id", u.user.id),
        supabase.from("profiles").select("*").eq("id", u.user.id).maybeSingle(),
      ]);
      const isMaster = !!roles?.some((r) => r.role === "master");
      return { user: u.user, profile, isMaster };
    },
  });
}

export function useDefs() {
  return useQuery({
    queryKey: ["defs"],
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("attribute_definitions")
        .select("*")
        .order("sort_order");
      if (error) throw error;
      return data;
    },
  });
}

export function useCharacter(id: string | undefined) {
  return useQuery({
    queryKey: ["character", id],
    enabled: !!id,
    // On mobile the Realtime channel can disconnect when backgrounded. Always
    // reconcile the confirmed race/class/virtue after returning to the tab.
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    refetchInterval: 20000,
    queryFn: async () => {
      const [{ data: c, error }, { data: attrs, error: e2 }] = await Promise.all([
        supabase.from("characters").select("*").eq("id", id!).maybeSingle(),
        supabase.from("character_attributes").select("*").eq("character_id", id!),
      ]);
      if (error) throw error;
      if (e2) throw e2;
      return { character: c as Character | null, attrs: attrs ?? [] };
    },
  });
}

/** Live-sync a character sheet: refetch whenever the master changes it. */
export function useCharacterLive(id: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!id) return;
    const refresh = () => qc.invalidateQueries({ queryKey: ["character", id] });
    const channel = supabase
      .channel(`char-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "characters", filter: `id=eq.${id}` }, refresh)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "character_attributes", filter: `character_id=eq.${id}` },
        refresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "character_abilities", filter: `character_id=eq.${id}` },
        () => {
          qc.invalidateQueries({ queryKey: ["character-abilities", id] });
          qc.invalidateQueries({ queryKey: ["character-abilities-battle"] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "battle_effects", filter: `character_id=eq.${id}` },
        () => qc.invalidateQueries({ queryKey: ["character-active-effects", id] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, qc]);
}

/** One signed URL per photo path for 50 minutes, shared by all portraits.
 * Supabase URLs expire after 60 minutes, so cache them for less than that.
 * React Query deduplicates simultaneous requests for the same photograph.
 */
export function usePhotoUrl(path: string | null | undefined) {
  const { data } = useQuery<string | null>({
    queryKey: ["character-photo-url", path],
    enabled: !!path,
    staleTime: 50 * 60_000,
    gcTime: 55 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data: signed, error } = await supabase.storage
        .from("character-photos").createSignedUrl(path!, 3600);
      if (error) throw error;
      return signed?.signedUrl ?? null;
    },
  });
  return path ? data ?? null : null;
}

export const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));

/** Defense is allowed to be negative: negative values amplify received damage. */
export function clampNonDefenseAttribute(key: string, value: number): number {
  // Normalize negative zero from rounding a negative stat at 0% Corpo.
  if (value === 0) return 0;
  return key === "phys_def" || key === "mag_def" ? value : Math.max(0, value);
}

/** Display-only signed stat value. Combat still uses clampNonDefenseAttribute;
 * showing a penalty (e.g. -3 Força) must not change combat calculations. */
export function signedAttributeDisplayValue(
  character: Pick<Character, "body" | "sanity">,
  key: string,
  value: number,
): number {
  if (!Number.isFinite(value)) return 0;
  let condition = 100;
  if (key === "phys_def" || key === "speed" || key === "atk_speed") {
    condition = clampPct(character.body);
  } else if (key === "iq" || key === "mental") {
    condition = clampPct(character.sanity);
  }
  const displayed = condition === 100 ? value : Math.round(value * condition) / 100;
  return displayed === 0 ? 0 : displayed;
}

/** Calculated value from invested points, using the configurable rule on the definition. */
export function computeValue(def: AttributeDef, points: number) {
  return Math.round((Number(def.base_value) + points * Number(def.points_multiplier)) * 100) / 100;
}

/**
 * Apply Body/Sanity penalties to effective attributes without mutating invested points:
 * Body scales physical defense, speed and attack speed; Sanity scales IQ and mental strength.
 */
export function conditionAdjustedValue(
  character: Pick<Character, "body" | "sanity">,
  key: string,
  value: number,
) {
  let condition = 100;
  if (key === "phys_def" || key === "speed" || key === "atk_speed") {
    condition = clampPct(character.body);
  } else if (key === "iq" || key === "mental") {
    condition = clampPct(character.sanity);
  } else {
    return value;
  }
  if (condition === 100) return value;
  // Keep fractional values so a 1% condition loss translates to exactly 1% stat loss.
  return clampNonDefenseAttribute(key, Math.round(value * condition) / 100);
}

export type Race = Tables<"races">;
export type ClassTrait = Tables<"classes">;
export type Virtue = Tables<"virtues">;
export type RaceMods = Record<string, number>;

export function numberAllocation(value: unknown): RaceMods {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: RaceMods = {};
  for (const [key, raw] of Object.entries(value)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) result[key] = Math.floor(n);
  }
  return result;
}

export function physicalAttributePoints(
  character: Pick<Character, "race_physical_allocations" | "virtue_physical_allocations"> & Partial<Pick<Character, "class_physical_allocations">>,
  key: string,
) {
  return (numberAllocation(character.race_physical_allocations)[key] ?? 0)
    + (numberAllocation(character.virtue_physical_allocations)[key] ?? 0)
    + (numberAllocation(character.class_physical_allocations)[key] ?? 0);
}

/** Unspent bonuses already counted inside characters.available_points. */
export function unspentOriginPoints(character: Pick<Character,
  "race_points_granted" | "virtue_points_granted" | "class_points_granted" |
  "race_attribute_allocations" | "virtue_attribute_allocations" | "class_attribute_allocations"
>): number {
  return Math.max(0, (character.race_points_granted ?? 0) - allocationTotal(character.race_attribute_allocations))
    + Math.max(0, (character.virtue_points_granted ?? 0) - allocationTotal(character.virtue_attribute_allocations))
    + Math.max(0, (character.class_points_granted ?? 0) - allocationTotal(character.class_attribute_allocations));
}

/** Only the free points manually assigned by the master, excluding unspent
 * race, virtue and class pools. This is a view of the existing balance. */
export function masterExtraPoints(character: Pick<Character,
  "available_points" | "race_points_granted" | "virtue_points_granted" | "class_points_granted" |
  "race_attribute_allocations" | "virtue_attribute_allocations" | "class_attribute_allocations"
>): number {
  return Math.max(0, character.available_points - unspentOriginPoints(character));
}

export function allocationTotal(value: unknown) {
  return Object.values(numberAllocation(value)).reduce((sum, points) => sum + points, 0);
}
export type Trait = Race | Virtue | ClassTrait;

export function useRaces() {
  return useQuery({
    queryKey: ["races"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("races").select("*").order("name");
      if (error) throw error;
      return data;
    },
  });
}

export function useClasses() {
  return useQuery<ClassTrait[]>({
    queryKey: ["classes"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("classes").select("*").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function classMods(classTrait: ClassTrait | null | undefined): RaceMods {
  return traitMods(classTrait);
}

export function useVirtues() {
  return useQuery({
    queryKey: ["virtues"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("virtues").select("*").order("name");
      if (error) throw error;
      return data;
    },
  });
}

export function traitMods(trait: Trait | null | undefined): RaceMods {
  const m = trait?.modifiers;
  if (!m || typeof m !== "object" || Array.isArray(m)) return {};
  const out: RaceMods = {};
  for (const [k, v] of Object.entries(m)) {
    const n = Number(v);
    if (Number.isFinite(n) && n !== 0) out[k] = n;
  }
  return out;
}

export function raceMods(race: Race | null | undefined): RaceMods {
  return traitMods(race);
}

/** Race, virtue, and class each contribute their own attribute modifiers. */
export function useCharacterTraitMods(
  raceId: string | null | undefined,
  virtueId: string | null | undefined,
  classId?: string | null,
  customClassModifiers?: unknown,
) {
  const { data: races } = useRaces();
  const { data: virtues } = useVirtues();
  const { data: classes } = useClasses();
  const race = races?.find((r) => r.id === raceId) ?? null;
  const virtue = virtues?.find((v) => v.id === virtueId) ?? null;
  const classTrait = classes?.find((c) => c.id === classId) ?? null;
  const raceModifiers = traitMods(race);
  const getMechanics = (trait: { special_mechanics?: unknown } | null) => {
    const value = trait?.special_mechanics;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  };
  const raceMechanics = getMechanics(race);
  const classMechanics = getMechanics(classTrait);
  const blacklist = (mechanics: Record<string, unknown>) =>
    Array.isArray(mechanics.virtue_effect_blacklist)
      ? mechanics.virtue_effect_blacklist.filter((id): id is string => typeof id === "string")
      : [];
  const multiplier = (mechanics: Record<string, unknown>) => {
    if (mechanics.duplicate_virtue_effects !== true || (!!virtue?.id && blacklist(mechanics).includes(virtue.id))) return 1;
    return Math.max(1, Math.min(10, Number(mechanics.virtue_effect_multiplier) || 2));
  };
  const virtueMultiplier = multiplier(raceMechanics) * multiplier(classMechanics);
  const virtueModifiers: RaceMods = Object.fromEntries(
    Object.entries(traitMods(virtue)).map(([key, value]) => [key, value * virtueMultiplier]),
  );
  const classModifiers: RaceMods = { ...traitMods(classTrait) };
  for (const [key, value] of Object.entries(numberAllocation(customClassModifiers))) {
    classModifiers[key] = (classModifiers[key] ?? 0) + value;
  }
  const mods: RaceMods = { ...raceModifiers };
  for (const [key, value] of Object.entries(classModifiers)) {
    mods[key] = (mods[key] ?? 0) + value;
    if (mods[key] === 0) delete mods[key];
  }
  for (const [key, value] of Object.entries(virtueModifiers)) {
    mods[key] = (mods[key] ?? 0) + value;
    if (mods[key] === 0) delete mods[key];
  }
  return { race, virtue, classTrait, raceModifiers, classModifiers, virtueModifiers, mods, races: races ?? [], virtues: virtues ?? [], classes: classes ?? [] };
}

/** Legacy race-only helper retained for components that specifically need the race. */
export function useRaceMods(raceId: string | null | undefined) {
  const { data: races } = useRaces();
  const race = races?.find((r) => r.id === raceId) ?? null;
  return { race, mods: raceMods(race), races: races ?? [] };
}
