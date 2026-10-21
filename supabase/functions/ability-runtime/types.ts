export type AbilityScriptEventType =
  | "turno_avançou"
  | "habilidade_ativada"
  | "efeito_aplicado_no_caster"
  | "efeito_removido_no_caster";

export type ScriptTarget = "caster" | "alvo";
export type ScriptResource = "hp" | "mana" | "corpo" | "sanidade";
export type ResourceOperation = "somar" | "subtrair" | "definir";

export interface ScriptCharacter {
  id: string;
  nome: string;
  nomeJogador?: string | null;
}

export interface AbilityScriptContext {
  evento: AbilityScriptEventType;
  habilidade: {
    id: string | null;
    idNaFicha: string | null;
    nome: string;
    scriptKey: string;
  };
  /** Personagem que tem esta habilidade atribuída. */
  caster: ScriptCharacter;
  /** Alvo escolhido na ativação, quando o evento tiver um alvo. */
  alvo: ScriptCharacter | null;
  batalha: { id: string; nome: string; turnoGeral: number; ativa: boolean } | null;
  turno: { individual: number | null; geral: number | null };
  /** Snapshot do efeito relacionado ao evento, quando aplicável. */
  efeito: Record<string, unknown> | null;
  /** Dados adicionais imutáveis gravados pelo evento no banco. */
  dados: Record<string, unknown>;
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
