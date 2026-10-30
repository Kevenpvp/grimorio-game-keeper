import example from "./example.ts";
import demonioInterno from "./demonio-interno.ts";
import coracaoCorrompido from "./coracao-corrompido.ts";
import sedentoPorSangue from "./sedento-por-sangue.ts";
import barrincar from "./barrincar.ts";
import lagrimasPetalas from "./lagrimas-petalas.ts";
import explante from "./explante.ts";
import curaDaPeste from "./cura-da-peste.ts";
import type { AbilityScript } from "../types.ts";

/** Only these trusted repository files can execute in the server runtime. */
export const abilityScriptRegistry: Record<string, AbilityScript> = {
  example,
  demonio_interno: demonioInterno,
  coracao_corrompido: coracaoCorrompido,
  sedento_por_sangue: sedentoPorSangue,
  barrincar,
  lagrimas_petalas: lagrimasPetalas,
  explante,
  cura_da_peste: curaDaPeste,
};
