import { useState } from "react";
import { Copy, Flame, Repeat2, ShieldCheck, Skull, Settings2, Hourglass } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { continuousDamageAdjusted, continuousDamageExpression,
  type ContinuousInstance, type ContinuousDecision, type ContinuousDamageAction,
  type ContinuousActionDecision } from "@/lib/continuous-effects";

type DamageEntry = {
  damage: string; advanced: boolean; neutralize: boolean;
  kind: "true" | "physical" | "magical";
  fixed: string; percent: string;
  physicalFixed: string; physicalPercent: string;
  magicalFixed: string; magicalPercent: string;
  damageTypeId: string; physicalTypeId: string; magicLevel: "baixa" | "media" | "alta";
};
type ActionEdit = {
  skip: boolean; amount: string; duration: string; attributes: Record<string,string>;
  damage?: DamageEntry;
};
type FormValue = { resolution: "apply" | "skip" | "interrupt" | "dispel" };
const intValid=(raw:string,min:number,max:number)=>/^-?\d+$/.test(raw.trim())
  && Number.isSafeInteger(Number(raw)) && Number(raw)>=min && Number(raw)<=max;
const percentValid=(raw:string,min:number,max:number)=>raw.trim()!=="" &&
  Number.isFinite(Number(raw)) && Number(raw)>=min && Number(raw)<=max;
