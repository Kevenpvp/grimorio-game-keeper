import type { AbilityScript } from "../types.ts";

/**
 * Lágrimas das pétalas — Relíquia - Espada Florin.
 * 
 * The action is intentionally bound to the weapon-damage execution rather than
 * the generic causou_dano hook: ordinary punches/skills must never consume
 * this pending Sangramento. The trusted SQL functions control_florin_petals
 * and consume_florin_weapon_bleed validate the equipped weapon, master role,
 * registered DoT, stacks, and one-shot consumption transactionally.
 *
 * Keeping this script registered associates the catalog ability and sheet
 * grant with the same trusted custom-script system as other abilities.
 */
const lagrimasPetalas: AbilityScript = {};
export default lagrimasPetalas;
