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
