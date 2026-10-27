import { useQuery } from "@tanstack/react-query";
import { Activity, BookOpen, ChevronDown, CircleHelp, Ghost, Heart, ScrollText, Shield, Sparkles, Swords, Waves } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatBar } from "@/components/sheet/StatBar";
import { AttrIcon, barTone } from "@/components/sheet/icons";
import { useDefs, useCharacterTraitMods, computeValue, physicalAttributePoints, conditionAdjustedValue, clampNonDefenseAttribute } from "@/lib/sheets";
import { parseAbilityEffects, passiveStatusModifiers, statusEffectModifiers, type AbilityEffectDefinition, type ActiveCharacterEffect, type CharacterAbility } from "@/lib/abilities";
import { parseContinuousRules } from "@/lib/continuous-effects";
import { supabase } from "@/integrations/supabase/client";

type Creature = {
  id: string; name: string; description: string | null;
  body: number; sanity: number;
  race_id: string | null; virtue_id: string | null; class_id: string | null;
  class_custom_modifiers: unknown;
  race_physical_allocations: unknown;
  virtue_physical_allocations: unknown;
  class_physical_allocations: unknown;
};
type CreatureAttribute = {
  attribute_key: string; points: number; bonus: number; current_value: number; max_value: number;
};
type CreatureSkill = Pick<CharacterAbility, "id" | "name" | "description" | "is_passive" |
 "can_activate" | "is_magical" | "mana_cost" | "cooldown_turns" | "cooldown_remaining" |
 "active_duration_remaining" | "attack_enabled" | "attack_damage" | "effects" |
 "passive_effects" | "end_effects" | "continuous_rules" | "dot_effects" |
 "toggle_mode" | "toggle_active">;
type CreatureEffect = Pick<ActiveCharacterEffect, "id" | "name" | "effect_type" |
 "attribute_key" | "polarity" | "value_mode" | "amount" | "duration" |
 "duration_scope" | "until_combat_end" | "effect_data"> & {
  is_sheet_permanent: boolean;
};
type CreatureDetails = {
  name: string; is_active: boolean; character: Creature;
  configured_stats: Record<string, number>;
  attributes: CreatureAttribute[];
  abilities: CreatureSkill[];
  effects: CreatureEffect[];
};
const db = supabase as any;

