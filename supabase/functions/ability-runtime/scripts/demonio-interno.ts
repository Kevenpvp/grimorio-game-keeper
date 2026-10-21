import type { AbilityScript } from "../types.ts";

/**
 * Demonio Interno
 *
 * - received damage is accumulated as heat on the ability instance.
 * - on the next hit dealt, a configurable percentage of the stored heat is added
 *   as post-defense damage.
 * - reflecting heat costs a configurable percentage of the reflected damage in HP.
 * - spent heat is removed from the stack.
 */
const demonioInterno: AbilityScript = {
  async "recebeu_dano"(context, api) {
    const damageReceived = Math.max(0, Math.floor(context.dano?.danoFinalTotal ?? 0));
    if (damageReceived <= 0) return;

    const nextHeat = await api.ajustarEstadoNumerico({
      chave: "dano_superaquecimento",
      delta: damageReceived,
      minimo: 0,
    });
    api.registrarLog("Demônio Interno acumulou superaquecimento", {
      danoRecebido: damageReceived,
      superaquecimentoTotal: nextHeat,
    });
  },

  async "causou_dano"(context, api) {
    // Demonio Interno only reflects when its owner deals physical damage.
    // Non-physical attacks do not spend heat or pay the HP cost.
    if (context.dano?.categoria !== "physical") return;

    const storedHeat = Math.max(0, Number(context.estado.dano_superaquecimento ?? 0) || 0);
    const hitValues = context.dano?.danoFinalPorGolpe;
    if (storedHeat <= 0 || !context.alvo || !context.dano || !hitValues?.length) return;

    const maxReflectPercent = Math.min(100, Math.max(0,
      Number(context.atributos.porcentagem_maxima_dano_refletido ?? 50) || 0
    ));
    const hpCostPercent = Math.min(100, Math.max(0,
      Number(context.atributos.percentual_hp_perdido_por_refletir ?? 10) || 0
    ));

    const reflectedDamage = Math.floor(storedHeat * maxReflectPercent / 100);
    if (reflectedDamage <= 0) return;

    // This is appended after the normal defense and mitigation calculation, so it is true bonus damage.
    const updatedHitValues = [...hitValues];
    const lastHit = updatedHitValues.length - 1;
    const actualReflection = Math.min(reflectedDamage, Math.max(0, 1_000_000 - updatedHitValues[lastHit]));
    if (actualReflection <= 0) return;
    updatedHitValues[lastHit] += actualReflection;
    await api.modificarDanoFinal({ valoresPorGolpe: updatedHitValues });

    // The configured HP penalty is a percentage of the Caster's maximum HP.
    const casterHp = await api.consultarRecurso({ personagem: "caster", recurso: "hp" });
    const hpCost = Math.ceil(casterHp.maximo * hpCostPercent / 100);
    if (hpCost > 0) {
      await api.alterarRecurso({
        personagem: "caster",
        recurso: "hp",
        operacao: "subtrair",
        quantidade: hpCost,
      });
    }

    const remainingHeat = await api.ajustarEstadoNumerico({
      chave: "dano_superaquecimento",
      delta: -actualReflection,
      minimo: 0,
    });
    api.registrarLog("Demônio Interno refletiu superaquecimento como dano adicional", {
      danoRefletido: actualReflection,
      custoHp: hpCost,
      hpMaximoUsadoNoCalculo: casterHp.maximo,
      superaquecimentoRestante: remainingHeat,
    });
  },
};

export default demonioInterno;
