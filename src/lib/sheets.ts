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
    queryFn: async () => {
      const [{ data: c, error }, { data: attrs, error: e2 }] = await Promise.all([
        supabase.from("characters").select("*").eq("id", id!).maybeSingle(),
        supabase.from("character_attributes").select("*").eq("character_id", id!),
      ]);
      if (error) throw error;
      if (e2) throw e2;
      return { character: c, attrs: attrs ?? [] };
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

export function usePhotoUrl(path: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!path) {
      setUrl(null);
      return;
    }
    supabase.storage
      .from("character-photos")
      .createSignedUrl(path, 3600)
      .then(({ data }) => alive && setUrl(data?.signedUrl ?? null));
    return () => {
      alive = false;
    };
  }, [path]);
  return url;
}

export const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));

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
  return Math.max(0, Math.round(value * condition) / 100);
}

export type Race = Tables<"races">;
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
  character: Pick<Character, "race_physical_allocations" | "virtue_physical_allocations">,
  key: string,
) {
  return (numberAllocation(character.race_physical_allocations)[key] ?? 0)
    + (numberAllocation(character.virtue_physical_allocations)[key] ?? 0);
}

export function allocationTotal(value: unknown) {
  return Object.values(numberAllocation(value)).reduce((sum, points) => sum + points, 0);
}
export type Trait = Race | Virtue;

export function useRaces() {
  return useQuery({
    queryKey: ["races"],
    queryFn: async () => {
      const { data, error } = await supabase.from("races").select("*").order("name");
      if (error) throw error;
      return data;
    },
  });
}

export function useVirtues() {
  return useQuery({
    queryKey: ["virtues"],
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

/** Both selected traits contribute to the character's attribute modifiers. */
export function useCharacterTraitMods(raceId: string | null | undefined, virtueId: string | null | undefined) {
  const { data: races } = useRaces();
  const { data: virtues } = useVirtues();
  const race = races?.find((r) => r.id === raceId) ?? null;
  const virtue = virtues?.find((v) => v.id === virtueId) ?? null;
  const raceModifiers = traitMods(race);
  const mechanics = (race as unknown as { special_mechanics?: { duplicate_virtue_effects?: boolean; virtue_effect_multiplier?: number } } | null)?.special_mechanics;
  const virtueMultiplier = mechanics?.duplicate_virtue_effects
    ? Math.max(1, Math.min(10, Number(mechanics.virtue_effect_multiplier) || 2))
    : 1;
  const virtueModifiers: RaceMods = Object.fromEntries(
    Object.entries(traitMods(virtue)).map(([key, value]) => [key, value * virtueMultiplier]),
  );
  const mods: RaceMods = { ...raceModifiers };
  for (const [key, value] of Object.entries(virtueModifiers)) {
    mods[key] = (mods[key] ?? 0) + value;
    if (mods[key] === 0) delete mods[key];
  }
  return { race, virtue, raceModifiers, virtueModifiers, mods, races: races ?? [], virtues: virtues ?? [] };
}

/** Legacy race-only helper retained for components that specifically need the race. */
export function useRaceMods(raceId: string | null | undefined) {
  const { data: races } = useRaces();
  const race = races?.find((r) => r.id === raceId) ?? null;
  return { race, mods: raceMods(race), races: races ?? [] };
}