function effectLabel(effect: AbilityEffectDefinition, labels: Record<string,string>): string {
  if (effect.effect_type === "status") {
    const group = effect.attribute_modifiers?.length ? effect.attribute_modifiers : effect.attribute_key
      ? [{attribute_key:effect.attribute_key, amount:effect.amount,value_mode:effect.value_mode}] : [];
    if (group.length) return group.map(a => `${effect.polarity==="debuff"?"−":"+"}${a.amount}${a.value_mode==="percent"?"%":""} ${labels[a.attribute_key]??a.attribute_key}`).join(" · ");
  }
  const amount = Number(effect.amount) || 0;
  return amount ? `${effect.polarity==="debuff"?"−":"+"}${amount}${effect.value_mode==="percent"?"%":""}` : effect.effect_type.replaceAll("_"," ");
}
function AbilityDetails({ability, labels}: {ability:CreatureSkill; labels:Record<string,string>}) {
  const activation = parseAbilityEffects(ability.effects);
  const passive = parseAbilityEffects(ability.passive_effects);
  const ending = parseAbilityEffects(ability.end_effects);
  const continuous = parseContinuousRules(ability.continuous_rules);
  const dots = Array.isArray(ability.dot_effects) ? ability.dot_effects as Array<{name?:string}> : [];
  const damage = ability.attack_damage && typeof ability.attack_damage==="object" && !Array.isArray(ability.attack_damage)
    ? ability.attack_damage as {damage_kind?:string;attribute_key?:string;attribute_percent?:number;fixed_damage?:number;execute_enabled?:boolean;execute_threshold?:number;execute_mode?:string}
    : null;
  return <details className="group rounded-xl border border-gold/20 bg-background/60 p-3">
    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
      <div className="min-w-0">
        <p className="break-words text-sm font-semibold text-gold">{ability.name}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {ability.is_passive||!ability.can_activate?"Passiva / não ativável":"Ativa"} · {ability.is_magical?"Mágica":"Não mágica"}
          {ability.can_activate && !ability.is_passive && <> · {ability.mana_cost} Mana · Recarga {ability.cooldown_turns} turno(s)</>}
        </p>
      </div>
      <ChevronDown className="h-4 w-4 shrink-0 text-gold transition-transform group-open:rotate-180"/>
    </summary>
    <div className="space-y-3 border-t border-gold/15 pt-3 text-sm">
      {ability.description ? <p className="whitespace-pre-wrap break-words leading-relaxed">{ability.description}</p>
        : <p className="text-xs text-muted-foreground">Sem descrição cadastrada.</p>}
      {ability.can_activate && <p className="text-xs text-muted-foreground">
        {ability.cooldown_remaining>0?`Recarga restante: ${ability.cooldown_remaining} turno(s)`:"Recarga disponível"}
        {ability.active_duration_remaining>0 && ` · Duração ativa: ${ability.active_duration_remaining} turno(s)`}
        {ability.toggle_mode && ` · Sustentada: ${ability.toggle_active?"ativa":"inativa"}`}
      </p>}
      {ability.attack_enabled && <div className="rounded-lg border border-gold/20 p-3 text-xs">
        <div className="mb-1 flex items-center gap-1.5 font-semibold text-gold"><Swords className="h-4 w-4"/> Ataque</div>
        <p>Tipo: {damage?.damage_kind??"físico"}
          {damage?.attribute_key ? ` · ${damage.attribute_percent??100}% de ${labels[damage.attribute_key]??damage.attribute_key}`:""}
          {damage?.fixed_damage ? ` · +${damage.fixed_damage} fixo`:""}
          {!damage?.attribute_key&&!damage?.fixed_damage?" · Sem dano direto":""}
        </p>
        {damage?.execute_enabled && <p>Execução com HP {damage.execute_mode==="fixed"?"≤ "+damage.execute_threshold:"≤ "+damage.execute_threshold+"%"}</p>}
      </div>}
      {([
        ["Efeitos ao ativar", activation],
        ["Efeitos passivos", passive],
        ["Efeitos ao encerrar", ending],
      ] as [string,AbilityEffectDefinition[]][]).filter(([,effects])=>effects.length>0).map(([title,effects])=>
        <div key={title} className="space-y-1.5">
          <p className="text-xs font-semibold text-gold">{title}</p>
          {effects.map((effect,index)=><p key={index} className="rounded-md bg-gold/5 px-2.5 py-1.5 text-xs">
            <strong>{effect.name}</strong> · {effectLabel(effect,labels)}
            {effect.until_combat_end?" · até o fim do combate":effect.duration>0?` · ${effect.duration} turno(s)`:""}
          </p>)}
        </div>
      )}
      {continuous.length>0 && <div className="space-y-1.5">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-gold"><Activity className="h-3.5 w-3.5"/> Efeitos contínuos</p>
        {continuous.map((rule,index)=><div key={index} className="rounded-md bg-gold/5 px-2.5 py-2 text-xs">
          <strong>{rule.name}</strong>
          <p className="mt-1 text-muted-foreground">Gatilho: {rule.trigger==="target"?"turno do alvo":rule.trigger==="caster"?"turno do usuário":"turno global"}
            {rule.max_targets!==null?` · até ${rule.max_targets} alvo(s)`:""}
            {rule.linger_turns>0?` · resíduos: ${rule.linger_turns} turnos`:""}
          </p>
          {rule.actions.map((action,j)=><p key={j} className="mt-1">
            {action.kind==="status" ? `Acúmulo: ${action.attributes.map(a=>`${action.polarity==="debuff"?"−":"+"}${a.step}${a.mode==="percent"?"%":""} ${labels[a.key]??a.key}/turno`).join(", ")}`
              :action.kind==="damage" ? `Dano periódico: ${action.damage_source==="dice"?action.dice_expression:action.damage_source==="fixed"?action.fixed_damage+\" fixo\":action.attribute_percent+\"% de \"+(labels[action.attribute_key??""]??action.attribute_key)} (${action.damage_kind})`
              :action.kind==="dot"?"DoT registrado":"Efeito adicional"}
          </p>)}
        </div>)}
      </div>}
      {dots.length>0 && <p className="text-xs text-muted-foreground">DoTs de ataque: {dots.map(d=>d.name||"DoT").join(", ")}</p>}
    </div>
  </details>;
}

