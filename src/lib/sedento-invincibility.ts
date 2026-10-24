/** Contador da invencibilidade do script Sedento por Sangue.
 * O estado guarda o turno INDIVIDUAL absoluto em que a proteção poderá disparar
 * novamente. Não confundir com o cooldown de ligar/desligar da habilidade.
 */
export type SedentoInvincibilityCooldown = {
  initialized: boolean;
  remaining: number | null;
  currentTurn: number | null;
  readyAt: number | null;
};

export function sedentoInvincibilityCooldown(
  state: unknown,
  battleId: string | null | undefined,
  individualTurn: number | null | undefined,
): SedentoInvincibilityCooldown {
  const empty: SedentoInvincibilityCooldown = {
    initialized: false, remaining: null, currentTurn: null, readyAt: null,
  };
  if (!battleId || !state || typeof state !== "object" || Array.isArray(state)) return empty;
  const saved = state as Record<string, unknown>;
  if (saved.sedento_battle_id !== battleId) return empty;

  const rawReady = saved.sedento_invincibility_ready_turn;
  const readyAt = typeof rawReady === "number" && Number.isFinite(rawReady) && rawReady >= 0
    ? Math.floor(rawReady)
    : null;
  const turn = typeof individualTurn === "number" && Number.isFinite(individualTurn) && individualTurn >= 0
    ? Math.floor(individualTurn)
    : null;

  return {
    initialized: true,
    readyAt,
    currentTurn: turn,
    remaining: readyAt !== null && turn !== null ? Math.max(0, readyAt - turn) : null,
  };
}
