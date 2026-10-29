import type { AbilityScript, AbilityScriptApi, AbilityScriptContext } from "../types.ts";

/**
 * Barrincar (Roxy Mongrel)
 *
 * Each confirmed physical hit grants +5 percentage points to ALL physical
 * damage dealt in this battle (including the physical portion of hybrids).
 * The hit that created a stack never benefits from its own stack, because
 * "causou_dano" runs after the server computes/commits that hit.
 *
 * Advancing an individual turn immediately after a hit preserves the chain;
 * advancing another turn without another landed physical hit resets it.
 * Non-physical damage cannot create stacks or refresh their timer.
 */
const keys = {
  battle: "barrincar_battle_id",
  count: "barrincar_acumulos",
  lastHitTurn: "barrincar_ultimo_acerto_turno",
  effectId: "barrincar_efeito_id",
} as const;

export function barrincarTurnToReset(lastHit: number, nextTurn: number): boolean {
  return Number.isInteger(lastHit) && Number.isInteger(nextTurn) &&
    nextTurn > lastHit + 1;
}

function turn(context: AbilityScriptContext): number | null {
  const n = context.turno.individual;
  return typeof n === "number" && Number.isFinite(n)
    ? Math.max(0, Math.floor(n)) : null;
}

function activeBattle(context: AbilityScriptContext): string | null {
  return context.batalha?.ativa === true ? context.batalha.id : null;
}

async function reset(context: AbilityScriptContext, api: AbilityScriptApi) {
  const sameBattle = context.estado[keys.battle] === activeBattle(context);
  const oldEffectId = sameBattle && typeof context.estado[keys.effectId] === "string"
    ? context.estado[keys.effectId] as string : null;
  // Remove the old buff before clearing the stack; no phantom +damage survives.
  if (oldEffectId) await api.removerEfeito({ efeitoId: oldEffectId });
  await api.atualizarEstado({
    [keys.battle]: activeBattle(context),
    [keys.count]: 0,
    [keys.lastHitTurn]: null,
    [keys.effectId]: null,
  });
  api.registrarLog("Barrincar: combo encerrado; dano físico voltou ao normal");
}

const barrincar: AbilityScript = {
  async "causou_dano"(context, api) {
    const battleId = activeBattle(context);
    if (!battleId || !context.alvo || !context.habilidade.idNaFicha) return;
    const category = context.dano?.categoria;
    // Physical and hybrid strikes have a physical component; pure magic and
    // true damage do not extend this chain.
    if (category !== "physical" && category !== "hybrid") return;
    // The server fires this hook only for hit targets. A fully mitigated
    // strike still counts as a landed attack; a dodged strike does not.
    if (context.dano?.bloqueadoPorInvencivel === true) return;

    const currentTurn = turn(context);
    if (currentTurn === null) return;

    const sameBattle = context.estado[keys.battle] === battleId;
    const previousTurn = Number(context.estado[keys.lastHitTurn]);
    const stillInCombo = sameBattle && Number.isInteger(previousTurn) &&
      !barrincarTurnToReset(previousTurn, currentTurn);
    const previousStacks = stillInCombo
      ? Math.max(0, Math.floor(Number(context.estado[keys.count]) || 0)) : 0;
    const nextStacks = Math.min(20_000, previousStacks + 1);
    const oldEffectId = sameBattle && typeof context.estado[keys.effectId] === "string"
      ? context.estado[keys.effectId] as string : null;

    const newEffectId = await api.aplicarEfeito({
      personagem: "caster",
      efeito: {
        nome: "Barrincar — Dano físico +" + (nextStacks * 5) + "%",
        tipo: "damage_dealt",
        duracao: 10_000,
        polaridade: "buff",
        modoValor: "percent",
        quantidade: nextStacks * 5,
        escopoDano: "physical",
        dados: {
          barrincar: true,
          combo: nextStacks,
          source_ability_id: context.habilidade.idNaFicha,
        },
      },
    });
    await api.atualizarEstado({
      [keys.battle]: battleId,
      [keys.count]: nextStacks,
      [keys.lastHitTurn]: currentTurn,
      [keys.effectId]: newEffectId,
    });
    if (oldEffectId) await api.removerEfeito({ efeitoId: oldEffectId });
    api.registrarLog("Barrincar aumentou o dano físico", {
      acertosConsecutivos: nextStacks,
      bonusDanoFisicoPercentual: nextStacks * 5,
      alvo: context.alvo.id,
      turno: currentTurn,
    });
  },

  async "turno_avançou"(context, api) {
    const battleId = activeBattle(context);
    if (!battleId || context.estado[keys.battle] !== battleId) return;
    const stacks = Math.max(0, Number(context.estado[keys.count]) || 0);
    if (stacks <= 0) return;
    const currentTurn = turn(context);
    const lastHit = context.estado[keys.lastHitTurn];
    if (currentTurn === null || typeof lastHit !== "number") return;
    if (barrincarTurnToReset(lastHit, currentTurn)) await reset(context, api);
  },
};

export default barrincar;
