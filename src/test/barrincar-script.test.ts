import { describe, expect, it } from "vitest";
import barrincar, { barrincarTurnToReset } from "../../supabase/functions/ability-runtime/scripts/barrincar.ts";
import { abilityScriptRegistry } from "../../supabase/functions/ability-runtime/scripts/registry.ts";
import { CUSTOM_ABILITY_SCRIPTS } from "@/lib/custom-ability-scripts";
import type { AbilityScriptApi, AbilityScriptContext, AbilityScriptEventType, ApplyScriptEffectInput } from "../../supabase/functions/ability-runtime/types.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function harness() {
  const state: Record<string, unknown> = {};
  const activeEffects = new Map<string, ApplyScriptEffectInput>();
  const logs: string[] = [];
  let effectSequence = 0;
  let currentTurn = 0;
  const context: AbilityScriptContext = {
    idEvento:"event-1",
    evento:"causou_dano",
    habilidade:{ id:null, idNaFicha:"roxy-barrincar", nome:"Barrincar",scriptKey:"barrincar",ativa:false },
    caster:{id:"roxy",nome:"Roxy Mongrel"},
    alvo:{id:"target",nome:"Alvo"},
    batalha:{id:"battle-1",nome:"Combate",turnoGeral:0,ativa:true},
    turno:{individual:0,geral:0},
    efeito:null,dados:{},atributos:{},estado:state,
    dano:{
      origemId:"roxy",personagemAtingidoId:"target",categoria:"physical",
      tipoDanoId:null,grauMagia:null,danoBrutoPorGolpe:[100],
      danoFinalPorGolpe:[80],danoFinalTotal:80,hpAntes:200,hpDepois:120,
    },
  };
  const api:AbilityScriptApi={
    registrarLog(message){logs.push(message);},
    async atualizarEstado(patch){Object.assign(state,patch);context.estado={...state};},
    async aplicarEfeito({efeito}){const id="effect-"+ ++effectSequence;activeEffects.set(id,efeito);return id;},
    async removerEfeito({efeitoId}){return activeEffects.delete(efeitoId);},
  } as AbilityScriptApi;
  async function trigger(event:AbilityScriptEventType) {
    context.evento=event;
    context.turno.individual=currentTurn;
    await barrincar[event]?.(context,api);
  }
  return {
    state,activeEffects,logs,context,trigger,
    setTurn(turn:number){currentTurn=turn;},
    setCategory(category:"physical"|"hybrid"|"magical"|"true"){context.dano!.categoria=category;},
    setBattle(id:string){context.batalha!.id=id;},
    effect(){return [...activeEffects.values()][0];},
  };
}

describe("Barrincar: acúmulos de dano físico",()=>{
  it("ganha +5% por ataque físico acertado, usando efeito de dano causado físico",async()=>{
    const h=harness();
    await h.trigger("causou_dano");
    expect(h.state.barrincar_acumulos).toBe(1);
    expect(h.effect()).toMatchObject({tipo:"damage_dealt",quantidade:5,modoValor:"percent",escopoDano:"physical",polaridade:"buff"});
    await h.trigger("causou_dano");
    expect(h.state.barrincar_acumulos).toBe(2);
    expect(h.effect().quantidade).toBe(10);
    expect(h.activeEffects.size).toBe(1);
  });
  it("o próximo avanço após um acerto conserva o bônus; um avanço sem novo acerto zera",async()=>{
    const h=harness();
    h.setTurn(0);await h.trigger("causou_dano");
    h.setTurn(1);await h.trigger("turno_avançou");
    expect(h.effect().quantidade).toBe(5);
    h.setTurn(2);await h.trigger("turno_avançou");
    expect(h.state.barrincar_acumulos).toBe(0);
    expect(h.activeEffects.size).toBe(0);
    expect(barrincarTurnToReset(0,1)).toBe(false);
    expect(barrincarTurnToReset(0,2)).toBe(true);
  });
  it("cada novo acerto físico dentro do turno mantém a sequência",async()=>{
    const h=harness();
    await h.trigger("causou_dano");
    h.setTurn(1);await h.trigger("turno_avançou");
    await h.trigger("causou_dano");
    expect(h.effect().quantidade).toBe(10);
    h.setTurn(2);await h.trigger("turno_avançou");
    expect(h.effect().quantidade).toBe(10);
    h.setTurn(3);await h.trigger("turno_avançou");
    expect(h.activeEffects.size).toBe(0);
  });
  it("dano mágico ou verdadeiro não aumenta nem renova; híbrido aumenta a parte física",async()=>{
    const h=harness();
    h.setCategory("physical");await h.trigger("causou_dano");
    h.setCategory("magical");await h.trigger("causou_dano");
    h.setCategory("true");await h.trigger("causou_dano");
    expect(h.effect().quantidade).toBe(5);
    h.setCategory("hybrid");await h.trigger("causou_dano");
    expect(h.effect().quantidade).toBe(10);
  });
  it("um ataque acertado com dano 0 após mitigação ainda conta; invencibilidade não conta",async()=>{
    const h=harness();
    h.context.dano!.danoFinalTotal=0;
    h.context.dano!.danoFinalPorGolpe=[0];
    await h.trigger("causou_dano");
    expect(h.effect().quantidade).toBe(5);
    h.context.dano!.bloqueadoPorInvencivel=true;
    await h.trigger("causou_dano");
    expect(h.effect().quantidade).toBe(5);
  });
  it("não transfere acúmulos para outra batalha",async()=>{
    const h=harness();
    await h.trigger("causou_dano");
    h.setBattle("battle-2");
    await h.trigger("causou_dano");
    expect(h.state.barrincar_acumulos).toBe(1);
    expect(h.state.barrincar_battle_id).toBe("battle-2");
  });
  it("está disponível no registro do runtime e na configuração da habilidade na ficha",()=>{
    expect(abilityScriptRegistry.barrincar).toBe(barrincar);
    expect(CUSTOM_ABILITY_SCRIPTS.some(s=>s.key==="barrincar")).toBe(true);
    const migration=readFileSync(resolve(process.cwd(),"drizzle/migrations/202_barrincar_physical_combo.sql"),"utf8");
    expect(migration).toContain("53070a71-0106-4113-b5d4-361c4509b88b");
    expect(migration).toContain("b6a04ab2-5d69-4ef1-a313-3471c612bc6c");
    expect(migration).toContain("can_activate=false");
    expect(migration).toContain("custom_script_key='barrincar'");
  });
});
