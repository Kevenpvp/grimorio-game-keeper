import { describe, expect, it } from "vitest";
import sedentoPorSangue from "../../supabase/functions/ability-runtime/scripts/sedento-por-sangue.ts";
import type {
  AbilityScriptApi, AbilityScriptContext, AbilityScriptEventType,
} from "../../supabase/functions/ability-runtime/types.ts";

function harness(config: Record<string, number> = {}) {
  let hp = 100;
  let active = true;
  let turn = 0;
  const effects: Array<{ duracao: number; tipo: string }> = [];
  const drains: number[] = [];
  const state: Record<string, unknown> = {};
  const defaults = {
    HpQuePerdePorTurno: 10,
    TurnoPraComeçarAPerderHp: 4,
    HpAbaixoParaAtivar: 10,
    DuraçaoDeInvencibilidade: 2,
    CooldowndaInvencibilidade: 10,
  };
  const context = {
    idEvento: "test-event", evento: "habilidade_ativada",
    habilidade: { id: "a", idNaFicha: "ca", nome: "Sedento por Sangue", scriptKey: "sedento_por_sangue", ativa: true },
    caster: { id: "char", nome: "Teste" }, alvo: null,
    batalha: { id: "battle", nome: "Combate", turnoGeral: 0, ativa: true },
    turno: { individual: 0, geral: 0 },
    efeito: null, dados: {}, atributos: { ...defaults, ...config },
    estado: state, dano: null,
  } as AbilityScriptContext;
  const api = {
    registrarLog() {},
    async consultarRecurso() { return { atual: hp, maximo: 100 }; },
    async alterarRecurso(input: { quantidade: number }) {
      hp = Math.max(0, hp - input.quantidade);
      drains.push(input.quantidade);
    },
    async atualizarEstado(patch: Record<string, unknown>) {
      Object.assign(state, patch);
      context.estado = state;
    },
    async aplicarEfeito(input: { efeito: { duracao: number; tipo: string } }) {
      effects.push({ duracao: input.efeito.duracao, tipo: input.efeito.tipo });
      return "effect-id";
    },
  } as unknown as AbilityScriptApi;

  const run = async (event: AbilityScriptEventType) => {
    context.evento = event;
    context.habilidade.ativa = active;
    context.turno.individual = turn;
    const handler = sedentoPorSangue[event];
    if (handler) await handler(context, api);
  };
  return {
    run,
    setHp(value: number) { hp = value; },
    getHp() { return hp; },
    setActive(value: boolean) { active = value; },
    setTurn(value: number) { turn = value; },
    effects, drains, state,
  };
}

describe("Sedento por Sangue", () => {
  it("espera quatro turnos completos para descontar 10 HP por turno", async () => {
    const h = harness();
    await h.run("habilidade_ativada");
    for (let t = 1; t <= 3; t++) {
      h.setTurn(t);
      await h.run("turno_avançou");
    }
    expect(h.drains).toEqual([]);
    h.setTurn(4);
    await h.run("turno_avançou");
    expect(h.drains).toEqual([10]);
    await h.run("turno_avançou"); // Duplicate delivery must not charge twice.
    expect(h.drains).toEqual([10]);
    h.setTurn(5);
    await h.run("turno_avançou");
    expect(h.drains).toEqual([10, 10]);
    expect(h.getHp()).toBe(80);
  });

  it("aplica 2 turnos de invencibilidade abaixo de 10% e respeita cooldown 10", async () => {
    const h = harness({ TurnoPraComeçarAPerderHp: 100 });
    await h.run("habilidade_ativada");
    h.setTurn(2);
    h.setHp(10);
    await h.run("recebeu_dano");
    expect(h.effects).toEqual([{ duracao: 2, tipo: "invincible" }]);
    await h.run("recebeu_dano");
    expect(h.effects).toHaveLength(1);
    for (let t = 3; t <= 11; t++) {
      h.setTurn(t);
      await h.run("turno_avançou");
    }
    expect(h.effects).toHaveLength(1);
    h.setTurn(12);
    h.setHp(10);
    await h.run("turno_avançou");
    expect(h.effects).toHaveLength(2);
  });

  it("não aplica novos efeitos ou custos de HP enquanto desligada", async () => {
    const h = harness();
    await h.run("habilidade_ativada");
    h.setActive(false);
    h.setHp(9);
    h.setTurn(20);
    await h.run("turno_avançou");
    await h.run("recebeu_dano");
    expect(h.drains).toEqual([]);
    expect(h.effects).toEqual([]);
  });

  it("ativa invencibilidade ao reduzir HP diretamente na ficha, sem esperar turno", async () => {
    const h = harness();
    await h.run("habilidade_ativada");
    h.setHp(6);
    await h.run("hp_alterado");
    expect(h.effects).toEqual([{ duracao: 2, tipo: "invincible" }]);
    await h.run("hp_alterado");
    expect(h.effects).toHaveLength(1);
  });

  it("aplica o efeito ao chegar a zero HP por perda periódica sem restaurar vida", async () => {
    const h = harness({ HpQuePerdePorTurno: 100 });
    await h.run("habilidade_ativada");
    h.setTurn(4);
    await h.run("turno_avançou");
    expect(h.getHp()).toBe(0);
    expect(h.effects).toEqual([{ duracao: 2, tipo: "invincible" }]);
  });

  it("mantém a recarga interna após desligar e religar no mesmo combate", async () => {
    const h = harness();
    h.setHp(9);
    await h.run("habilidade_ativada");
    expect(h.effects).toHaveLength(1);
    h.setActive(false);
    h.setTurn(2);
    h.setActive(true);
    await h.run("habilidade_ativada");
    expect(h.effects).toHaveLength(1);
  });
});
