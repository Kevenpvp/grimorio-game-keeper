import { useState } from "react";
import { Dices, Flame, Repeat2, ShieldCheck, Skull, Settings2, Hourglass } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  previewContinuousDamage, type ContinuousInstance, type ContinuousDecision, type ContinuousDamageAction,
} from "@/lib/continuous-effects";

type FormValue = { damage: string; damage_kind: "true" | "physical" | "magical"; neutralize: boolean; advanced: boolean };
function initial(items: ContinuousInstance[]): Record<string, FormValue> {
  return Object.fromEntries(items.map((item) => {
    const damage = item.rule.actions.find((entry): entry is ContinuousDamageAction => entry.kind === "damage");
    return [item.id,{
      damage:damage?String(previewContinuousDamage(damage)):"0",
      damage_kind:damage?.damage_kind??"true",neutralize:false,advanced:false,
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
  const patch=(id:string, partial:Partial<FormValue>)=>setValues(current=>({
    ...current,[id]:{...current[id],...partial},
  }));
  function submit(){
    const decisions:Record<string,ContinuousDecision>={};
    for(const item of items){
      const damage=item.rule.actions.find((entry):entry is ContinuousDamageAction=>entry.kind==="damage");
      const value=values[item.id];
      if(!value){return;}
      if(damage){
        const raw=value.damage.trim();
        const amount=Number(raw);
        if(!/^\d+$/.test(raw)||!Number.isSafeInteger(amount)||amount<0||amount>1000000)return;
        decisions[item.id]={damage:amount,damage_kind:value.damage_kind,neutralize:value.neutralize};
      }else decisions[item.id]={};
    }
    onConfirm(decisions);
  }
  const bad=items.some(item=>{
    const damage=item.rule.actions.some(action=>action.kind==="damage");
    if(!damage)return false;
    const raw=values[item.id]?.damage.trim()??"";
    return !/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>1000000;
  });
  return <Dialog open onOpenChange={(open)=>{if(!open&&!busy)onCancel();}}>
    <DialogContent className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-gold/40 bg-[#100c0a] p-0 sm:h-auto sm:max-h-[90dvh] sm:max-w-xl sm:rounded-xl">
      <DialogHeader className="shrink-0 space-y-1 border-b border-gold/25 px-4 pb-3 pt-5 pr-12 text-left sm:px-6">
        <DialogTitle className="flex items-center gap-2 font-display text-lg text-gold">
          <Repeat2 className="h-5 w-5"/> Confirmar efeitos do turno
        </DialogTitle>
        <DialogDescription className="text-xs">{title} · {items.length} efeito(s) aguardando resolução. O turno só avança após confirmar.</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
        {items.map(item=>{
          const damage=item.rule.actions.find((entry):entry is ContinuousDamageAction=>entry.kind==="damage");
          const stats=item.rule.actions.filter(a=>a.kind==="status");
          const value=values[item.id];
          return <article key={item.id} className="space-y-3 rounded-xl border border-gold/30 bg-[#1b130f] p-3">
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
            {item.rule.linger_turns>0&&<p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Hourglass className="h-4 w-4"/> Após interromper, os atributos afetados continuam por {item.rule.linger_turns} turno(s).
            </p>}
          </article>;
        })}
      </div>
      <div className="shrink-0 space-y-2 border-t border-gold/20 bg-[#100c0a] px-4 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-3 sm:flex sm:justify-end sm:gap-2 sm:space-y-0 sm:px-6 sm:pb-4">
        <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={busy} onClick={onCancel}>Cancelar</Button>
        <Button type="button" className="min-h-11 w-full sm:w-auto" disabled={busy||bad} onClick={submit}>
          {busy?"Aplicando…":"Confirmar efeitos e avançar turno"}
        </Button>
      </div>
    </DialogContent>
  </Dialog>;
}
