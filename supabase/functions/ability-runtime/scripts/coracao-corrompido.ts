import type { AbilityScript, AbilityScriptContext, AbilityScriptApi } from "../types.ts";

function configuredStrengthBonus(context: AbilityScriptContext): number {
  const attribute = Object.entries(context.atributos).find(([key]) =>
    key.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "") === "forcabonus"
  )?.[1];
  const value = Number(attribute ?? 0);
  return Number.isFinite(value) ? Math.max(0, Math.min(1_000_000, value)) : 0;
}

async function synchronize(context: AbilityScriptContext, api: AbilityScriptApi) {
  const bonusForca = configuredStrengthBonus(context);
  await api.sincronizarBonusCoracaoCorrompido(bonusForca);
  api.registrarLog("Bônus temporário do Coração Corrompido sincronizado", {
    bonusForcaConfigurado: bonusForca,
    cooldownRestante: Number(context.dados.cooldown_atual ?? 0),
  });
}


/**
 * Coração Corrompido
 *
 * The database synchronization function is the single source of truth:
 * while this ability is in cooldown and Demônio Interno has heat > 0,
 * it adds exactly one temporary +20 Strength passive modifier.
 * Either condition becoming false removes that modifier.
 */
const coracaoCorrompido: AbilityScript = {
  async "habilidade_ativada"(context, api) {
    await synchronize(context, api);
    api.registrarLog("Coração Corrompido ativado", {
      motivo: "sincronização do superaquecimento do Demônio Interno",
    });
  },

  async "habilidade_saiu_do_cooldown"(context, api) {
    await synchronize(context, api);
    api.registrarLog("Coração Corrompido saiu do cooldown; bônus temporário sincronizado", {
      habilidade: context.habilidade.nome,
    });
  },
};

export default coracaoCorrompido;
