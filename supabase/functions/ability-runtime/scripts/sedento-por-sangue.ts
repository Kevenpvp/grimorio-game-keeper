import type { AbilityScript, AbilityScriptApi, AbilityScriptContext } from "../types.ts";

/**
 * Sedento por Sangue — habilidade sustentada.
 *
 * Atributos personalizados já cadastrados (nomes, não IDs):
 * - HpQuePerdePorTurno (10 HP)
 * - TurnoPraComeçarAPerderHp (4 turnos completos)
 * - HpAbaixoParaAtivar (10% do HP máximo)
 * - DuraçaoDeInvencibilidade (2 turnos)
 * - CooldowndaInvencibilidade (10 turnos)
 *
 * O runtime entrega cada atributo pela chave interna e também pelo nome
 * exibido no editor (necessário para habilidades antigas com "atributo_1").
 */

const stateKeys = {
  battle: "sedento_battle_id",
  started: "sedento_activated_turn",
  lastDrained: "sedento_last_drained_turn",
  nextInvincible: "sedento_invincibility_ready_turn",
} as const;

function normalize(name: string): string {
  return name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

function config(context: AbilityScriptContext, name: string, fallback: number, maximum: number): number {
  const match = Object.entries(context.atributos)
    .find(([key]) => normalize(key) === normalize(name));
  const value = Number(match?.[1] ?? fallback);
  return Number.isFinite(value) ? Math.floor(Math.max(0, Math.min(maximum, value))) : fallback;
}

function turnNumber(context: AbilityScriptContext): number | null {
  const turn = context.turno.individual;
  return typeof turn === "number" && Number.isFinite(turn)
    ? Math.max(0, Math.floor(turn)) : null;
}

function isRunning(context: AbilityScriptContext): boolean {
  return context.habilidade.ativa === true && context.batalha?.ativa === true &&
    Boolean(context.batalha?.id) && Boolean(context.habilidade.idNaFicha);
}

async function tryInvincibility(context: AbilityScriptContext, api: AbilityScriptApi) {
  if (!isRunning(context)) return;
  const now = turnNumber(context);
  if (now === null) return;
  if (context.estado[stateKeys.battle] !== context.batalha?.id) return;
  const readyAt = Number(context.estado[stateKeys.nextInvincible] ?? 0);
  if (Number.isFinite(readyAt) && now < readyAt) return;

  const hp = await api.consultarRecurso({ personagem: "caster", recurso: "hp" });
  const threshold = config(context, "HpAbaixoParaAtivar", 10, 100);
  if (hp.maximo <= 0 || hp.atual > hp.maximo * threshold / 100) return;

  const duration = Math.max(1, config(context, "DuraçaoDeInvencibilidade", 2, 1000));
  const cooldown = config(context, "CooldowndaInvencibilidade", 10, 10000);

  // Persist the cooldown before creating the effect to avoid double activations
  // from events emitted by the effect insertion itself.
  const nextAvailable = now + Math.max(1, duration, cooldown);
  await api.atualizarEstado({ [stateKeys.nextInvincible]: nextAvailable });

  await api.aplicarEfeito({
    personagem: "caster",
    efeito: {
      nome: "Sedento por Sangue — Invencibilidade",
      tipo: "invincible",
      duracao: duration,
      quantidade: 0,
      dados: {
        sedento_invencibilidade: true,
        sedento_ability_id: context.habilidade.idNaFicha,
        sedento_battle_id: context.batalha?.id,
      },
    },
  });
  api.registrarLog("Sedento por Sangue concedeu invencibilidade", {
    hpAtual: hp.atual,
    hpMaximo: hp.maximo,
    limitePercentual: threshold,
    duracaoTurnos: duration,
    recargaInternaTurnos: cooldown,
    proximaAtivacaoTurno: nextAvailable,
  });
}

const sedentoPorSangue: AbilityScript = {
  async "habilidade_ativada"(context, api) {
    if (!isRunning(context)) return;
    const now = turnNumber(context);
    if (now === null) {
      api.registrarLog("Sedento por Sangue: turno individual indisponível na ativação");
      return;
    }
    const sameBattle = context.estado[stateKeys.battle] === context.batalha?.id;
    await api.atualizarEstado({
      [stateKeys.battle]: context.batalha?.id,
      [stateKeys.started]: now,
      [stateKeys.lastDrained]: now,
      // O cooldown interno continua contando mesmo se a habilidade for
      // desligada e ligada novamente dentro do mesmo combate.
      [stateKeys.nextInvincible]: sameBattle
        ? Number(context.estado[stateKeys.nextInvincible] ?? now)
        : now,
    });
    api.registrarLog("Sedento por Sangue foi ligado", {
      turnoInicial: now,
      turnosAtePerderHP: config(context, "TurnoPraComeçarAPerderHp", 4, 10000),
    });
    await tryInvincibility(context, api);
  },

  async "turno_avançou"(context, api) {
    if (!isRunning(context)) return;
    const now = turnNumber(context);
    if (now === null || context.estado[stateKeys.battle] !== context.batalha?.id) return;
    const started = Number(context.estado[stateKeys.started]);
    const lastDrained = Number(context.estado[stateKeys.lastDrained]);
    const delay = config(context, "TurnoPraComeçarAPerderHp", 4, 10000);
    const hpLoss = config(context, "HpQuePerdePorTurno", 10, 1000000);

    // O turno de ativação não conta como um turno transcorrido. A primeira
    // perda acontece no quarto avanço individual, quando delay = 4.
    if (Number.isFinite(started) && now > started &&
      now - started >= delay && (!Number.isFinite(lastDrained) || now > lastDrained)) {
      if (hpLoss > 0) {
        await api.alterarRecurso({
          personagem: "caster", recurso: "hp", operacao: "subtrair", quantidade: hpLoss,
        });
      }
      await api.atualizarEstado({ [stateKeys.lastDrained]: now });
      api.registrarLog("Sedento por Sangue consumiu HP", {
        turnoAtual: now, turnosDesdeAtivacao: now - started, hpPerdido: hpLoss,
      });
    }
    // Reavalia quando o cooldown interno termina e o HP continua baixo.
    await tryInvincibility(context, api);
  },

  async "hp_alterado"(context, api) {
    // Detecta qualquer alteração de HP enquanto a habilidade estiver ligada,
    // inclusive ajustes manuais na ficha, dano, regeneração e custo de scripts.
    await tryInvincibility(context, api);
  },

  async "recebeu_dano"(context, api) {
    // Não espera o próximo turno se um ataque ou DoT colocou o personagem
    // em 10% ou menos de HP.
    await tryInvincibility(context, api);
  },
};

export default sedentoPorSangue;
