import type { AbilityScript, AbilityScriptApi, AbilityScriptContext } from "../types.ts";

/**
 * Barrincar (Roxy Mongrel)
 *
 * Each confirmed physical hit grants +5 percentage points to ALL physical
 * damage dealt in this battle (including the physical portion of hybrids).
 * The hit that created a stack never benefits from its own stack, because
 * "causou_dano" runs after the server computes/commits that hit.
 *
 * The DB turns the hit flag off at each turn advancement. If the player
 * advances a turn without a new physical hit, the DB immediately removes
 * the entire buff, regardless of how many hits created the stack.
 */
const keys = {
  battle: "barrincar_battle_id",
  count: "barrincar_acumulos",
  lastHitTurn: "barrincar_ultimo_acerto_turno",
  hitThisTurn: "barrincar_acertou_desde_ultimo_avanco",
  effectId: "barrincar_efeito_id",
} as const;

function turn(context: AbilityScriptContext): number | null {
  const n = context.turno.individual;
  return typeof n === "number" && Number.isFinite(n)
    ? Math.max(0, Math.floor(n)) : null;
}

function activeBattle(context: AbilityScriptContext): string | null {
  return context.batalha?.ativa === true ? context.batalha.id : null;
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
    // The turn-advance DB trigger owns the reset. Several hits in one turn
    // only increase the stack; they never extend the number of turns it lasts.
    const previousStacks = sameBattle
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
      [keys.hitThisTurn]: true,
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

};

export default barrincar;
