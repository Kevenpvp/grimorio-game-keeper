import { Plus, Trash2, Repeat2, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  defaultContinuousRule, type ContinuousAction, type ContinuousRule,
  type ContinuousStatusAction, type ContinuousDamageAction,
} from "@/lib/continuous-effects";

type Def = { key: string; label: string };
export function ContinuousRulesEditor({ rules, onChange, defs, disabled = false }: {
  rules: ContinuousRule[]; onChange: (next: ContinuousRule[]) => void;
  defs: Def[]; disabled?: boolean;
}) {
  function changeRule(i: number, patch: Partial<ContinuousRule>) {
    onChange(rules.map((rule, index) => index === i ? { ...rule, ...patch } : rule));
  }
  function changeAction(i: number, j: number, action: ContinuousAction) {
    changeRule(i, { actions: rules[i].actions.map((entry, index) => index === j ? action : entry) });
  }
  const numberValue = (raw: string, max = 1_000_000) => {
    const n = Number(raw); return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.trunc(n))) : 0;
  };
  return (
    <section className="panel space-y-3 border-gold/30 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 font-display text-lg text-gold"><Repeat2 className="h-5 w-5" /> Efeitos contínuos</h3>
          <p className="mt-1 max-w-xl text-xs text-muted-foreground">
            Configure efeitos por turno sem escrever scripts. Em combate, o mestre confirma o dano antes de avançar.
          </p>
        </div>
        <Button variant="outline" size="sm" className="min-h-11" disabled={disabled || rules.length >= 20}
          onClick={() => onChange([...rules, defaultContinuousRule()])}>
          <Plus className="mr-1 h-4 w-4" /> Nova regra
        </Button>
      </div>
      {rules.length === 0 && <p className="rounded-lg border border-dashed border-gold/25 p-3 text-xs text-muted-foreground">
        Nenhuma regra contínua. Habilidades normais continuarão funcionando sem janela de confirmação.
      </p>}
      <div className="space-y-3">
        {rules.map((rule, i) => (
          <details key={i} className="rounded-xl border border-gold/35 bg-[#0f0b09]/80 p-3" open={i === rules.length - 1 ? undefined : undefined}>
            <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 font-semibold text-gold">
              <span className="flex min-w-0 items-center gap-2"><GripVertical className="h-4 w-4 shrink-0" /><span className="truncate">{rule.name}</span></span>
              <span className="shrink-0 rounded-full bg-gold/10 px-2 py-1 text-xs">{rule.actions.length} ação(ões)</span>
            </summary>
            <div className="space-y-4 border-t border-gold/15 pt-3">
              <label className="block space-y-1 text-xs font-semibold">Nome da regra
                <Input className="min-h-11" disabled={disabled} value={rule.name} maxLength={140}
                  onChange={(e) => changeRule(i, { name: e.target.value })} />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs font-semibold">Executar quando
                  <select className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                    disabled={disabled} value={rule.trigger}
                    onChange={(e) => changeRule(i, { trigger: e.target.value as ContinuousRule["trigger"] })}>
                    <option value="target">Avançar turno do afetado</option>
                    <option value="caster">Avançar turno do usuário</option>
                    <option value="global">Avançar turno global</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs font-semibold">Penalidade residual após interromper (turnos)
                  <Input className="min-h-11" type="number" min={0} max={1000} disabled={disabled}
                    value={rule.linger_turns}
                    onChange={(e) => changeRule(i, { linger_turns: numberValue(e.target.value, 1000) })}/>
                </label>
              </div>
              {rule.actions.map((action, j) => (
                <div key={j} className="space-y-3 rounded-lg border border-gold/20 bg-background/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-bold text-gold">{action.kind === "status" ? "Acumular Buff/Debuff" : "Dano periódico"}</span>
                    <Button variant="ghost" size="sm" className="min-h-10 text-red-300" disabled={disabled || rule.actions.length===1}
                      onClick={() => changeRule(i, { actions: rule.actions.filter((_, id) => id !== j) })}>
                      <Trash2 className="mr-1 h-4 w-4" /> Remover ação
                    </Button>
                  </div>
                  {action.kind === "status" ? <>
                    <label className="block space-y-1 text-xs">Tipo
                      <select className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                        value={action.polarity} disabled={disabled}
                        onChange={(e) => changeAction(i,j,{...action,polarity:e.target.value as ContinuousStatusAction["polarity"]})}>
                        <option value="debuff">Debuff (−)</option><option value="buff">Buff (+)</option>
                      </select>
                    </label>
                    <p className="text-xs text-muted-foreground">A cada turno aumenta o bônus ou a penalidade. O limite impede acumulação infinita.</p>
                    {action.attributes.map((a,k) => (
                      <div key={k} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-lg border border-border p-2 sm:grid-cols-[minmax(0,1fr)_minmax(70px,110px)_minmax(70px,110px)_auto]">
                        <label className="min-w-0 space-y-1 text-[11px]">Atributo
                          <select className="min-h-11 w-full rounded-md border border-input bg-background px-2 text-xs" value={a.key} disabled={disabled}
                            onChange={(e) => changeAction(i,j,{...action,attributes:action.attributes.map((v,n)=>n===k?{...v,key:e.target.value}:v)})}>
                            {defs.map(d=><option key={d.key} value={d.key}>{d.label}</option>)}
                          </select>
                        </label>
                        <Button variant="ghost" size="icon" className="h-11 w-10 self-end text-red-300 sm:order-last" disabled={disabled || action.attributes.length === 1}
                          aria-label="Remover atributo" onClick={() => changeAction(i,j,{...action,attributes:action.attributes.filter((_,n)=>n!==k)})}>
                          <Trash2 className="h-4 w-4"/>
                        </Button>
                        <label className="space-y-1 text-[11px]">Por turno
                          <Input type="number" min={0} max={1_000_000} step={1} className="min-h-11" disabled={disabled} value={a.step}
                            onChange={(e) => changeAction(i,j,{...action,attributes:action.attributes.map((v,n)=>n===k?{...v,step:numberValue(e.target.value)}:v)})}/>
                        </label>
                        <label className="space-y-1 text-[11px]">Máximo
                          <Input type="number" min={0} max={1_000_000} step={1} className="min-h-11" disabled={disabled} value={a.cap}
                            onChange={(e) => changeAction(i,j,{...action,attributes:action.attributes.map((v,n)=>n===k?{...v,cap:numberValue(e.target.value)}:v)})}/>
                        </label>
                        <label className="col-span-2 flex items-center gap-2 text-xs sm:col-span-4">Modo de {defs.find(d=>d.key===a.key)?.label ?? a.key}
                          <select className="min-h-10 rounded-md border border-input bg-background px-2" disabled={disabled} value={a.mode}
                            onChange={(e) => changeAction(i,j,{...action,attributes:action.attributes.map((v,n)=>n===k?{...v,mode:e.target.value as typeof v.mode}:v)})}>
                            <option value="percent">Porcentagem (%)</option><option value="fixed">Pontos fixos</option>
                          </select>
                        </label>
                      </div>
                    ))}
                    <select value="" className="min-h-11 w-full rounded-lg border border-gold/25 bg-background px-3 text-sm" disabled={disabled}
                      aria-label="Adicionar atributo ao acúmulo"
                      onChange={(e) => {if(e.target.value)changeAction(i,j,{...action,attributes:[...action.attributes,{key:e.target.value,mode:"percent",step:5,cap:100}]});}}>
                      <option value="">+ Adicionar outro atributo…</option>
                      {defs.filter(d=>!action.attributes.some(a=>a.key===d.key)).map(d=><option key={d.key} value={d.key}>{d.label}</option>)}
                    </select>
                  </> : <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {([
                        ["Dados", "dice_count", 20], ["Faces", "dice_sides", 1000], ["Bônus fixo", "flat", 1000000],
                      ] as const).map(([label,key,max])=>(
                        <label key={key} className="space-y-1 text-xs">{label}
                          <Input type="number" min={key==="dice_sides"?1:0} max={max} className="min-h-11" disabled={disabled}
                            value={action[key]} onChange={(e)=>changeAction(i,j,{...action,[key]:numberValue(e.target.value,max)})}/>
                        </label>
                      ))}
                    </div>
                    <label className="block space-y-1 text-xs">Tipo de dano padrão
                      <select className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                        disabled={disabled} value={action.damage_kind}
                        onChange={(e)=>changeAction(i,j,{...action,damage_kind:e.target.value as ContinuousDamageAction["damage_kind"]})}>
                        <option value="true">Verdadeiro</option>
                        <option value="physical">Físico</option>
                        <option value="magical">Mágico</option>
                      </select>
                    </label>
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                      <input type="checkbox" checked={action.neutralizable} disabled={disabled}
                        onChange={e=>changeAction(i,j,{...action,neutralizable:e.target.checked})}/>
                      Pode neutralizar o dano neste turno (ex.: Luz/Divino)
                    </label>
                  </div>}
                </div>
              ))}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Button variant="outline" className="min-h-11" disabled={disabled || rule.actions.length>=12}
                  onClick={()=>changeRule(i,{actions:[...rule.actions,{kind:"status",polarity:"debuff",attributes:[{key:defs[0]?.key??"strength",mode:"percent",step:5,cap:100}]}]})}>
                  <Plus className="mr-1 h-4 w-4"/> Acúmulo de atributos
                </Button>
                <Button variant="outline" className="min-h-11" disabled={disabled || rule.actions.length>=12}
                  onClick={()=>changeRule(i,{actions:[...rule.actions,{kind:"damage",dice_count:1,dice_sides:50,flat:0,damage_kind:"true",neutralizable:false}]})}>
                  <Plus className="mr-1 h-4 w-4"/> Dano por turno
                </Button>
              </div>
              <Button variant="ghost" size="sm" className="min-h-10 text-red-300" disabled={disabled}
                onClick={()=>onChange(rules.filter((_,index)=>index!==i))}>
                <Trash2 className="mr-1 h-4 w-4"/> Excluir esta regra
              </Button>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
