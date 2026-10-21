import type { AbilityScript } from "../types.ts";

/**
 * Example script that logs the four hook types without changing game state.
 * Copy this file to create a new script, then register its key in registry.ts
 * and src/lib/custom-ability-scripts.ts.
 */
const exampleAbilityScript: AbilityScript = {
  async "turno_avançou"(context, api) {
    api.registrarLog(`Turno individual avançou para ${context.caster.nome}`, {
      turno: context.turno.individual,
      batalha: context.batalha?.nome ?? null,
    });
  },

  async "habilidade_ativada"(context, api) {
    api.registrarLog(`${context.habilidade.nome} foi ativada`, {
      caster: context.caster.id,
      alvo: context.alvo?.id ?? null,
      dados: context.dados,
    });
  },

  async "efeito_aplicado_no_caster"(context, api) {
    api.registrarLog(`Efeito aplicado em ${context.caster.nome}`, {
      efeito: context.efeito?.name ?? null,
      origem: context.dados.effect_source_character_ability_id ?? null,
    });
  },

  async "efeito_removido_no_caster"(context, api) {
    api.registrarLog(`Efeito removido de ${context.caster.nome}`, {
      efeito: context.efeito?.name ?? null,
    });
  },
};

export default exampleAbilityScript;
