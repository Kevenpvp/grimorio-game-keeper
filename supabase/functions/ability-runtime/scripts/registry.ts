import example from "./example.ts";
import demonioInterno from "./demonio-interno.ts";
import type { AbilityScript } from "../types.ts";

/** Only these trusted repository files can execute in the server runtime. */
export const abilityScriptRegistry: Record<string, AbilityScript> = {
  example,
  demonio_interno: demonioInterno,
};
