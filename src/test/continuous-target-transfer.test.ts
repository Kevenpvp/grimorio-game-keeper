import { describe, expect, it } from "vitest";
import { defaultContinuousRule, type ContinuousInstance, type ContinuousRule } from "@/lib/continuous-effects";
import { planContinuousTargetTransfer, validateTransferSelection } from "@/lib/continuous-target-transfer";

const rule=(on_limit:ContinuousRule["on_limit"],max_targets:number):ContinuousRule=>({
  ...defaultContinuousRule(),name:"Desgraça Física",max_targets,on_limit,
});
const held=(id:string,target_character_id:string,rule_index=0):ContinuousInstance=>({
  id,battle_id:"battle",character_ability_id:"skill",caster_character_id:"caster",
  target_character_id,rule_index,active:true,ticks:4,
  name:"Fraquejando",rule:rule("choose",1),
});
describe("transferência de vínculo ao atacar",()=>{
  it("não libera quando a mesma vítima recebe um novo golpe",()=>{
    const plan=planContinuousTargetTransfer([rule("choose",1)],[held("old","A")],["A"]);
    expect(plan.requirements).toHaveLength(0);
    expect(plan.error).toBeNull();
  });
  it("oferece a vítima anterior para trocar por um novo alvo, sem soltar antes da confirmação",()=>{
    const old=held("old","A");
    const plan=planContinuousTargetTransfer([rule("choose",1)],[old],["B"]);
    expect(plan.requirements[0].needed).toBe(1);
    expect(plan.requirements[0].available.map(x=>x.id)).toEqual(["old"]);
    expect(validateTransferSelection(plan.requirements,["old"])).toBe(true);
    expect(validateTransferSelection(plan.requirements,[])).toBe(false);
    expect(validateTransferSelection(plan.requirements,["old","old"])).toBe(false);
    expect(old.active).toBe(true); // planning never mutates battle state
  });
  it("não deixa atacar dois novos alvos quando o limite é um",()=>{
    const plan=planContinuousTargetTransfer([rule("choose",1)],[held("old","A")],["B","C"]);
    expect(plan.error).toMatch(/até 1/);
    expect(plan.requirements).toHaveLength(0);
  });
  it("mostra bloqueio e não abre seletor quando o modo é bloquear",()=>{
    const plan=planContinuousTargetTransfer([rule("block",1)],[held("old","A")],["B"]);
    expect(plan.error).toMatch(/Solte um alvo/);
  });
  it("deixa o servidor liberar o mais antigo no modo automático",()=>{
    const plan=planContinuousTargetTransfer([rule("replace_oldest",1)],[held("old","A")],["B"]);
    expect(plan.requirements).toHaveLength(0);
    expect(plan.error).toBeNull();
  });
  it("respeita regras independentes para dois alvos e exige a quantidade exata de liberações",()=>{
    const plan=planContinuousTargetTransfer([rule("choose",2)],[
      held("A1","A"),held("A2","B"),
    ],["C"]);
    expect(plan.requirements[0].needed).toBe(1);
    expect(validateTransferSelection(plan.requirements,["A2"])).toBe(true);
    expect(validateTransferSelection(plan.requirements,["A1","A2"])).toBe(false);
  });
});