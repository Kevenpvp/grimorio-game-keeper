import type { AbilityScript } from "../types.ts";

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
    await api.sincronizarBonusCoracaoCorrompido();
    api.registrarLog("Coração Corrompido ativado; bônus de Força sincronizado", {
      cooldown: "em andamento após ativação",
      motivo: "sincronização do superaquecimento do Demônio Interno",
    });
  },

  async "habilidade_saiu_do_cooldown"(context, api) {
    await api.sincronizarBonusCoracaoCorrompido();
    api.registrarLog("Coração Corrompido saiu do cooldown; bônus temporário removido", {
      habilidade: context.habilidade.nome,
    });
  },
};

export default coracaoCorrompido;
