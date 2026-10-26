import { useState } from "react";
import { Dices, Flame, Repeat2, ShieldCheck, Skull, Settings2, Hourglass } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  previewContinuousDamage, type ContinuousInstance, type ContinuousDecision, type ContinuousDamageAction,
} from "@/lib/continuous-effects";

type FormValue = { damage: string; damage_kind: "true" | "physical" | "magical"; neutralize: boolean; advanced: boolean; resolution: "apply" | "skip" | "interrupt" | "dispel" };
function initial(items: ContinuousInstance[]): Record<string, FormValue> {
  return Object.fromEntries(items.map((item) => {
    const damage = item.rule.actions.find((entry): entry is ContinuousDamageAction => entry.kind === "damage");
    return [item.id,{
      damage:damage?String(previewContinuousDamage(damage)):"0",
      damage_kind:damage?.damage_kind??"true",neutralize:false,advanced:false,resolution:"apply",
    }];
  }));
}
export function ContinuousTurnDialog({ items, title, busy, fighterNames, onCancel, onConfirm }: {
  items: ContinuousInstance[];
  title: string;
  busy: boolean;
  fighterNames: Record<string,string>;
  onCancel: () => void;
  onConfirm: (decisions: Record<string,ContinuousDecision>) => void;
}) {
  const [values,setValues] = useState<Record<string,FormValue>>(()=>initial(items));
  const [expandedId,setExpandedId] = useState<string|null>(items[0]?.id??null);
  type ActionEdit = { skip:boolean; amount:string; duration:string; attributes:Record<string,string> };
  const [actionEdits,setActionEdits] = useState<Record<string,Record<string,ActionEdit>>>(()=>
    Object.fromEntries(items.map(item=>[item.id,Object.fromEntries(item.rule.actions.map((action,j)=>[
      String(j),{
        skip:false,
        amount:action.kind==="dot"?String(action.damage_amount):"",
        duration:action.kind==="dot"||action.kind==="effect"?String(action.duration):"",
        attributes:action.kind==="status"?Object.fromEntries(action.attributes.map(a=>[a.key,String(Math.min(a.cap,a.step*(item.ticks+1)))])):{},
      },
    ]))]))
  );
  const patchAction=(id:string,index:number,patch:Partial<ActionEdit>)=>setActionEdits(current=>({
    ...current,[id]:{...current[id],[String(index)]:{...current[id]?.[String(index)],...patch}},
  }));
  const patch=(id:string, partial:Partial<FormValue>)=>setValues(current=>({
    ...current,[id]:{...current[id],...partial},
  }));
  function submit(){
    const decisions:Record<string,ContinuousDecision>={};
    for(const item of items){
      const damage=item.rule.actions.find((entry):entry is ContinuousDamageAction=>entry.kind==="damage");
      const value=values[item.id];
      if(!value)return;
      if(value.resolution!=="apply"){
        decisions[item.id]={resolution:value.resolution};
        continue;
      }
      if(damage){
        const raw=value.damage.trim();
        const amount=Number(raw);
        if(!/^\d+$/.test(raw)||!Number.isSafeInteger(amount)||amount<0||amount>1000000)return;
        decisions[item.id]={damage:amount,damage_kind:value.damage_kind,neutralize:value.neutralize};
      }else decisions[item.id]={};
      const actions:NonNullable<ContinuousDecision["actions"]>={};
      for(let i=0;i<item.rule.actions.length;i++){
        const action=item.rule.actions[i];
        const edit=actionEdits[item.id]?.[String(i)];
        if(!edit)continue;
        if(edit.skip){actions[String(i)]={skip:true};continue;}
        if(action.kind==="dot" || action.kind==="effect"){
          const duration=Number(edit.duration);
          if(!/^\d+$/.test(edit.duration.trim())||!Number.isSafeInteger(duration)||duration<1||duration>1000)return;
          actions[String(i)]={duration};
          if(action.kind==="dot"){
            const amount=Number(edit.amount);
            if(!/^\d+$/.test(edit.amount.trim())||!Number.isSafeInteger(amount)||amount<1||amount>1000000)return;
            actions[String(i)].damage_amount=amount;
          }
        }
        if(action.kind==="status"){
          const attrs:Record<string,number>={};
          for(const attr of action.attributes){
            const raw=edit.attributes[attr.key]??"";
            const amount=Number(raw);
            if(!/^\d+$/.test(raw.trim())||!Number.isSafeInteger(amount)||amount<0||amount>1000000)return;
            attrs[attr.key]=amount;
          }
          actions[String(i)]={attributes:attrs};
        }
      }
      if(Object.keys(actions).length) decisions[item.id].actions=actions;
    }
    onConfirm(decisions);
  }
  const bad=items.some(item=>{
    if(values[item.id]?.resolution!=="apply")return false;
    const damage=item.rule.actions.some(action=>action.kind==="damage");
    if(damage){
      const raw=values[item.id]?.damage.trim()??"";
      if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>1000000)return true;
    }
    return item.rule.actions.some((action,index)=>{
      const edit=actionEdits[item.id]?.[String(index)];
      if(!edit || edit.skip || action.kind==="damage")return false;
      const integer=(raw:string,min:number,max:number)=>/^\d+$/.test(raw.trim()) && Number.isSafeInteger(Number(raw)) && Number(raw)>=min && Number(raw)<=max;
      if(action.kind==="status")return action.attributes.some(attr=>!integer(edit.attributes[attr.key]??"",0,1000000));
      if(!integer(edit.duration,1,1000))return true;
      return action.kind==="dot" && !integer(edit.amount,1,1000000);
    });
  });
  const applying = items.filter(item=>(values[item.id]?.resolution??"apply")==="apply");
  const ending = items.filter(item=>["interrupt","dispel"].includes(values[item.id]?.resolution??"apply"));
  const totalDamage = applying.reduce((sum,item)=>{
    const value=values[item.id];
    if(!item.rule.actions.some(action=>action.kind==="damage")||value?.neutralize)return sum;
    return sum+Math.max(0,Number(value?.damage)||0);
  },0);
  return <Dialog open onOpenChange={(open)=>{if(!open&&!busy)onCancel();}}>
    <DialogContent className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-gold/40 bg-[#100c0a] p-0 sm:h-auto sm:max-h-[90dvh] sm:max-w-xl sm:rounded-xl">
      <DialogHeader className="shrink-0 space-y-1 border-b border-gold/25 px-4 pb-3 pt-5 pr-12 text-left sm:px-6">
        <DialogTitle className="flex items-center gap-2 font-display text-lg text-gold">
          <Repeat2 className="h-5 w-5"/> Confirmar efeitos do turno
        </DialogTitle>
        <DialogDescription className="text-xs">{title} · {items.length} efeito(s) aguardando resolução. O turno só avança após confirmar.</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
        <div className="rounded-xl border border-gold/25 bg-gold/5 px-3 py-2.5">
          <p className="text-xs font-semibold text-gold">Resumo das ações deste turno</p>
          <p className="text-xs text-muted-foreground">{applying.length} aplicar · {ending.length} encerrar · {items.length-applying.length-ending.length} ignorar</p>
          <p className="mt-1 font-semibold text-sm text-foreground">Dano periódico previsto: {totalDamage}</p>
        </div>
        {items.map((item,index)=>{
          const damage=item.rule.actions.find((entry):entry is ContinuousDamageAction=>entry.kind==="damage");
          const stats=item.rule.actions.filter(a=>a.kind==="status");
          const value=values[item.id];
          const expanded=expandedId===item.id;
          const resolution=value?.resolution??"apply";
          return <article key={item.id} className={`rounded-xl border bg-[#1b130f] p-3 ${resolution==="dispel"?"border-emerald-500/40":resolution==="interrupt"?"border-amber-500/40":"border-gold/30"}`}>
            <button type="button" aria-expanded={expanded} aria-controls={"continuous-detail-"+item.id}
              className="flex min-h-12 w-full items-center justify-between gap-3 text-left" onClick={()=>setExpandedId(expanded?null:item.id)}>
              <div className="min-w-0">
                <p className="truncate font-display text-base font-semibold text-gold">{index+1}. {item.name}</p>
                <p className="truncate text-xs text-muted-foreground">{fighterNames[item.caster_character_id]??"Usuário"} → {fighterNames[item.target_character_id]??"Alvo"} · {item.ticks} acúmulo(s)</p>
                <p className="text-xs font-semibold ${resolution==="dispel"?"text-emerald-400":resolution==="interrupt"?"text-amber-400":"text-muted-foreground"}">
                  {resolution==="dispel"?"Dissipar completamente":resolution==="interrupt"?"Interromper com resíduos":resolution==="skip"?"Ignorar neste turno":(damage?"Dano "+(value?.neutralize?"neutralizado":value?.damage):"Aplicar acúmulo/efeitos")}
                </p>
              </div>
              <span className="shrink-0 text-sm font-semibold text-gold">{expanded?"Recolher ▲":"Editar ▼"}</span>
            </button>
            {expanded && <div id={"continuous-detail-"+item.id} className="space-y-3 border-t border-gold/15 pt-3">
            <label className="block space-y-1 text-xs font-semibold text-gold">
              O que fazer com este vínculo?
              <select aria-label={"Resolver "+item.name} className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                value={resolution} disabled={busy} onChange={e=>patch(item.id,{resolution:e.target.value as FormValue["resolution"]})}>
                <option value="apply">Aplicar efeitos normalmente</option>
                <option value="skip">Ignorar somente este turno</option>
                <option value="interrupt">Interromper vínculo (mantém penalidade residual)</option>
                <option value="dispel">Dissipar completamente (remove efeitos vinculados)</option>
              </select>
            </label>
            {resolution==="interrupt"&&<p className="text-xs text-amber-300">
              O efeito para de acumular, mas seus debuffs atuais permanecem por {item.rule.linger_turns} turno(s) individuais do alvo.
            </p>}
            {resolution==="dispel"&&<p className="text-xs text-emerald-300">
              O vínculo será cancelado e as penalidades e DoTs vinculados serão removidos.
            </p>}
            {resolution==="apply"&&<>
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="font-display text-base font-semibold text-gold">{item.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  <Skull className="mr-1 inline h-3 w-3"/> {fighterNames[item.caster_character_id]??"Caster"} → {fighterNames[item.target_character_id]??"Alvo"} · aplicação {item.ticks+1}
                </p>
              </div>
              <span className="rounded-full border border-gold/25 px-2 py-1 text-xs text-gold">{item.ticks} acúmulo(s)</span>
            </div>
            {stats.flatMap(a=>a.kind==="status"?a.attributes.map(row=>{
              const amount=Math.min(row.cap,row.step*(item.ticks+1));
              return <div key={row.key} className="flex items-center justify-between gap-2 rounded-md border border-gold/15 bg-black/20 px-3 py-2 text-xs">
                <span>{row.key}</span><strong className={a.polarity==="debuff"?"text-red-300":"text-emerald-300"}>
                  {a.polarity==="debuff"?"−":"+"}{amount}{row.mode==="percent"?"%":""}
                </strong>
              </div>;
            }):[])}
            {damage&&value&&<div className="space-y-3 rounded-lg border border-red-500/20 bg-red-950/10 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-red-300"><Flame className="mr-1 inline h-4 w-4"/> Dano periódico · {damage.dice_count}d{damage.dice_sides}{damage.flat?(" + "+damage.flat):""}</p>
                <Button type="button" size="sm" variant="outline" className="min-h-10" disabled={busy}
                  onClick={()=>patch(item.id,{damage:String(previewContinuousDamage(damage))})}><Dices className="mr-1 h-4 w-4"/> Rolar</Button>
              </div>
              <label className="block space-y-1 text-xs">Valor de dano deste turno
                <Input type="number" inputMode="numeric" min={0} max={1000000} step={1} className="min-h-11" disabled={busy}
                  value={value.damage} onChange={e=>patch(item.id,{damage:e.target.value})}/>
              </label>
              {damage.neutralizable&&<label className="flex min-h-11 items-center gap-2 text-xs">
                <input type="checkbox" disabled={busy} checked={value.neutralize} onChange={e=>patch(item.id,{neutralize:e.target.checked})}/>
                <ShieldCheck className="h-4 w-4 text-emerald-400"/> Neutralizar dano com Luz/Divino
              </label>}
              <button type="button" className="flex min-h-10 w-full items-center gap-2 text-xs font-semibold text-gold"
                onClick={()=>patch(item.id,{advanced:!value.advanced})}>
                <Settings2 className="h-4 w-4"/> {value.advanced?"Ocultar configurações avançadas":"Configurações avançadas"}
              </button>
              {value.advanced&&<label className="block space-y-1 text-xs">Tipo de dano somente neste turno
                <select className="min-h-11 w-full rounded-lg border border-input bg-background px-3" disabled={busy}
                  value={value.damage_kind} onChange={e=>patch(item.id,{damage_kind:e.target.value as FormValue["damage_kind"]})}>
                  <option value="true">Verdadeiro</option><option value="physical">Físico</option><option value="magical">Mágico</option>
                </select>
              </label>}
              <p className="text-xs text-muted-foreground">Dano final: {value.neutralize?0:Math.max(0,Number(value.damage)||0)} (antes das proteções aplicáveis).</p>
            </div>}
            {item.rule.actions.map((action,index)=>{
              if(action.kind==="damage")return null;
              const edit=actionEdits[item.id]?.[String(index)];
              if(!edit)return null;
              return <details key={index} className="rounded-lg border border-gold/20 bg-black/20 p-2.5">
                <summary className="min-h-10 cursor-pointer py-2 text-xs font-semibold text-gold">
                  <Settings2 className="mr-1 inline h-3.5 w-3.5"/>
                  {action.kind==="status"?"Modificar atributos":"Editar "+(action.kind==="dot"?"DoT":"efeito")+" deste turno"}
                </summary>
                <div className="mt-2 space-y-3 border-t border-gold/10 pt-3">
                  <label className="flex min-h-11 items-center gap-2 text-xs">
                    <input type="checkbox" checked={edit.skip} disabled={busy}
                      onChange={e=>patchAction(item.id,index,{skip:e.target.checked})}/>
                    Não aplicar esta ação neste turno
                  </label>
                  {action.kind==="status"&&action.attributes.map(attr=>(
                    <label key={attr.key} className="flex items-center justify-between gap-2 text-xs">
                      <span>{attr.key} ({attr.mode==="percent"?"%":"pontos"})</span>
                      <Input className="h-11 w-28 text-right" inputMode="numeric" type="number" min={0} max={1000000}
                        disabled={busy||edit.skip} value={edit.attributes[attr.key]??"0"}
                        onChange={e=>patchAction(item.id,index,{attributes:{...edit.attributes,[attr.key]:e.target.value}})}/>
                    </label>
                  ))}
                  {(action.kind==="dot"||action.kind==="effect")&&<label className="flex items-center justify-between gap-2 text-xs">
                    Duração neste turno
                    <Input className="h-11 w-28 text-right" inputMode="numeric" type="number" min={1} max={1000}
                      disabled={busy||edit.skip} value={edit.duration} onChange={e=>patchAction(item.id,index,{duration:e.target.value})}/>
                  </label>}
                  {action.kind==="dot"&&<label className="flex items-center justify-between gap-2 text-xs">
                    Dano do DoT
                    <Input className="h-11 w-28 text-right" inputMode="numeric" type="number" min={1} max={1000000}
                      disabled={busy||edit.skip} value={edit.amount} onChange={e=>patchAction(item.id,index,{amount:e.target.value})}/>
                  </label>}
                </div>
              </details>;
            })}
            {item.rule.linger_turns>0&&<p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Hourglass className="h-4 w-4"/> Ao soltar, os atributos ficam por {item.rule.linger_turns} turno(s) individuais do alvo.
            </p>}
            </>}
            </div>}
          </article>;
        })}
      </div>
      <div className="sticky bottom-0 shrink-0 space-y-2 border-t border-gold/20 bg-[#100c0a] px-4 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-3 sm:flex sm:justify-end sm:gap-2 sm:space-y-0 sm:px-6 sm:pb-4">
        <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={busy} onClick={onCancel}>Cancelar</Button>
        <Button type="button" className="min-h-11 w-full sm:w-auto" disabled={busy||bad} onClick={submit}>
          {busy?"Aplicando…":"Confirmar efeitos e avançar turno"}
        </Button>
      </div>
    </DialogContent>
  </Dialog>;
}
