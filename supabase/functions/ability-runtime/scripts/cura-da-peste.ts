import type { AbilityScript } from "../types.ts";

/**
 * Cura da Peste — passiva exclusiva das Luvas da Peste.
 *
 * A cura não é disparada pelo evento genérico "causou_dano": ele não prova
 * qual arma realmente atingiu o alvo e permitiria usar esta passiva com
 * outras armas. O script autoritativo é executado atomicamente por
 * apply_peste_gloves_on_weapon_hit dentro de
 * apply_battle_damage_with_weapon_ammo, após aplicar o dano da luva.
 *
 * O servidor conserva os acúmulos em character_abilities.custom_state,
 * usa apply_ability_healing (Normal, baixa) para respeitar bloqueios,
 * máximo de HP e reversão, e reseta combos por turno/saída da batalha.
 */
const curaDaPeste: AbilityScript = {};
export default curaDaPeste;
