import { createClient } from "npm:@supabase/supabase-js@2";
import { abilityScriptRegistry } from "./scripts/registry.ts";
import type {
  AbilityScriptApi,
  AbilityScriptContext,
  AbilityScriptEventType,
  ApplyScriptEffectInput,
  ResourceOperation,
  ScriptResource,
  ScriptTarget,
} from "./types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

type QueuedAbilityEvent = {
  id: string;
  event_type: AbilityScriptEventType;
  script_key: string;
  ability_id: string | null;
  character_ability_id: string | null;
  battle_id: string | null;
  character_id: string | null;
  target_character_id: string | null;
  effect_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  queue_order: number | string;
};

type CharacterRow = { id: string; name: string; player_name?: string | null; body?: number; sanity?: number };
type ObjectValue = Record<string, unknown>;

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function asObject(value: unknown): ObjectValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue
    : {};
}

/** Convert PostgREST and other plain-object errors into readable messages. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const details = ["message", "details", "hint", "code"]
      .map((key) => record[key])
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (details.length > 0) return [...new Set(details)].join(" — ");

    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // Fall through to a safe generic message for circular objects.
    }
  }

  return String(error);
}

function finiteNumber(value: unknown, label: string, minimum = -1_000_000, maximum = 1_000_000) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${label} precisa ser um número entre ${minimum} e ${maximum}`);
  }
  return number;
}

function resourceField(resource: ScriptResource): "hp" | "mana" | "body" | "sanity" {
  if (resource === "corpo") return "body";
  if (resource === "sanidade") return "sanity";
  return resource;
}

async function characterHasHealingBlock(
  service: ReturnType<typeof createClient>,
  characterId: string,
  battleId: string | null,
): Promise<boolean> {
  let query = service.from("battle_effects")
    .select("id")
    .eq("character_id", characterId)
    .eq("effect_type", "healing_blocked")
    .gt("duration", 0);
  if (battleId) {
    query = query.or(`battle_id.is.null,battle_id.eq.${battleId}`);
  } else {
    query = query.is("battle_id", null);
  }
  const { data: activeEffects, error: effectsError } = await query.limit(1);
  if (effectsError) throw effectsError;
  if ((activeEffects ?? []).length > 0) return true;

  const { data: assignments, error: assignmentsError } = await service
    .from("character_abilities")
    .select("passive_effects")
    .eq("character_id", characterId);
  if (assignmentsError) throw assignmentsError;
  return (assignments ?? []).some((assignment) =>
    Array.isArray(assignment.passive_effects) &&
    assignment.passive_effects.some((effect) => asObject(effect).effect_type === "healing_blocked")
  );
}

async function loadCharacter(service: ReturnType<typeof createClient>, id: string | null): Promise<CharacterRow | null> {
  if (!id) return null;
  const { data, error } = await service
    .from("characters")
    .select("id,name,player_name,body,sanity")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as CharacterRow | null;
}

async function buildContext(service: ReturnType<typeof createClient>, event: QueuedAbilityEvent): Promise<AbilityScriptContext> {
  if (!event.character_id) throw new Error("O personagem dono da habilidade não existe mais.");
  const [assignmentResult, abilityResult, caster, target, battleResult] = await Promise.all([
    event.character_ability_id
      ? service.from("character_abilities").select("id,ability_id,name,character_id,custom_state").eq("id", event.character_ability_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    event.ability_id
      ? service.from("abilities").select("id,name,custom_script_key,custom_attributes").eq("id", event.ability_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    loadCharacter(service, event.character_id),
    loadCharacter(service, event.target_character_id),
    event.battle_id
      ? service.from("battles").select("id,name,turn_count,active").eq("id", event.battle_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (assignmentResult.error) throw assignmentResult.error;
  if (abilityResult.error) throw abilityResult.error;
  if (battleResult.error) throw battleResult.error;
  if (!caster) throw new Error("O personagem dono da habilidade não existe mais.");

  const payload = asObject(event.payload);
  const rawEffect = asObject(payload.effect);
  const battle = battleResult.data as { id: string; name: string; turn_count: number; active: boolean } | null;
  const assignment = assignmentResult.data as { id: string; ability_id: string; name: string; custom_state?: unknown } | null;
  const ability = abilityResult.data as { id: string; name: string; custom_script_key: string | null; custom_attributes?: unknown } | null;
  const individualTurn = Number(payload.turn_count);
  const rawState = asObject(assignment?.custom_state);
  const customAttributes: Record<string, number | string | boolean> = {};
  if (Array.isArray(ability?.custom_attributes)) {
    for (const rawAttribute of ability.custom_attributes) {
      const attribute = asObject(rawAttribute);
      if (typeof attribute.key !== "string" || !attribute.key.trim()) continue;
      if (attribute.type === "number" && Number.isFinite(Number(attribute.value))) customAttributes[attribute.key] = Number(attribute.value);
      else if (attribute.type === "boolean") customAttributes[attribute.key] = attribute.value === true;
      else if (attribute.type === "string" && typeof attribute.value === "string") customAttributes[attribute.key] = attribute.value;
    }
  }
  const rawDamage = asObject(payload.dano);
  const damage = Object.keys(rawDamage).length ? rawDamage as unknown as AbilityScriptContext["dano"] : null;

  return {
    idEvento: event.id,
    evento: event.event_type,
    habilidade: {
      id: event.ability_id ?? ability?.id ?? assignment?.ability_id ?? null,
      idNaFicha: event.character_ability_id ?? assignment?.id ?? null,
      nome: assignment?.name ?? ability?.name ?? event.script_key,
      scriptKey: event.script_key,
    },
    caster: { id: caster.id, nome: caster.name, nomeJogador: caster.player_name ?? null },
    alvo: target ? { id: target.id, nome: target.name, nomeJogador: target.player_name ?? null } : null,
    batalha: battle ? { id: battle.id, nome: battle.name, turnoGeral: battle.turn_count, ativa: battle.active } : null,
    turno: {
      individual: Number.isFinite(individualTurn) ? individualTurn : null,
      geral: battle?.turn_count ?? null,
    },
    efeito: Object.keys(rawEffect).length ? rawEffect : null,
    dados: payload,
    atributos: customAttributes,
    estado: rawState,
    dano: damage,
  };
}

function makeApi(
  service: ReturnType<typeof createClient>,
  context: AbilityScriptContext,
  onFinalDamageChange?: (values: number[]) => Promise<void>,
): AbilityScriptApi {
  const registrarLog = (message: string, details?: unknown) => {
    console.info("[ability-script]", JSON.stringify({
      eventId: context.idEvento,
      script: context.habilidade.scriptKey,
      evento: context.evento,
      personagem: context.caster.id,
      mensagem: String(message).slice(0, 2_000),
      detalhes: details ?? null,
    }));
  };

  const resolveTarget = (target: ScriptTarget) => {
    const character = target === "caster" ? context.caster : context.alvo;
    if (!character) throw new Error("Este evento não tem um alvo selecionado.");
    return character;
  };

  return {
    registrarLog,

    async alterarRecurso(input: {
      personagem: ScriptTarget;
      recurso: ScriptResource;
      operacao: ResourceOperation;
      quantidade: number;
    }) {
      const character = resolveTarget(input.personagem);
      const amount = finiteNumber(input.quantidade, "Quantidade", 0, 1_000_000);
      const field = resourceField(input.recurso);
      let current: number;
      let maximum: number;

      if (field === "body" || field === "sanity") {
        const { data, error } = await service.from("characters")
          .select(field)
          .eq("id", character.id)
          .single();
        if (error) throw error;
        current = Number(data[field] ?? 0);
        maximum = 100;
      } else {
        const { data: attribute, error: attributeError } = await service.from("character_attributes")
          .select("current_value")
          .eq("character_id", character.id)
          .eq("attribute_key", field)
          .maybeSingle();
        if (attributeError) throw attributeError;
        if (!attribute) throw new Error(`A ficha não possui o recurso ${field}.`);
        current = Number(attribute.current_value ?? 0);
        const { data: resourceMax, error: maximumError } = await service.rpc("calculate_character_resource_max", {
          _character_id: character.id,
          _attribute_key: field,
        });
        if (maximumError) throw maximumError;
        maximum = Math.max(0, Number(resourceMax ?? 0));
      }

      let proposedValue: number;
      if (input.operacao === "somar") proposedValue = current + amount;
      else if (input.operacao === "subtrair") proposedValue = current - amount;
      else if (input.operacao === "definir") proposedValue = amount;
      else throw new Error("Operação de recurso inválida.");

      if (proposedValue > current && await characterHasHealingBlock(service, character.id, context.batalha?.id ?? null)) {
        registrarLog("Recuperação bloqueada por Bloqueio de Cura", {
          personagem: character.id,
          recurso: input.recurso,
          valorAtual: current,
          valorTentado: proposedValue,
        });
        return;
      }

      if (field === "hp" && input.operacao !== "definir") {
        const delta = input.operacao === "somar" ? -Math.round(amount) : input.operacao === "subtrair" ? Math.round(amount) : null;
        if (delta === null) throw new Error("Operação de HP inválida.");
        const { data: resultingHp, error: hpAdjustmentError } = await service.rpc("adjust_character_hp_for_custom_damage", {
          _character_id: character.id,
          _damage_delta: delta,
        });
        if (hpAdjustmentError) throw hpAdjustmentError;
        registrarLog(`HP: ${current} → ${Number(resultingHp)}`, { personagem: character.id, operacao: input.operacao });
        return;
      }

      let next = current;
      if (input.operacao === "somar") next = current + amount;
      else if (input.operacao === "subtrair") next = current - amount;
      else if (input.operacao === "definir") next = amount;
      else throw new Error("Operação de recurso inválida.");

      next = Math.round(Math.max(0, Math.min(maximum, next)));

      if (field === "body" || field === "sanity") {
        const { error } = await service.from("characters")
          .update({ [field]: next, updated_at: new Date().toISOString() })
          .eq("id", character.id);
        if (error) throw error;
      } else {
        const { error } = await service.from("character_attributes")
          .update({ current_value: next, updated_at: new Date().toISOString() })
          .eq("character_id", character.id)
          .eq("attribute_key", field);
        if (error) throw error;
      }

      registrarLog(`${input.recurso}: ${current} → ${next}`, {
        personagem: character.id,
        operacao: input.operacao,
      });
    },

    async atualizarEstado(patch: Record<string, unknown>) {
      const characterAbilityId = context.habilidade.idNaFicha;
      if (!characterAbilityId) throw new Error("Este evento não está vinculado a uma habilidade da ficha.");
      const safePatch = asObject(patch);
      const { data, error } = await service.rpc("merge_character_ability_custom_state", {
        _character_ability_id: characterAbilityId,
        _patch: safePatch,
      });
      if (error) throw error;
      context.estado = asObject(data);
    },

    async ajustarEstadoNumerico(input: { chave: string; delta: number; minimo?: number }) {
      const characterAbilityId = context.habilidade.idNaFicha;
      if (!characterAbilityId) throw new Error("Este evento não está vinculado a uma habilidade da ficha.");
      if (!input.chave.trim()) throw new Error("Informe a chave do estado.");
      const delta = finiteNumber(input.delta, "Ajuste de estado", -1_000_000_000_000, 1_000_000_000_000);
      const minimo = finiteNumber(input.minimo ?? 0, "Limite mínimo", -1_000_000_000_000, 1_000_000_000_000);
      const { data, error } = await service.rpc("adjust_character_ability_custom_state_number", {
        _character_ability_id: characterAbilityId,
        _key: input.chave,
        _delta: delta,
        _minimum: minimo,
      });
      if (error) throw error;
      context.estado = asObject(data);
      return Number(context.estado[input.chave] ?? minimo);
    },

    async consultarRecurso(input: { personagem: ScriptTarget; recurso: ScriptResource }) {
      const character = resolveTarget(input.personagem);
      const field = resourceField(input.recurso);
      if (field === "body" || field === "sanity") {
        const { data, error } = await service.from("characters")
          .select(field)
          .eq("id", character.id)
          .single();
        if (error) throw error;
        return { atual: Number(data[field] ?? 0), maximo: 100 };
      }

      const { data, error } = await service.from("character_attributes")
        .select("current_value")
        .eq("character_id", character.id)
        .eq("attribute_key", field)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error(`A ficha não possui o recurso ${field}.`);
      const { data: maximum, error: maximumError } = await service.rpc("calculate_character_resource_max", {
        _character_id: character.id,
        _attribute_key: field,
      });
      if (maximumError) throw maximumError;
      return { atual: Number(data.current_value ?? 0), maximo: Math.max(0, Number(maximum ?? 0)) };
    },

    async modificarDanoFinal(input: { valoresPorGolpe: number[] }) {
      if (context.evento !== "causou_dano" || !onFinalDamageChange || !context.dano) {
        throw new Error("modificarDanoFinal só pode ser usado durante causou_dano.");
      }
      if (!Array.isArray(input.valoresPorGolpe) || input.valoresPorGolpe.length !== context.dano.danoFinalPorGolpe.length) {
        throw new Error("A quantidade de valores finais precisa corresponder ao número de golpes.");
      }
      const values = input.valoresPorGolpe.map((value) => finiteNumber(value, "Dano final", 0, 2_000_000));
      await onFinalDamageChange(values);
      context.dano = {
        ...context.dano,
        danoFinalPorGolpe: values,
        danoFinalTotal: values.reduce((sum, value) => sum + Math.round(value), 0),
        hpDepois: Math.max(0, Math.round(context.dano.hpAntes - values.reduce((sum, value) => sum + Math.round(value), 0))),
      };
    },

    async aplicarEfeito(input: { personagem: ScriptTarget; efeito: ApplyScriptEffectInput }) {
      const character = resolveTarget(input.personagem);
      const definition = input.efeito;
      const duration = Math.floor(finiteNumber(definition.duracao, "Duração", 1, 10_000));
      const amount = finiteNumber(definition.quantidade ?? 0, "Quantidade", 0, 1_000_000);
      const type = definition.tipo;

      if (type === "status" && !definition.atributo) {
        throw new Error("Efeitos de status precisam informar atributo.");
      }
      if (type === "regeneration" && !["hp", "mana"].includes(definition.atributo ?? "")) {
        throw new Error("Regeneração precisa usar o atributo hp ou mana.");
      }
      if (type === "healing" && !definition.dados) {
        throw new Error("Efeitos de cura precisam informar os dados de cura em 'dados'.");
      }

      const forcedDebuff = type === "magic_prohibition" || type === "no_mana";
      const healing = type === "healing";
      const reduction = type === "damage_reduction";
      const effectRow = {
        battle_id: context.batalha?.id ?? null,
        character_id: character.id,
        name: String(definition.nome).trim().slice(0, 160) || "Efeito customizado",
        effect_type: type,
        attribute_key: ["status", "regeneration"].includes(type) ? definition.atributo ?? null : null,
        polarity: forcedDebuff ? "debuff" : reduction || healing ? "buff" : definition.polaridade ?? "buff",
        value_mode: healing ? "fixed" : definition.modoValor ?? "fixed",
        amount: healing ? 0 : amount,
        duration,
        duration_scope: "individual",
        damage_scope: definition.escopoDano ?? "any",
        damage_reduction_scope: "physical",
        damage_reduction_type_id: null,
        damage_reduction_magic_level: null,
        damage_reduction_type_ids: null,
        damage_reduction_magic_levels: null,
        source_character_ability_id: context.habilidade.idNaFicha,
        target_character_id: context.alvo?.id ?? null,
        effect_data: definition.dados ?? {},
      };

      const { data, error } = await service.from("battle_effects").insert(effectRow).select("id").single();
      if (error) throw error;
      registrarLog(`Efeito aplicado: ${effectRow.name}`, { personagem: character.id, effectId: data.id });
      return data.id as string;
    },

    async removerEfeito(input: { efeitoId: string }) {
      const { data: effect, error: effectError } = await service.from("battle_effects")
        .select("id,character_id,battle_id")
        .eq("id", input.efeitoId)
        .maybeSingle();
      if (effectError) throw effectError;
      if (!effect) return false;

      const permittedCharacters = new Set([context.caster.id, context.alvo?.id].filter((id): id is string => !!id));
      if (!permittedCharacters.has(effect.character_id)) {
        throw new Error("Um script só pode remover efeitos do Caster ou do Alvo do evento.");
      }
      if (context.batalha?.id) {
        if (effect.battle_id && effect.battle_id !== context.batalha.id) {
          throw new Error("Este efeito pertence a outra batalha.");
        }
      } else if (effect.battle_id !== null) {
        throw new Error("Este evento não está vinculado a essa batalha.");
      }

      const { error } = await service.from("battle_effects").delete().eq("id", input.efeitoId);
      if (error) throw error;
      registrarLog("Efeito removido", { effectId: input.efeitoId });
      return true;
    },
  };
}

type DamageRpcResult = {
  hits: number;
  total_damage: number;
  hp_before: number;
  hp_after: number;
  final_damage_by_hit?: number[];
  [key: string]: unknown;
};

type DamageCall = {
  battleId: string | null;
  targetId: string;
  sourceId: string | null;
  kind: "physical" | "magical" | "hybrid" | "true";
  typeId: string | null;
  magicLevel: "baixa" | "media" | "alta" | null;
  rawValues: number[];
  critical: boolean;
};

type DamageTracker = {
  rawValues: number[];
  finalValues: number[];
  total: number;
  hpBefore: number;
  hpAfter: number;
  call: DamageCall;
};

async function runDamageScriptHooks(
  service: ReturnType<typeof createClient>,
  tracker: DamageTracker,
  ownerCharacterId: string,
  oppositeCharacterId: string | null,
  eventType: "causou_dano" | "recebeu_dano",
): Promise<{ processed: number; errors: string[] }> {
  const { data: assignments, error: assignmentsError } = await service
    .from("character_abilities")
    .select("id,ability_id,character_id,name,custom_state")
    .eq("character_id", ownerCharacterId);
  if (assignmentsError) throw assignmentsError;
  const abilityIds = [...new Set((assignments ?? []).map((row) => row.ability_id))];
  if (!abilityIds.length) return { processed: 0, errors: [] };

  const { data: abilityRows, error: abilitiesError } = await service
    .from("abilities")
    .select("id,name,custom_script_key,custom_attributes")
    .in("id", abilityIds);
  if (abilitiesError) throw abilitiesError;
  const scriptKeys = new Map((abilityRows ?? []).map((ability) => [ability.id, ability.custom_script_key]));
  let processed = 0;
  const errors: string[] = [];

  for (const assignment of assignments ?? []) {
    const scriptKey = scriptKeys.get(assignment.ability_id);
    if (!scriptKey) continue;
    const script = abilityScriptRegistry[scriptKey];
    if (!script) {
      errors.push(`${scriptKey}: script não registrado`);
      continue;
    }
    const handler = script[eventType];
    if (!handler) continue;

    const eventId = crypto.randomUUID();
    const event: QueuedAbilityEvent = {
      id: eventId,
      event_type: eventType,
      script_key: scriptKey,
      ability_id: assignment.ability_id,
      character_ability_id: assignment.id,
      battle_id: tracker.call.battleId,
      character_id: ownerCharacterId,
      target_character_id: oppositeCharacterId,
      effect_id: null,
      attempts: 0,
      queue_order: 0,
      payload: {
        dano: {
          origemId: tracker.call.sourceId,
          personagemAtingidoId: tracker.call.targetId,
          categoria: tracker.call.kind,
          tipoDanoId: tracker.call.typeId,
          grauMagia: tracker.call.magicLevel,
          critico: tracker.call.critical,
          danoBrutoPorGolpe: [...tracker.rawValues],
          danoFinalPorGolpe: [...tracker.finalValues],
          danoFinalTotal: tracker.total,
          hpAntes: tracker.hpBefore,
          hpDepois: tracker.hpAfter,
        },
      },
    };

    try {
      const context = await buildContext(service, event);
      const api = makeApi(service, context, eventType === "causou_dano" ? async (values) => {
        const normalizedValues = values.map((value) => Math.round(value));
        const total = normalizedValues.reduce((sum, value) => sum + value, 0);
        // Recalculate HP from the pre-hit value, rather than applying a delta to
        // zero-clamped HP. This also handles critical hits and overkill correctly.
        const desiredHp = Math.max(0, tracker.hpBefore - total);
        const { data: currentHpRow, error: currentHpError } = await service.from("character_attributes")
          .select("current_value")
          .eq("character_id", tracker.call.targetId)
          .eq("attribute_key", "hp")
          .maybeSingle();
        if (currentHpError) throw currentHpError;
        if (!currentHpRow) throw new Error("O alvo não possui atributo de HP.");
        const delta = Number(currentHpRow.current_value) - desiredHp;
        const { data: nextHp, error } = await service.rpc("adjust_character_hp_for_custom_damage", {
          _character_id: tracker.call.targetId,
          _damage_delta: delta,
        });
        if (error) throw error;
        tracker.finalValues = normalizedValues;
        tracker.total = total;
        tracker.hpAfter = Number(nextHp);
      } : undefined);
      await handler(context, api);
      processed += 1;
    } catch (error) {
      const message = errorMessage(error);
      console.error("Custom damage hook failed:", eventId, scriptKey, eventType, message);
      errors.push(`${scriptKey} (${eventType}): ${message.slice(0, 400)}`);
    }
  }
  return { processed, errors };
}

async function applyDamageWithScripts(
  body: ObjectValue,
  userClient: ReturnType<typeof createClient>,
  service: ReturnType<typeof createClient>,
): Promise<ObjectValue> {
  const battleId = typeof body._battle_id === "string" ? body._battle_id : null;
  const targetId = typeof body._character_id === "string" ? body._character_id : "";
  const sourceId = typeof body._source_character_id === "string" ? body._source_character_id : null;
  const rawValues = Array.isArray(body._damage_values) ? body._damage_values.map((value) => Number(value)) : [];
  const kind = body._damage_kind as DamageCall["kind"];
  const typeId = typeof body._damage_type_id === "string" ? body._damage_type_id : null;
  const magicLevel = typeof body._magic_level === "string" ? body._magic_level as DamageCall["magicLevel"] : null;
  const critical = body._critical_damage === true;

  if (!targetId || !["physical", "magical", "hybrid", "true"].includes(kind) ||
      rawValues.length < 1 || rawValues.length > 200 ||
      rawValues.some((value) => !Number.isFinite(value) || value < 0 || value > 1_000_000)) {
    throw new Error("Dados de dano inválidos.");
  }

  const call: DamageCall = { battleId, targetId, sourceId, kind, typeId, magicLevel, rawValues, critical };
  const damageFunction = critical ? "apply_battle_damage_critical" : "apply_battle_damage";
  const { data, error } = await userClient.rpc(damageFunction, {
    _battle_id: battleId,
    _character_id: targetId,
    _damage_kind: kind,
    _damage_type_id: typeId,
    _damage_values: rawValues,
    _magic_level: magicLevel,
    _source_character_id: sourceId,
  });
  if (error) throw error;
  const base = asObject(data) as DamageRpcResult;
  if (!Array.isArray(base.final_damage_by_hit)) {
    throw new Error("A migração 0041 ainda não foi aplicada: falta o resultado por golpe.");
  }

  const finalValues = base.final_damage_by_hit.map((value) =>
    finiteNumber(value, "Dano calculado", 0, critical ? 2_000_000 : 1_000_000)
  );
  const tracker: DamageTracker = {
    call,
    rawValues,
    finalValues,
    total: finalValues.reduce((sum, value) => sum + Math.round(value), 0),
    hpBefore: Number(base.hp_before ?? 0),
    hpAfter: Number(base.hp_after ?? 0),
  };
  const hookErrors: string[] = [];
  let hooksProcessed = 0;

  // causou_dano runs after ordinary source buffs, defense, and mitigation are calculated.
  // Scripts can replace per-hit final values; the target HP is re-synchronized from hp_before.
  if (sourceId && tracker.total > 0) {
    const result = await runDamageScriptHooks(service, tracker, sourceId, targetId, "causou_dano");
    hooksProcessed += result.processed;
    hookErrors.push(...result.errors);
  }

  // received damage observes the final amount after all causou_dano scripts have modified it.
  if (tracker.total > 0) {
    const result = await runDamageScriptHooks(service, tracker, targetId, sourceId, "recebeu_dano");
    hooksProcessed += result.processed;
    hookErrors.push(...result.errors);
  }

  return {
    ...base,
    total_damage: tracker.total,
    hp_after: tracker.hpAfter,
    final_damage_by_hit: tracker.finalValues,
    critical_damage: critical,
    custom_script_hooks: { processed: hooksProcessed, errors: hookErrors },
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond({ error: "Use POST." }, 405);

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return respond({ error: "Autenticação obrigatória." }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    console.error("Missing Supabase function environment variables.");
    return respond({ error: "Configuração do runtime de habilidades incompleta." }, 500);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: userResult, error: userError } = await userClient.auth.getUser();
  if (userError || !userResult.user) return respond({ error: "Sessão inválida." }, 401);

  const { data: isMaster, error: roleError } = await userClient.rpc("has_role", {
    _role: "master",
    _user_id: userResult.user.id,
  });
  if (roleError || isMaster !== true) {
    return respond({ error: "Apenas o mestre pode executar scripts de habilidades." }, 403);
  }

  let body: ObjectValue = {};
  try {
    body = asObject(await request.json());
  } catch {
    return respond({ error: "Corpo JSON inválido." }, 400);
  }
  const battleId = typeof body.battle_id === "string" ? body.battle_id : null;
  const service = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let damageResult: ObjectValue | null = null;
  if (body.action === "apply_damage") {
    try {
      damageResult = await applyDamageWithScripts(body, userClient, service);
    } catch (error) {
      const message = errorMessage(error);
      console.error("Apply damage request failed:", message);
      return respond({ error: message }, 400);
    }

    // Damage hooks run synchronously inside applyDamageWithScripts. Do not drain the
    // unrelated queued-event worker after HP has already changed: a queue/RPC failure
    // here would incorrectly turn a successful damage action into an HTTP error.
    return respond({
      ok: true,
      processed: 0,
      failed: 0,
      pendingLimitReached: false,
      damage_result: damageResult,
    });
  }

  let processed = 0;
  let failed = 0;
  let pendingLimitReached = false;

  // A few rounds also pick up events generated by scripts applying/removing effects.
  // This hard limit prevents accidental infinite chains of self-triggering scripts.
  for (let round = 0; round < 5; round += 1) {
    const { data: events, error: claimError } = await service.rpc("claim_ability_script_events", {
      _batch_size: 50,
      _battle_id: battleId,
    });
    if (claimError) {
      console.error("Failed to claim custom ability events:", claimError.message);
      return respond({ error: "Não foi possível carregar a fila de eventos." }, 500);
    }

    const queue = (events ?? []) as QueuedAbilityEvent[];
    queue.sort((left, right) => Number(left.queue_order) - Number(right.queue_order));
    if (queue.length === 0) break;
    if (round === 4 && queue.length === 50) pendingLimitReached = true;

    for (const event of queue) {
      try {
        const script = abilityScriptRegistry[event.script_key];
        if (!script) throw new Error(`Script '${event.script_key}' não está registrado no servidor.`);
        const handler = script[event.event_type];
        if (handler) {
          const context = await buildContext(service, event);
          await handler(context, makeApi(service, context));
        }

        const { error: updateError } = await service.from("ability_script_events")
          .update({
            status: "processed",
            processed_at: new Date().toISOString(),
            locked_at: null,
            error_message: null,
          })
          .eq("id", event.id);
        if (updateError) throw updateError;
        processed += 1;
      } catch (error) {
        const message = errorMessage(error);
        console.error("Custom ability script failed:", event.id, event.script_key, event.event_type, message);
        // Do not immediately replay a script which may already have performed a partial action.
        // Crashed workers can still be reclaimed from stale 'processing' after five minutes.
        const nextStatus = "failed";
        const { error: updateError } = await service.from("ability_script_events")
          .update({ status: nextStatus, locked_at: null, error_message: message.slice(0, 2_000) })
          .eq("id", event.id);
        if (updateError) console.error("Could not update event failure state:", updateError.message);
        failed += 1;
      }
    }
  }

  const pendingQuery = service.from("ability_script_events")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  if (battleId) pendingQuery.eq("battle_id", battleId);
  const { count: pendingCount, error: pendingError } = await pendingQuery;
  if (pendingError) {
    console.error("Could not count remaining custom ability events:", pendingError.message);
    pendingLimitReached = true;
  } else if ((pendingCount ?? 0) > 0) {
    pendingLimitReached = true;
  }

  return respond({ ok: true, processed, failed, pendingLimitReached, damage_result: damageResult });
});
