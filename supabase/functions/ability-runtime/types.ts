export type AbilityScriptEventType =
  | "turno_avançou"
  | "habilidade_ativada"
  | "efeito_aplicado_no_caster"
  | "efeito_removido_no_caster"
  | "habilidade_saiu_do_cooldown"
  | "recebeu_dano"
  | "causou_dano";

export type ScriptTarget = "caster" | "alvo";
export type ScriptResource = "hp" | "mana" | "corpo" | "sanidade";
export type ResourceOperation = "somar" | "subtrair" | "definir";

export interface ScriptCharacter {
  id: string;
  nome: string;
  nomeJogador?: string | null;
}

export interface AbilityDamageContext {
  origemId: string | null;
  personagemAtingidoId: string;
  categoria: "physical" | "magical" | "hybrid" | "true";
  tipoDanoId: string | null;
  grauMagia: "baixa" | "media" | "alta" | null;
  /** True when the damage application was configured as a critical hit. */
  critico?: boolean;
  danoBrutoPorGolpe: number[];
  danoFinalPorGolpe: number[];
  danoFinalTotal: number;
  hpAntes: number;
  hpDepois: number;
}

export interface AbilityScriptContext {
  /** Stable id useful for logs and idempotent custom logic. */
  idEvento: string;
  evento: AbilityScriptEventType;
  habilidade: {
    id: string | null;
    idNaFicha: string | null;
    nome: string;
    scriptKey: string;
  };
  caster: ScriptCharacter;
  /** Target selected during activation or opposite side of a damage event. */
  alvo: ScriptCharacter | null;
  batalha: { id: string; nome: string; turnoGeral: number; ativa: boolean } | null;
  turno: { individual: number | null; geral: number | null };
  efeito: Record<string, unknown> | null;
  dados: Record<string, unknown>;
  /** Typed configuration values set by the GM on the ability definition. */
  atributos: Record<string, number | string | boolean>;
  /** Mutable per-character-ability state persisted between events. */
  estado: Record<string, unknown>;
  /** Damage calculation snapshot, present for recebeu_dano and causou_dano. */
  dano: AbilityDamageContext | null;
}

export interface ApplyScriptEffectInput {
  nome: string;
  tipo: "status" | "regeneration" | "no_regen_hp" | "no_regen_mana" | "stun" | "mana_used" | "magic_prohibition" | "damage_dealt" | "no_mana" | "damage_reduction" | "healing";
  duracao: number;
  atributo?: string | null;
  polaridade?: "buff" | "debuff";
  modoValor?: "fixed" | "percent";
  quantidade?: number;
  escopoDano?: "any" | "physical" | "magical";
  dados?: Record<string, unknown>;
}

export interface AbilityScriptApi {
  registrarLog(mensagem: string, dados?: unknown): void;
  alterarRecurso(input: {
    personagem: ScriptTarget;
    recurso: ScriptResource;
    operacao: ResourceOperation;
    quantidade: number;
  }): Promise<void>;
  atualizarEstado(patch: Record<string, unknown>): Promise<void>;
  /** Synchronize Coração Corrompido's temporary +20 Strength when its cooldown and Demonio Interno heat satisfy the rule. */
  sincronizarBonusCoracaoCorrompido(): Promise<void>;
  /** Atomically adjust a numeric per-ability state value and enforce a lower bound. */
  ajustarEstadoNumerico(input: { chave: string; delta: number; minimo?: number }): Promise<number>;
  /** Read current and maximum resource values for the Caster or Alvo. */
  consultarRecurso(input: { personagem: ScriptTarget; recurso: ScriptResource }): Promise<{ atual: number; maximo: number }>;
  /** Only valid during causou_dano; changes the post-defense and post-mitigation damage by hit. */
  modificarDanoFinal(input: { valoresPorGolpe: number[] }): Promise<void>;
  aplicarEfeito(input: {
    personagem: ScriptTarget;
    efeito: ApplyScriptEffectInput;
  }): Promise<string>;
  removerEfeito(input: { efeitoId: string }): Promise<boolean>;
}

export type AbilityScriptHandler = (
  contexto: AbilityScriptContext,
  api: AbilityScriptApi,
) => void | Promise<void>;

export type AbilityScript = Partial<Record<AbilityScriptEventType, AbilityScriptHandler>>;
