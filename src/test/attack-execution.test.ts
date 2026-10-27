import { describe, expect, it } from "vitest";
import { parseAbilityAttackDamage } from "@/lib/abilities";
import { isAttackExecutionEligible } from "@/lib/attack-execution";

describe("Ataque da habilidade — executar alvo", () => {
  it("fica desligado por padrão para preservar habilidades antigas", () => {
    const config=parseAbilityAttackDamage({fixed_damage:0});
    expect(config.execute_enabled).toBe(false);
    expect(isAttackExecutionEligible(config,1,80)).toBe(false);
  });

  it("executa com 10% de HP máximo ou menos, sem arredondar o limite para cima", () => {
    const config=parseAbilityAttackDamage({execute_enabled:true,execute_mode:"percent",execute_threshold:10});
    expect(isAttackExecutionEligible(config,8,80)).toBe(true);
    expect(isAttackExecutionEligible(config,9,80)).toBe(false);
    expect(isAttackExecutionEligible(config,1,15)).toBe(true);
    expect(isAttackExecutionEligible(config,2,15)).toBe(false);
    expect(isAttackExecutionEligible(config,0,80)).toBe(false);
  });

  it("aceita limite fixo de HP e não executa quem estiver acima dele", () => {
    const config=parseAbilityAttackDamage({execute_enabled:true,execute_mode:"fixed",execute_threshold:12});
    expect(isAttackExecutionEligible(config,12,80)).toBe(true);
    expect(isAttackExecutionEligible(config,13,80)).toBe(false);
    expect(isAttackExecutionEligible(config,10,10000)).toBe(true);
  });

  it("limita percentuais inválidos e preserva ataque com dano zero", () => {
    const config=parseAbilityAttackDamage({execute_enabled:true,execute_mode:"percent",execute_threshold:500,fixed_damage:0});
    expect(config.execute_threshold).toBe(100);
    expect(config.fixed_damage).toBe(0);
    expect(isAttackExecutionEligible(config,50,100)).toBe(true);
  });

  it("não executa alvos com HP máximo inválido ou já mortos", () => {
    const config=parseAbilityAttackDamage({execute_enabled:true,execute_mode:"fixed",execute_threshold:100});
    expect(isAttackExecutionEligible(config,10,0)).toBe(false);
    expect(isAttackExecutionEligible(config,0,100)).toBe(false);
    expect(isAttackExecutionEligible(config,-1,100)).toBe(false);
  });
});