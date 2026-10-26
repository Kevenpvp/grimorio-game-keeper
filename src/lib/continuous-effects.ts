export type ContinuousTrigger = "target" | "caster" | "global";
export type ContinuousAttribute = { key: string; mode: "fixed" | "percent"; step: number; cap: number };
export type ContinuousStatusAction = { kind: "status"; polarity: "buff" | "debuff"; attributes: ContinuousAttribute[] };
export type ContinuousDamageAction = { kind: "damage"; dice_count: number; dice_sides: number; flat: number; damage_kind: "true" | "physical" | "magical"; neutralizable: boolean };
export type ContinuousDotAction = { kind: "dot"; template_id: string; damage_mode: "fixed" | "percent"; damage_amount: number; duration: number; repeat: boolean };
export type ContinuousEffectAction = { kind: "effect"; effect_type: "stun" | "no_regen_hp" | "no_regen_mana" | "magic_prohibition" | "no_mana" | "invincible"; name: string; duration: number; repeat: boolean };
export type ContinuousAction = ContinuousStatusAction | ContinuousDamageAction | ContinuousDotAction | ContinuousEffectAction;
export type ContinuousOnLimit = "replace_oldest" | "choose" | "block";
export type ContinuousRule = {
  name: string; trigger: ContinuousTrigger; linger_turns: number; actions: ContinuousAction[];
  max_targets: number | null; on_limit: ContinuousOnLimit;
  stop_on_caster_leave: boolean; stop_on_caster_death: boolean; stop_on_caster_stun: boolean;
};
export type ContinuousInstance = {
  id: string; battle_id: string; character_ability_id: string;
  caster_character_id: string; target_character_id: string; name: string;
  active: boolean; ticks: number; rule: ContinuousRule;
};
export type ContinuousActionDecision = { skip?: boolean; damage_amount?: number; duration?: number; attributes?: Record<string,number> };
export type ContinuousDecision = {
  resolution?: "apply" | "interrupt" | "dispel";
  damage?: number; damage_kind?: "true" | "physical" | "magical"; neutralize?: boolean;
  actions?: Record<string,ContinuousActionDecision>;
};

const n = (value: unknown, fallback: number, max: number) => {
  const x = Number(value);
  return Number.isFinite(x) ? Math.max(0, Math.min(max, Math.floor(x))) : fallback;
};

export function parseContinuousRules(value: unknown): ContinuousRule[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((raw): ContinuousRule[] => {
    if (!raw || typeof raw !== "object") return [];
    const data = raw as Record<string, unknown>;
    const actions = Array.isArray(data.actions) ? data.actions.slice(0, 12).flatMap((item): ContinuousAction[] => {
      if (!item || typeof item !== "object") return [];
      const action = item as Record<string, unknown>;
      if (action.kind === "status") {
        const attributes = Array.isArray(action.attributes) ? action.attributes.slice(0, 48).flatMap((r): ContinuousAttribute[] => {
          if (!r || typeof r !== "object") return [];
          const a = r as Record<string, unknown>;
          return typeof a.key === "string" && a.key ? [{
            key: a.key, mode: a.mode === "fixed" ? "fixed" : "percent",
            step: n(a.step, 5, 1000000), cap: n(a.cap, 100, 1000000),
          }] : [];
        }) : [];
        return [{ kind: "status", polarity: action.polarity === "buff" ? "buff" : "debuff", attributes }];
      }
      if (action.kind === "dot" && typeof action.template_id === "string") return [{
        kind:"dot",template_id:action.template_id,
        damage_mode:action.damage_mode==="percent"?"percent":"fixed",
        damage_amount:n(action.damage_amount,5,1000000),
        duration:Math.max(1,n(action.duration,2,1000)),
        repeat:action.repeat===true,
      }];
      if (action.kind === "effect" && typeof action.effect_type === "string" &&
        ["stun","no_regen_hp","no_regen_mana","magic_prohibition","no_mana","invincible"].includes(action.effect_type)) return [{
          kind:"effect",effect_type:action.effect_type as ContinuousEffectAction["effect_type"],
          name:typeof action.name==="string"?action.name.slice(0,120):"Efeito",duration:Math.max(1,n(action.duration,2,1000)),
          repeat:action.repeat===true,
      }];
      if (action.kind === "damage") return [{
        kind: "damage", dice_count: n(action.dice_count, 1, 20), dice_sides: Math.max(1, n(action.dice_sides, 50, 1000)),
        flat: n(action.flat, 0, 1000000),
        damage_kind: action.damage_kind === "physical" || action.damage_kind === "magical" ? action.damage_kind : "true",
        neutralizable: action.neutralizable === true,
      }];
      return [];
    }) : [];
    if (!actions.length) return [];
    return [{
      name: typeof data.name === "string" && data.name.trim() ? data.name.trim().slice(0, 140) : "Efeito contínuo",
      trigger: data.trigger === "caster" || data.trigger === "global" ? data.trigger : "target",
      linger_turns: n(data.linger_turns, 0, 1000),
      max_targets: data.max_targets === null || data.max_targets === "unlimited" ? null
        : data.max_targets === undefined ? null : Math.max(1, n(data.max_targets, 1, 100)),
      on_limit: data.on_limit === "block" || data.on_limit === "choose" ? data.on_limit : "replace_oldest",
      stop_on_caster_leave: data.stop_on_caster_leave !== false,
      stop_on_caster_death: data.stop_on_caster_death === true,
      stop_on_caster_stun: data.stop_on_caster_stun === true,
      actions,
    }];
  });
}

export function defaultContinuousRule(): ContinuousRule {
  return { name: "Efeito contínuo", trigger: "target", linger_turns: 0,
    max_targets: null, on_limit: "replace_oldest",
    stop_on_caster_leave: true, stop_on_caster_death: false, stop_on_caster_stun: false,
    actions: [{ kind: "status", polarity: "debuff", attributes: [{ key: "strength", mode: "percent", step: 5, cap: 100 }] }] };
}

/** UI dice roll is a suggested number; the server revalidates every edit. */
export function previewContinuousDamage(action: ContinuousDamageAction): number {
  let total = action.flat;
  for (let i = 0; i < action.dice_count; i++) total += 1 + Math.floor(Math.random() * action.dice_sides);
  return total;
}

export function pendingContinuousInstances(instances: ContinuousInstance[], characterId: string | null) {
  return instances.filter((instance) => instance.active && (
    characterId === null ? instance.rule.trigger === "global"
      : (instance.rule.trigger === "target" && instance.target_character_id === characterId)
      || (instance.rule.trigger === "caster" && instance.caster_character_id === characterId)
  ));
}
