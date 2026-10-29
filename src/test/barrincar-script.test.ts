import { describe, expect, it } from "vitest";
import barrincar from "../../supabase/functions/ability-runtime/scripts/barrincar.ts";
import { abilityScriptRegistry } from "../../supabase/functions/ability-runtime/scripts/registry.ts";
import { CUSTOM_ABILITY_SCRIPTS } from "@/lib/custom-ability-scripts";
import type {
  AbilityScriptApi, AbilityScriptContext, AbilityScriptEventType, ApplyScriptEffectInput,
} from "../../supabase/functions/ability-runtime/types.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function harness() {
  const state: Record<string, unknown> = {};
  const activeEffects = new Map<string, ApplyScriptEffectInput>();
  let effectSequence = 0;
  let currentTurn = 0;
  const context: AbilityScriptContext = {
    idEvento: "event-1", evento: "causou_dano",
    habilidade: { id:null, idNaFicha:"roxy-barrincar", nome:"Barrincar", scriptKey:"barrincar", ativa:false },
    caster: {id:"roxy",nome:"Roxy Mongrel"},
    alvo: {id:"target",nome:"Alvo"},
    batalha: {id:"battle-1",nome:"Combate",turnoGeral:0,ativa:true},
    turno: {individual:0,geral:0},
    efeito:null,dados:{},atributos:{},estado:state,
    dano: {
      origemId:"roxy",personagemAtingidoId:"target",categoria:"physical",
      tipoDanoId:null,grauMagia:null,danoBrutoPorGolpe:[100],
      danoFinalPorGolpe:[80],danoFinalTotal:80,hpAntes:200,hpDepois:120,
    },
  };
  const api: AbilityScriptApi = {
    registrarLog() {},
    async atualizarEstado(patch) { Object.assign(state,patch);context.estado={...state}; },
    async aplicarEfeito({efeito}) {const id="effect-"+ ++effectSequence;activeEffects.set(id,efeito);return id;},
    async removerEfeito({efeitoId}) {return activeEffects.delete(efeitoId);},
  } as AbilityScriptApi;

  async function trigger(event: AbilityScriptEventType) {
    context.evento=event;context.turno.individual=currentTurn;
    await barrincar[event]?.(context,api);
  }

  // Mirrors the DB trigger's boolean protocol; full transactional SQL coverage
  // also verifies the production turn-count trigger and DELETE of battle_effects.
  function advanceTurn() {
    currentTurn++;
    if (state.barrincar_battle_id !== context.batalha?.id) return;
    if (state.barrincar_acertou_desde_ultimo_avanco === true) {
      state.barrincar_acertou_desde_ultimo_avanco=false;
    } else {
      state.barrincar_acumulos=0;
      state.barrincar_efeito_id=null;
      state.barrincar_ultimo_acerto_turno=null;
      activeEffects.clear();
    }
    context.estado={...state};
  }

  return {
    state,activeEffects,context,trigger,advanceTurn,
    setTurn(turn:number) {currentTurn=turn;},
    setCategory(category:"physical"|"hybrid"|"magical"|"true") {context.dano!.categoria=category;},
    setBattle(id:string) {context.batalha!.id=id;},
    effect() {return [...activeEffects.values()][0];},
  };
}

describe("Barrincar: reset no primeiro turno sem acerto físico",() => {
  it("4 ataques físicos em um turno geram +20%, mas NÃO 4 turnos extras de tolerância",async() => {
    const h=harness();
    for(let i=0;i<4;i++) await h.trigger("causou_dano");
    expect(h.state.barrincar_acumulos).toBe(4);
    expect(h.effect().quantidade).toBe(20);
    expect(h.activeEffects.size).toBe(1);
    expect(h.state.barrincar_acertou_desde_ultimo_avanco).toBe(true);

    h.advanceTurn(); // attacked before this advance: preserve, clear hit marker
    expect(h.effect().quantidade).toBe(20);
    expect(h.state.barrincar_acertou_desde_ultimo_avanco).toBe(false);

    h.advanceTurn(); // 0 physical hits since last advance: erase everything NOW
    expect(h.activeEffects.size).toBe(0);
    expect(h.state.barrincar_acumulos).toBe(0);
  });

  it("se acerta novamente no turno seguinte, o combo continua, mas precisa renovar a cada turno",async() => {
    const h=harness();
    await h.trigger("causou_dano");
    h.advanceTurn();
    expect(h.effect().quantidade).toBe(5);
    await h.trigger("causou_dano");
    expect(h.effect().quantidade).toBe(10);
    h.advanceTurn();
    expect(h.effect().quantidade).toBe(10);
    h.advanceTurn();
    expect(h.activeEffects.size).toBe(0);
    await h.trigger("causou_dano");
    expect(h.effect().quantidade).toBe(5);
  });

  it("acertos mágicos e verdadeiros não contam como renovação física; híbridos contam",async() => {
    const h=harness();
    h.setCategory("physical");await h.trigger("causou_dano");
    h.advanceTurn();
    h.setCategory("magical");await h.trigger("causou_dano");
    h.setCategory("true");await h.trigger("causou_dano");
    expect(h.state.barrincar_acertou_desde_ultimo_avanco).toBe(false);
    h.advanceTurn();
    expect(h.activeEffects.size).toBe(0);

    h.setCategory("hybrid");await h.trigger("causou_dano");
    expect(h.effect()).toMatchObject({tipo:"damage_dealt",quantidade:5,modoValor:"percent",escopoDano:"physical"});
  });

  it("um acerto físico mitigado a zero conta; invencibilidade não cria acúmulos",async() => {
    const h=harness();
    h.context.dano!.danoFinalTotal=0;
    h.context.dano!.danoFinalPorGolpe=[0];
    await h.trigger("causou_dano");
    expect(h.effect().quantidade).toBe(5);
    h.context.dano!.bloqueadoPorInvencivel=true;
    await h.trigger("causou_dano");
    expect(h.effect().quantidade).toBe(5);
  });

  it("não carrega o combo de uma batalha para outra nem usa o handler assíncrono antigo",async() => {
    const h=harness();
    await h.trigger("causou_dano");
    h.setBattle("battle-2");
    await h.trigger("causou_dano");
    expect(h.state.barrincar_acumulos).toBe(1);
    expect(h.state.barrincar_battle_id).toBe("battle-2");
    expect(barrincar["turno_avançou"]).toBeUndefined();
  });

  it("usa o efeito físico registrado e delega o reset síncrono ao trigger do banco",() => {
    expect(abilityScriptRegistry.barrincar).toBe(barrincar);
    expect(CUSTOM_ABILITY_SCRIPTS.some(s=>s.key==="barrincar")).toBe(true);
    const migration=readFileSync(resolve(process.cwd(),"drizzle/migrations/203_barrincar_turn_window_reset.sql"),"utf8");
    expect(migration).toContain("BEFORE UPDATE OF turn_count ON public.battle_participants");
    expect(migration).toContain("'barrincar_acertou_desde_ultimo_avanco'");
    expect(migration).toContain("DELETE FROM public.battle_effects");
    expect(migration).toContain("barrincar_acumulos', 0");
  });
});
