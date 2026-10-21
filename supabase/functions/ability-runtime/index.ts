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
      ? service.from("character_abilities").select("id,ability_id,name,character_id").eq("id", event.character_ability_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    event.ability_id
      ? service.from("abilities").select("id,name,custom_script_key").eq("id", event.ability_id).maybeSingle()
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
  const assignment = assignmentResult.data as { id: string; ability_id: string; name: string } | null;
  const ability = abilityResult.data as { id: string; name: string; custom_script_key: string | null } | null;
  const individualTurn = Number(payload.turn_count);

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
  };
}

function makeApi(
  service: ReturnType<typeof createClient>,
  context: AbilityScriptContext,
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
        const message = error instanceof Error ? error.message : String(error);
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

  return respond({ ok: true, processed, failed, pendingLimitReached });
});