function defaultDamage(action:ContinuousDamageAction, stats:Record<string,number>):DamageEntry {
  const base=action.damage_source==="fixed" ? action.fixed_damage
    : action.damage_source==="attribute" && action.attribute_key ?
      Math.max(0,Math.floor((stats[action.attribute_key]??0)*action.attribute_percent/100 + action.fixed_damage)) : null;
  return {
    damage:base===null?"":String(base), advanced:false, neutralize:false,
    kind:action.damage_kind,fixed:"0",percent:"0",
    physicalFixed:"0",physicalPercent:"0",magicalFixed:"0",magicalPercent:"0",
    damageTypeId:action.damage_type_id??"",physicalTypeId:action.physical_damage_type_id??"",
    magicLevel:action.magic_level,
  };
}
export function ContinuousTurnDialog({items,title,busy,fighterNames,casterAttributes,damageTypes,onCancel,onConfirm}:{
  items:ContinuousInstance[]; title:string; busy:boolean;
  fighterNames:Record<string,string>;
  casterAttributes:Record<string,Record<string,number>>;
  damageTypes:Array<{id:string;name:string;category:"physical"|"magical"}>;
  onCancel:()=>void; onConfirm:(decisions:Record<string,ContinuousDecision>)=>void;
}){
  const [values,setValues]=useState<Record<string,FormValue>>(()=>
    Object.fromEntries(items.map(item=>[item.id,{resolution:"apply"}])));
  const [expandedId,setExpandedId]=useState<string|null>(items[0]?.id??null);
  const [actionEdits,setActionEdits]=useState<Record<string,Record<string,ActionEdit>>>(()=>
    Object.fromEntries(items.map(item=>[
      item.id,Object.fromEntries(item.rule.actions.map((action,j)=>[
        String(j),{
          skip:false,
          amount:action.kind==="dot"?String(action.damage_amount):"",
          duration:action.kind==="dot"||action.kind==="effect"?String(action.duration):"",
          attributes:action.kind==="status"?Object.fromEntries(action.attributes.map(a=>[
            a.key,String(Math.min(a.cap,a.step*(item.ticks+1)))
          ])):{},
          damage:action.kind==="damage"?defaultDamage(action,casterAttributes[item.caster_character_id]??{}):undefined,
        },
      ])),
    ])));
  const patch=(id:string,partial:Partial<FormValue>)=>
    setValues(v=>({...v,[id]:{...v[id],...partial}}));
  const patchAction=(id:string,index:number,partial:Partial<ActionEdit>)=>
    setActionEdits(v=>({...v,[id]:{...v[id],[String(index)]:{...v[id]?.[String(index)],...partial}}}));
  const patchDamage=(id:string,index:number,partial:Partial<DamageEntry>)=>
    setActionEdits(v=>{
      const current=v[id]?.[String(index)];
      if(!current?.damage)return v;
      return {...v,[id]:{...v[id],[String(index)]:{...current,damage:{...current.damage,...partial}}}};
    });
  const predictedDamage=(item:ContinuousInstance):number=>item.rule.actions.reduce((sum,action,index)=>{
    if(action.kind!=="damage")return sum;
    const edit=actionEdits[item.id]?.[String(index)], d=edit?.damage;
    if(edit?.skip || !d || d.neutralize || !intValid(d.damage,0,1_000_000)
      || !intValid(d.fixed,-1_000_000,1_000_000) || !percentValid(d.percent,-100,1000))return sum;
    return sum+continuousDamageAdjusted(Number(d.damage),Number(d.fixed),Number(d.percent));
  },0);
  const invalid=items.some(item=>{
    if(values[item.id]?.resolution!=="apply")return false;
    return item.rule.actions.some((action,index)=>{
      const edit=actionEdits[item.id]?.[String(index)];
      if(!edit || edit.skip)return false;
      if(action.kind==="status")return action.attributes.some(a=>!intValid(edit.attributes[a.key]??"",0,1_000_000));
      if(action.kind==="damage"){
        const d=edit.damage;
        if(!d || !intValid(d.damage,0,1_000_000)
          || !intValid(d.fixed,-1_000_000,1_000_000)
          || !percentValid(d.percent,-100,1000))return true;
        const ignores=[d.physicalFixed,d.magicalFixed].every(v=>intValid(v,0,1_000_000))
          && [d.physicalPercent,d.magicalPercent].every(v=>percentValid(v,0,100));
        return !ignores || (d.kind==="magical" && !d.damageTypeId);
      }
      if(!intValid(edit.duration,1,1000))return true;
      return action.kind==="dot" && !intValid(edit.amount,1,1_000_000);
    });
  });
  function submit(){
    if(invalid)return;
    const decisions:Record<string,ContinuousDecision>={};
    for(const item of items){
      const resolution=values[item.id]?.resolution??"apply";
      if(resolution!=="apply"){decisions[item.id]={resolution};continue;}
      const actions:NonNullable<ContinuousDecision["actions"]>={};
      for(const [index,action] of item.rule.actions.entries()){
        const edit=actionEdits[item.id]?.[String(index)];
        if(!edit)continue;
        if(edit.skip){actions[index]={skip:true};continue;}
        if(action.kind==="damage"){
          const d=edit.damage!;
          actions[index]={
            damage:Number(d.damage),damage_kind:d.kind,
            damage_type_id:d.damageTypeId||null,physical_damage_type_id:d.physicalTypeId||null,
            magic_level:d.magicLevel,neutralize:d.neutralize,
            fixed_adjustment:Number(d.fixed),percent_adjustment:Number(d.percent),
            defense_ignore:{
              physical_fixed:Number(d.physicalFixed),physical_percent:Number(d.physicalPercent),
              magical_fixed:Number(d.magicalFixed),magical_percent:Number(d.magicalPercent),
            },
          };
        }else if(action.kind==="status"){
          actions[index]={attributes:Object.fromEntries(action.attributes.map(a=>[
            a.key,Number(edit.attributes[a.key]),
          ]))};
        }else{
          actions[index]={duration:Number(edit.duration)};
          if(action.kind==="dot")actions[index].damage_amount=Number(edit.amount);
        }
      }
      decisions[item.id]={resolution,actions};
    }
    onConfirm(decisions);
  }
  const active=items.filter(item=>(values[item.id]?.resolution??"apply")==="apply");
  const ending=items.filter(item=>["interrupt","dispel"].includes(values[item.id]?.resolution??"apply"));
  const total=active.reduce((sum,item)=>sum+predictedDamage(item),0);
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onCancel();}}>
    <DialogContent className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-gold/40 bg-[#100c0a] p-0 sm:h-auto sm:max-h-[90dvh] sm:max-w-xl sm:rounded-xl">
      <DialogHeader className="shrink-0 space-y-1 border-b border-gold/25 px-4 pb-3 pt-5 pr-12 text-left sm:px-6">
        <DialogTitle className="flex items-center gap-2 font-display text-lg text-gold">
          <Repeat2 className="h-5 w-5"/> Confirmar efeitos do turno
        </DialogTitle>
        <DialogDescription className="text-xs">{title} · {items.length} efeito(s). O turno só avança após a confirmação.</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
        <div className="rounded-xl border border-gold/25 bg-gold/5 px-3 py-2.5">
          <p className="text-xs font-semibold text-gold">Resumo antes de avançar</p>
          <p className="text-xs text-muted-foreground">
            {active.length} aplicar · {ending.length} encerrar · {items.length-active.length-ending.length} ignorar
          </p>
          <p className="mt-1 text-sm font-semibold">Dano bruto previsto: {total} <span className="font-normal text-muted-foreground">(antes de defesas e outros efeitos)</span></p>
        </div>
        {items.map((item,i)=>{
          const expanded=expandedId===item.id;
          const resolution=values[item.id]?.resolution??"apply";
          return <article key={item.id} className="rounded-xl border border-gold/30 bg-[#1b130f] p-3">
            <button type="button" aria-expanded={expanded} className="flex min-h-12 w-full items-center justify-between gap-3 text-left"
              onClick={()=>setExpandedId(expanded?null:item.id)}>
              <div className="min-w-0">
                <p className="truncate font-display text-base font-semibold text-gold">{i+1}. {item.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {fighterNames[item.caster_character_id]??"Usuário"} → {fighterNames[item.target_character_id]??"Alvo"} · {item.ticks} acúmulo(s)
                </p>
                <p className="text-xs font-semibold text-muted-foreground">
                  {resolution==="dispel"?"Dissipar completamente":resolution==="interrupt"?"Interromper com resíduos":
                  resolution==="skip"?"Ignorar neste turno":`Aplicar · ${predictedDamage(item)} dano bruto previsto`}
                </p>
              </div>
              <span className="shrink-0 text-sm font-semibold text-gold">{expanded?"Recolher ▲":"Editar ▼"}</span>
            </button>
            {expanded && <div className="space-y-3 border-t border-gold/15 pt-3">
              <label className="block space-y-1 text-xs font-semibold text-gold">Resolver vínculo
                <select className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                  disabled={busy} value={resolution} onChange={e=>patch(item.id,{resolution:e.target.value as FormValue["resolution"]})}>
                  <option value="apply">Aplicar normalmente</option><option value="skip">Ignorar neste turno</option>
                  <option value="interrupt">Interromper (manter resíduos)</option>
                  <option value="dispel">Dissipar completamente</option>
                </select>
              </label>
              {resolution==="interrupt" && <p className="text-xs text-amber-300">Debuffs residuais permanecem por {item.rule.linger_turns} turnos da vítima.</p>}
              {resolution==="dispel" && <p className="text-xs text-emerald-300">Remove o vínculo e os efeitos vinculados.</p>}
              {resolution==="apply" && <>
                {item.rule.actions.map((action,index)=>{
                  const edit=actionEdits[item.id]?.[String(index)];
                  if(!edit)return null;
                  const d=edit.damage;
                  return <section key={index} className="space-y-3 rounded-lg border border-gold/20 bg-black/20 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-gold">
                        {action.kind==="damage"?"Dano periódico":action.kind==="status"?"Acúmulo de atributos":action.kind==="dot"?"DoT cadastrado":"Efeito adicional"}
                      </span>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input type="checkbox" disabled={busy} checked={edit.skip}
                          onChange={e=>patchAction(item.id,index,{skip:e.target.checked})}/> Ignorar
                      </label>
                    </div>
                    {!edit.skip && action.kind==="damage" && d && <>
                      {action.damage_source==="dice" && <div className="space-y-2 rounded-lg border border-gold/25 bg-gold/5 p-3">
                        <p className="text-xs text-muted-foreground">Rode este dado no Discord e informe o resultado abaixo:</p>
                        <div className="flex items-center justify-between gap-2">
                          <strong className="font-display text-xl text-gold">{continuousDamageExpression(action)||"Dado não configurado"}</strong>
                          <Button type="button" variant="outline" size="sm" className="min-h-10"
                            onClick={()=>{void navigator.clipboard.writeText(continuousDamageExpression(action)).then(
                              ()=>toast.success("Dado copiado para o Discord"),
                              ()=>toast.error("Não foi possível copiar o dado"),
                            );}}>
                            <Copy className="mr-1 h-4 w-4"/> Copiar
                          </Button>
                        </div>
                      </div>}
                      {action.damage_source==="attribute" && <p className="text-xs text-muted-foreground">
                        Base sugerida: {action.attribute_percent}% de {action.attribute_key??"atributo"} + {action.fixed_damage} fixo.
                        O mestre pode corrigir o valor antes de confirmar.
                      </p>}
                      <label className="block space-y-1 text-xs font-semibold">
                        {action.damage_source==="dice"?"Resultado rolado no Discord":"Dano base deste turno"}
                        <Input type="number" inputMode="numeric" min={0} max={1000000} step={1}
                          placeholder="Informe o resultado" className="min-h-11" disabled={busy}
                          value={d.damage} onChange={e=>patchDamage(item.id,index,{damage:e.target.value})}/>
                      </label>
                      {action.neutralizable && <label className="flex min-h-11 items-center gap-2 text-xs">
                        <input type="checkbox" checked={d.neutralize} disabled={busy}
                          onChange={e=>patchDamage(item.id,index,{neutralize:e.target.checked})}/>
                        <ShieldCheck className="h-4 w-4 text-emerald-400"/> Neutralizar dano neste turno (Luz/Divino)
                      </label>}
                      <button type="button" className="flex min-h-11 w-full items-center gap-2 border-t border-gold/15 pt-2 text-xs font-semibold text-gold"
                        onClick={()=>patchDamage(item.id,index,{advanced:!d.advanced})}>
                        <Settings2 className="h-4 w-4"/>{d.advanced?"Recolher opções avançadas":"Ajustes avançados de dano e defesa"}
                      </button>
                      {d.advanced && <div className="space-y-3 rounded-lg border border-gold/25 p-3">
                        <div className="grid grid-cols-2 gap-2">
                          <label className="block space-y-1 text-xs">Dano extra ou redução (± fixo)
                            <Input type="number" inputMode="numeric" min={-1000000} max={1000000} step={1}
                              value={d.fixed} disabled={busy} className="min-h-11"
                              onChange={e=>patchDamage(item.id,index,{fixed:e.target.value})}/>
                          </label>
                          <label className="block space-y-1 text-xs">Aumentar/reduzir dano (%)
                            <Input type="number" inputMode="decimal" min={-100} max={1000} step="any"
                              value={d.percent} disabled={busy} className="min-h-11"
                              onChange={e=>patchDamage(item.id,index,{percent:e.target.value})}/>
                          </label>
                        </div>
                        <label className="block space-y-1 text-xs">Tipo de dano deste turno
                          <select value={d.kind} className="min-h-11 w-full rounded-lg border border-input bg-background px-2 text-sm" disabled={busy}
                            onChange={e=>patchDamage(item.id,index,{kind:e.target.value as DamageEntry["kind"]})}>
                            <option value="true">Verdadeiro</option><option value="physical">Físico</option><option value="magical">Mágico</option>
                          </select>
                        </label>
                        {d.kind==="magical" && <div className="grid gap-2 sm:grid-cols-2">
                          <label className="space-y-1 text-xs">Tipo mágico
                            <select value={d.damageTypeId} disabled={busy} className="min-h-11 w-full rounded-lg border border-input bg-background px-2 text-sm"
                              onChange={e=>patchDamage(item.id,index,{damageTypeId:e.target.value})}>
                              <option value="">Selecionar tipo…</option>
                              {damageTypes.filter(t=>t.category==="magical").map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                          </label>
                          <label className="space-y-1 text-xs">Grau da magia
                            <select value={d.magicLevel} disabled={busy} className="min-h-11 w-full rounded-lg border border-input bg-background px-2 text-sm"
                              onChange={e=>patchDamage(item.id,index,{magicLevel:e.target.value as DamageEntry["magicLevel"]})}>
                              <option value="baixa">Baixa</option><option value="media">Média</option><option value="alta">Alta</option>
                            </select>
                          </label>
                        </div>}
                        {d.kind==="physical" && <label className="block space-y-1 text-xs">Tipo físico (opcional)
                          <select value={d.physicalTypeId} disabled={busy} className="min-h-11 w-full rounded-lg border border-input bg-background px-2 text-sm"
                            onChange={e=>patchDamage(item.id,index,{physicalTypeId:e.target.value})}>
                            <option value="">Físico normal</option>
                            {damageTypes.filter(t=>t.category==="physical").map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                        </label>}
                        {d.kind!=="true" && <div className="space-y-2 rounded-lg border border-gold/20 p-2">
                          <p className="text-xs font-semibold text-gold">Ignorar defesa adicional neste turno</p>
                          <div className="grid grid-cols-2 gap-2">
                            {([
                              ["physicalPercent","Defesa física (%)",100],
                              ["physicalFixed","Defesa física (valor)",1000000],
                              ["magicalPercent","Defesa mágica (%)",100],
                              ["magicalFixed","Defesa mágica (valor)",1000000],
                            ] as const).map(([key,label,max])=>
                              <label key={key} className="block space-y-1 text-xs">{label}
                                <Input type="number" min={0} max={max} step={1} inputMode="numeric"
                                  disabled={busy} value={d[key]} className="min-h-11"
                                  onChange={e=>patchDamage(item.id,index,{[key]:e.target.value})}/>
                              </label>)}
                          </div>
                          <p className="text-[11px] text-muted-foreground">A defesa nunca fica negativa por ignorá-la. Dano verdadeiro já ignora Defesa.</p>
                        </div>}
                      </div>}
                      <p className="text-xs text-muted-foreground">
                        {d.damage.trim()? "Dano ajustado antes de Defesa: "+(d.neutralize?0:
                          continuousDamageAdjusted(Number(d.damage)||0,Number(d.fixed)||0,Number(d.percent)||0))
                          : "Aguardando o resultado do dado no Discord"}
                      </p>
                    </>}
                    {!edit.skip && action.kind==="status" && action.attributes.map(a=>(
                      <label key={a.key} className="flex items-center justify-between gap-2 text-xs">
                        <span>{a.key} ({a.mode==="percent"?"%":"pontos"})</span>
                        <Input type="number" min={0} max={1000000} inputMode="numeric" className="h-11 w-28 text-right"
                          disabled={busy} value={edit.attributes[a.key]??"0"}
                          onChange={e=>patchAction(item.id,index,{attributes:{...edit.attributes,[a.key]:e.target.value}})}/>
                      </label>
                    ))}
                    {!edit.skip && (action.kind==="dot"||action.kind==="effect") && <label className="flex items-center justify-between gap-2 text-xs">
                      Duração
                      <Input type="number" min={1} max={1000} className="h-11 w-28 text-right" disabled={busy}
                        value={edit.duration} onChange={e=>patchAction(item.id,index,{duration:e.target.value})}/>
                    </label>}
                    {!edit.skip && action.kind==="dot" && <label className="flex items-center justify-between gap-2 text-xs">
                      Dano do DoT
                      <Input type="number" min={1} max={1000000} className="h-11 w-28 text-right" disabled={busy}
                        value={edit.amount} onChange={e=>patchAction(item.id,index,{amount:e.target.value})}/>
                    </label>}
                  </section>;
                })}
                {item.rule.linger_turns>0 && <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Hourglass className="h-4 w-4"/> Ao soltar, os atributos permanecem por {item.rule.linger_turns} turnos da vítima.
                </p>}
              </>}
            </div>}
          </article>;
        })}
      </div>
      <div className="sticky bottom-0 shrink-0 space-y-2 border-t border-gold/20 bg-[#100c0a] px-4 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-3 sm:flex sm:justify-end sm:gap-2 sm:space-y-0 sm:px-6 sm:pb-4">
        <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={busy} onClick={onCancel}>Cancelar</Button>
        <Button type="button" className="min-h-11 w-full sm:w-auto" disabled={busy||invalid} onClick={submit}>
          {busy?"Aplicando…":"Confirmar efeitos e avançar turno"}
        </Button>
      </div>
    </DialogContent>
  </Dialog>;
}
