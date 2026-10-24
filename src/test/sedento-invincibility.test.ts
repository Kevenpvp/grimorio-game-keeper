import { describe, expect, it } from "vitest";
import { sedentoInvincibilityCooldown } from "@/lib/sedento-invincibility";

const battleId = "battle-123";

describe("contador interno da invencibilidade de Sedento por Sangue", () => {
  const state = {
    sedento_battle_id: battleId,
    sedento_invincibility_ready_turn: 17,
  };
  it("mostra os turnos individuais restantes, não a recarga de ligar/desligar", () => {
    expect(sedentoInvincibilityCooldown(state, battleId, 9)).toEqual({
      initialized: true, remaining: 8, currentTurn: 9, readyAt: 17,
    });
    expect(sedentoInvincibilityCooldown(state, battleId, 16).remaining).toBe(1);
    expect(sedentoInvincibilityCooldown(state, battleId, 17).remaining).toBe(0);
    expect(sedentoInvincibilityCooldown(state, battleId, 20).remaining).toBe(0);
  });
  it("não confunde o contador da batalha anterior com a atual", () => {
    expect(sedentoInvincibilityCooldown(state, "other-battle", 16)).toEqual({
      initialized: false, remaining: null, currentTurn: null, readyAt: null,
    });
  });
  it("mostra zero quando o efeito nunca iniciou cooldown", () => {
    expect(sedentoInvincibilityCooldown({
      sedento_battle_id: battleId,
      sedento_invincibility_ready_turn: 0,
    }, battleId, 3).remaining).toBe(0);
  });
  it("não inventa cooldown se ainda não leu o turno ou se faltam dados", () => {
    expect(sedentoInvincibilityCooldown(state, battleId, null).remaining).toBeNull();
    expect(sedentoInvincibilityCooldown({ sedento_battle_id: battleId }, battleId, 5).remaining).toBeNull();
    expect(sedentoInvincibilityCooldown({ sedento_battle_id: battleId, sedento_invincibility_ready_turn: "17" }, battleId, 5).remaining).toBeNull();
  });
});
