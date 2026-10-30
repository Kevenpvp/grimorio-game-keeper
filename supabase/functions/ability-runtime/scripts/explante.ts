import type { AbilityScript } from "../types.ts";

/**
 * Explante — the activation RPC already charges 10 HP as configured by the GM.
 *
 * Its successful 'habilidade_ativada' event adds the character's MuniçãoExtra
 * to the equipped ammunition-using weapon that granted this exact ability.
 * The trusted SQL RPC validates the originating inventory item, clamps to
 * the weapon's configured magazine maximum, and uses the event ID for
 * transaction-level idempotency. A non-weapon ability never generates ammo.
 */
const explante: AbilityScript = {
  async "habilidade_ativada"(context, api) {
    const attribute = context.atributos.MuniçãoExtra ?? context.atributos.atributo_1;
    const extraAmmo = Number(attribute);
    if (!Number.isFinite(extraAmmo) || !Number.isInteger(extraAmmo) || extraAmmo < 0 || extraAmmo > 100000) {
      throw new Error("Explante: configure MuniçãoExtra com um número inteiro entre 0 e 100000.");
    }

    const result = await api.recarregarArmaExplante(extraAmmo);
    if (!result.applied) {
      api.registrarLog("Explante não recuperou munição: a habilidade não está ligada a uma arma equipada com munição.", {
        motivo: result.reason,
        muniçãoConfigurada: extraAmmo,
      });
      return;
    }

    api.registrarLog("Explante carregou a arma vinculada com HP já cobrado na ativação.", {
      arma: result.weapon_name,
      muniçãoExtra: extraAmmo,
      adicionada: result.ammo_added,
      antes: result.ammo_before,
      depois: result.ammo_after,
      capacidade: result.ammo_max,
    });
  },
};

export default explante;