function SummonDetailsBody({details}: {details:CreatureDetails}) {
  const { data:defs=[] } = useDefs();
  const c=details.character;
  const {mods,race,virtue,classTrait}=useCharacterTraitMods(c.race_id,c.virtue_id,c.class_id,c.class_custom_modifiers);
  const byKey=new Map(details.attributes.map(a=>[a.attribute_key,a]));
  const passiveMods=passiveStatusModifiers(details.abilities.map(a=>({...a,
    passive_effects:parseAbilityEffects(a.passive_effects),
  })) as CharacterAbility[]);
  const statuses=details.effects.map(e=>({...e,character_id:c.id,battle_id:null,source_character_ability_id:null})) as ActiveCharacterEffect[];
  const labels=Object.fromEntries(defs.map(d=>[d.key,d.label]));
  const noMana=details.effects.some(e=>e.effect_type==="no_mana"&&e.polarity==="debuff");
  const values=defs.map(def=>{
    const attr=byKey.get(def.key);
    const traitBonus=mods[def.key]??0;
    const pts=(attr?.points??0)+(def.accepts_points?traitBonus+physicalAttributePoints(c,def.key):0);
    const normal=def.accepts_points ? computeValue(def,pts)+(attr?.bonus??0) :
      (attr?.max_value??0)+traitBonus+(attr?.bonus??0);
    const passive=passiveMods[def.key]??{fixed:0,percent:0};
    const active=statusEffectModifiers(statuses,def.key);
    const effective=conditionAdjustedValue(c,def.key,
      clampNonDefenseAttribute(def.key,Math.floor((normal+passive.fixed+active.fixed)*
        (1+(passive.percent+active.percent)/100))));
    const total=noMana&&def.key==="mana"?0:def.key==="hp"?Math.max(1,effective):effective;
    const current=noMana&&def.key==="mana"?0:conditionAdjustedValue(c,def.key,attr?.current_value??0);
    return {def,total,current};
  });
  const hp=values.find(row=>row.def.key==="hp");
  const mana=values.find(row=>row.def.key==="mana");
  const bars=[hp,mana].filter((row):row is NonNullable<typeof hp>=>!!row);
  return <div className="space-y-5">
    <div className="flex flex-wrap gap-2 text-[11px]">
      {race&&<span className="rounded-full border border-gold/25 px-2.5 py-1 text-gold">Raça: {race.name}</span>}
      {virtue&&<span className="rounded-full border border-gold/25 px-2.5 py-1 text-gold">Virtude: {virtue.name}</span>}
      {classTrait&&<span className="rounded-full border border-gold/25 px-2.5 py-1 text-gold">Classe: {classTrait.name}</span>}
    </div>
    {c.description&&<p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{c.description}</p>}
    <section className="space-y-2">
      <h3 className="font-display text-sm font-semibold text-gold">HP e Mana</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {bars.map(row=><div key={row.def.key} className="rounded-xl border border-gold/20 bg-background/50 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {row.def.key==="hp"?<Heart className="h-4 w-4 text-red-400"/>:<Waves className="h-4 w-4 text-blue-400"/>}
              {row.def.label}
            </span>
            <strong className="text-base tabular-nums">{row.current} / {row.total}</strong>
          </div>
          <StatBar value={row.current} max={row.total} tone={barTone(row.def.key)}/>
        </div>)}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {[["Corpo",c.body,"body"],["Sanidade",c.sanity,"sanity"]] .map(([label,value,key])=>
          <div key={String(key)} className="rounded-lg border border-border px-3 py-2 text-xs">
            <span className="text-muted-foreground">{label}:</span> <strong>{value}%</strong>
          </div>)}
      </div>
    </section>
    <section className="space-y-2">
      <h3 className="font-display text-sm font-semibold text-gold">Atributos</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {values.filter(row=>!row.def.show_bar).map(row=>
          <div key={row.def.key} className="min-w-0 rounded-lg border border-gold/20 bg-background/50 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-[10px] uppercase leading-snug text-muted-foreground">
              <AttrIcon name={row.def.icon} className="h-3.5 w-3.5 shrink-0 text-gold"/>{row.def.label}
            </p>
            <p className="mt-1 text-xl font-bold tabular-nums">{row.total}</p>
          </div>)}
      </div>
      {!details.is_active&&Object.keys(details.configured_stats??{}).length>0&&<div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs">
        <p className="font-semibold text-amber-300">Atributos personalizados ao invocar</p>
        <p className="mt-1 text-muted-foreground">Os números acima são da ficha de origem. Quando a criatura for invocada, serão considerados os valores configurados abaixo.</p>
        <p className="mt-2">{Object.entries(details.configured_stats).map(([key,value])=>`${labels[key]??key}: ${value}`).join(" · ")}</p>
      </div>}
    </section>
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 font-display text-sm font-semibold text-gold"><Shield className="h-4 w-4"/> Status e efeitos</h3>
      {details.effects.length===0?<p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">Nenhum efeito ativo nesta ficha.</p>
        :<div className="grid gap-2 sm:grid-cols-2">
          {details.effects.map(effect=><div key={effect.id} className="rounded-lg border border-border bg-background/50 px-3 py-2.5 text-xs">
            <p className={effect.polarity==="debuff"?"font-semibold text-red-300":"font-semibold text-emerald-400"}>{effect.name}</p>
            <p className="mt-0.5 text-muted-foreground">
              {effect.effect_type==="status" && effect.attribute_key
                ? `${labels[effect.attribute_key]??effect.attribute_key}: ${effect.polarity==="debuff"?"−":"+"}${effect.amount}${effect.value_mode==="percent"?"%":""} · `
                :""}
              {effect.is_sheet_permanent?"Permanente na ficha":effect.until_combat_end?"Até o fim do combate":`${effect.duration} turno(s)`}
            </p>
          </div>)}
        </div>}
    </section>
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 font-display text-sm font-semibold text-gold"><BookOpen className="h-4 w-4"/> Habilidades ({details.abilities.length})</h3>
      {details.abilities.length===0?<p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">A criatura não possui habilidades cadastradas.</p>
        :<div className="space-y-2">{details.abilities.map(skill=>
          <AbilityDetails key={skill.id} ability={skill} labels={labels}/>)}</div>}
    </section>
    <p className="flex items-start gap-1.5 rounded-lg border border-gold/20 bg-gold/5 p-3 text-[11px] text-muted-foreground">
      <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0"/>
      Somente leitura: habilidades e status podem ser consultados, mas não utilizados ou modificados aqui.
    </p>
  </div>;
}
export function SummonDetailsDialog({grantId,onClose}: {grantId:string|null;onClose:()=>void}) {
  const {data,isPending,error,refetch}=useQuery<CreatureDetails>({
    queryKey:["summon-details",grantId],enabled:!!grantId,
    queryFn:async()=>{
      const {data,error}=await db.rpc("get_summon_details",{_grant_id:grantId});
      if(error)throw error;
      if(!data||typeof data!=="object")throw new Error("Detalhes desta criatura não disponíveis.");
      return data as CreatureDetails;
    },
    staleTime:5000,refetchOnWindowFocus:"always",
  });
  return <Dialog open={grantId!==null} onOpenChange={open=>{if(!open)onClose();}}>
    <DialogContent className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-gold/40 bg-[#130e0b] p-0 sm:h-auto sm:max-h-[90dvh] sm:max-w-2xl sm:rounded-xl">
      <DialogHeader className="shrink-0 space-y-1 border-b border-gold/25 px-4 pb-3 pt-5 pr-12 text-left sm:px-6">
        <DialogTitle className="flex items-center gap-2 font-display text-xl text-gold"><Ghost className="h-5 w-5"/>{data?.name||"Detalhes da criatura"}</DialogTitle>
        <DialogDescription>
          {data?.is_active?"Invocação ativa · valores atuais em combate":"Ficha original da criatura · antes de invocar"} · Visualização do jogador
        </DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
        {isPending?<div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"><Sparkles className="h-4 w-4 animate-pulse"/> Carregando ficha da criatura…</div>
          :error?<div className="space-y-3 rounded-lg border border-red-500/40 p-4 text-sm text-red-300">
            <p>Não foi possível carregar os detalhes desta invocação.</p>
            <p className="text-xs">{error instanceof Error?error.message:"Tente novamente."}</p>
            <button type="button" className="min-h-10 rounded-md border border-red-500/30 px-3" onClick={()=>void refetch()}>Tentar novamente</button>
          </div>:data?<SummonDetailsBody details={data}/>:null}
      </div>
    </DialogContent>
  </Dialog>;
}
