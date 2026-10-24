import type { AbilityEffectType } from "@/lib/abilities";

// Shared by race and class editors. Keep all non-healing effects available for
// trait-granted permanent effects, including Resistência a DoTs.
export const TRAIT_STARTING_EFFECT_TYPES: AbilityEffectType[] = [
  "status", "regeneration", "mana_regeneration", "mana_used",
  "no_regen_hp", "no_regen_mana", "magic_prohibition", "stun",
  "damage_dealt", "no_mana", "damage_reduction", "damage_received",
  "damage_vulnerability", "invincible", "healing_blocked",
  "magic_healing_reversal", "mental_control_immunity",
  "mental_control_chance", "mental_control_resistance",
  "dot_immunity", "dot_resistance", "invisibility",
];
