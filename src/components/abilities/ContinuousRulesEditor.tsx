import { Plus, Trash2, Repeat2, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDotTemplates, useDamageTypes } from "@/lib/abilities";
import {
  defaultContinuousRule, type ContinuousAction, type ContinuousRule,
  type ContinuousStatusAction, type ContinuousDamageAction, type ContinuousDotAction, type ContinuousEffectAction,
} from "@/lib/continuous-effects";

type Def = { key: string; label: string };
export function ContinuousRulesEditor({ rules, onChange, defs, disabled = false }: {
  rules: ContinuousRule[]; onChange: (next: ContinuousRule[]) => void;
  defs: Def[]; disabled?: boolean;
}) {
  const {data:registeredDots=[]}=useDotTemplates();
  const {data:damageTypes=[]}=useDamageTypes();
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
          <details key={i} className="rounded-xl border border-gold/35 bg-[#0f0b09]/80 p-3">
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
              <div className="space-y-3 rounded-xl border border-gold/30 bg-gold/5 p-3">
                <div>
                  <p className="font-semibold text-sm text-gold">Vínculo com os alvos</p>
                  <p className="text-xs text-muted-foreground">Controle quantas vítimas podem ficar agarradas, mordidas ou amaldiçoadas ao mesmo tempo.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label className="flex min-h-10 items-center gap-2 text-xs font-semibold">
                      <input type="checkbox" checked={rule.max_targets===null} disabled={disabled}
                        onChange={e=>changeRule(i,{max_targets:e.target.checked?null:1})}/>
                      Sem limite de alvos
                    </label>
                    <label className="block space-y-1 text-xs font-semibold">
                      Máximo de alvos simultâneos
                      <Input type="number" min={1} max={100} step={1} inputMode="numeric"
                        aria-label="Quantidade máxima de alvos simultâneos" className="min-h-11"
                        disabled={disabled||rule.max_targets===null}
                        value={rule.max_targets??""}
                        placeholder={rule.max_targets===null?"Ilimitado":"Digite a quantidade"}
                        onChange={e=>changeRule(i,{max_targets:Math.max(1,Math.min(100,Math.trunc(Number(e.target.value)||1)))})}/>
                    </label>
                  </div>
                  <label className="space-y-1 text-xs font-semibold">Ao atingir o limite
                    <select className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                      value={rule.on_limit} disabled={disabled||rule.max_targets===null}
                      onChange={(e)=>changeRule(i,{on_limit:e.target.value as ContinuousRule["on_limit"]})}>
                      <option value="choose">Perguntar qual alvo soltar</option>
                      <option value="replace_oldest">Soltar automaticamente o mais antigo</option>
                      <option value="block">Impedir novo vínculo</option>
                    </select>
                  </label>
                </div>
                {rule.max_targets!==null && rule.on_limit==="choose" &&
                  <p className="text-xs text-muted-foreground">No ataque, o mestre poderá soltar um alvo antigo antes de confirmar o novo. A penalidade residual será preservada.</p>}
                <p className="font-semibold text-xs text-gold">Interrupção automática</p>
                {([
                  ["stop_on_caster_leave","Se o usuário sair da batalha"],
                  ["stop_on_caster_death","Se o usuário morrer"],
                  ["stop_on_caster_stun","Se o usuário ficar atordoado"],
                ] as const).map(([key,label])=>
                  <label key={key} className="flex min-h-11 items-center gap-2 text-sm">
                    <input type="checkbox" disabled={disabled} checked={rule[key]}
                      onChange={e=>changeRule(i,{[key]:e.target.checked})}/>
                    {label}
                  </label>)}
              </div>
              {rule.actions.map((action, j) => (
                <div key={j} className="space-y-3 rounded-lg border border-gold/20 bg-background/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-bold text-gold">{action.kind === "status" ? "Acumular Buff/Debuff" : action.kind === "damage" ? "Dano periódico" : action.kind === "dot" ? "Aplicar DoT cadastrado" : "Efeito por turno"}</span>
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
                  </> : action.kind === "damage" ? <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block space-y-1 text-xs font-semibold">Como calcular o dano
                        <select disabled={disabled} value={action.damage_source}
                          className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                          onChange={e=>changeAction(i,j,{...action,damage_source:e.target.value as ContinuousDamageAction["damage_source"]})}>
                          <option value="dice">Dado rolado no Discord</option>
                          <option value="attribute">Percentual de um atributo</option>
                          <option value="fixed">Valor fixo</option>
                        </select>
                      </label>
                      <label className="block space-y-1 text-xs font-semibold">Tipo de dano
                        <select disabled={disabled} value={action.damage_kind}
                          className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                          onChange={e=>changeAction(i,j,{...action,damage_kind:e.target.value as ContinuousDamageAction["damage_kind"]})}>
                          <option value="true">Verdadeiro (ignora Defesa)</option>
                          <option value="physical">Físico</option>
                          <option value="magical">Mágico</option>
                        </select>
                      </label>
                    </div>
                    {action.damage_source==="dice" && <label className="block space-y-1 text-xs font-semibold">
                      Expressão para rolar no Discord (não é rolada no site)
                      <Input className="min-h-11" maxLength={80} disabled={disabled} placeholder="Ex.: 1d50, 2d10+5"
                        value={action.dice_expression} onChange={e=>changeAction(i,j,{...action,dice_expression:e.target.value})}/>
                      <span className="block font-normal text-muted-foreground">No turno o mestre insere o resultado que obteve no Discord.</span>
                    </label>}
                    {action.damage_source==="attribute" && <div className="grid gap-2 sm:grid-cols-2">
                      <label className="block space-y-1 text-xs font-semibold">Atributo utilizado
                        <select className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                          value={action.attribute_key??""} disabled={disabled}
                          onChange={e=>changeAction(i,j,{...action,attribute_key:e.target.value||null})}>
                          <option value="">Selecionar atributo…</option>
                          {defs.map(d=><option key={d.key} value={d.key}>{d.label}</option>)}
                        </select>
                      </label>
                      <label className="block space-y-1 text-xs font-semibold">Percentual do atributo
                        <Input type="number" className="min-h-11" min={0} max={1000} step="any" inputMode="decimal"
                          disabled={disabled} value={action.attribute_percent}
                          onChange={e=>changeAction(i,j,{...action,attribute_percent:Math.max(0,Math.min(1000,Number(e.target.value)||0))})}/>
                      </label>
                    </div>}
                    {(action.damage_source==="fixed"||action.damage_source==="attribute") && <label className="block space-y-1 text-xs font-semibold">
                      {action.damage_source==="fixed"?"Dano fixo":"Dano fixo adicional"}
                      <Input type="number" className="min-h-11" min={0} max={1000000} step={1}
                        inputMode="numeric" disabled={disabled} value={action.fixed_damage}
                        onChange={e=>changeAction(i,j,{...action,fixed_damage:numberValue(e.target.value)})}/>
                    </label>}
                    {action.damage_kind==="magical" && <div className="grid gap-2 sm:grid-cols-2">
                      <label className="block space-y-1 text-xs">Tipo mágico cadastrado
                        <select className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" disabled={disabled}
                          value={action.damage_type_id??""} onChange={e=>changeAction(i,j,{...action,damage_type_id:e.target.value||null})}>
                          <option value="">Selecionar tipo mágico…</option>
                          {damageTypes.filter(d=>d.category==="magical").map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                      </label>
                      <label className="block space-y-1 text-xs">Grau da magia
                        <select className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" disabled={disabled}
                          value={action.magic_level} onChange={e=>changeAction(i,j,{...action,magic_level:e.target.value as ContinuousDamageAction["magic_level"]})}>
                          <option value="baixa">Baixa</option><option value="media">Média</option><option value="alta">Alta</option>
                        </select>
                      </label>
                    </div>}
                    {action.damage_kind==="physical" && <label className="block space-y-1 text-xs">Tipo físico (opcional)
                      <select className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" disabled={disabled}
                        value={action.physical_damage_type_id??""}
                        onChange={e=>changeAction(i,j,{...action,physical_damage_type_id:e.target.value||null})}>
                        <option value="">Nenhum tipo específico</option>
                        {damageTypes.filter(d=>d.category==="physical").map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    </label>}
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                      <input type="checkbox" checked={action.neutralizable} disabled={disabled}
                        onChange={e=>changeAction(i,j,{...action,neutralizable:e.target.checked})}/>
                      Permitir neutralização deste dano durante o turno
                    </label>                  </div> : action.kind === "dot" ? <div className="space-y-3">
                    <label className="block space-y-1 text-xs">DoT já cadastrado
                      <select value={action.template_id} disabled={disabled} className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
                        onChange={e=>changeAction(i,j,{...action,template_id:e.target.value})}>
                        <option value="">Selecione um DoT…</option>
                        {registeredDots.map(dot=><option key={dot.id} value={dot.id}>{dot.name}</option>)}
                      </select>
                    </label>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      <label className="space-y-1 text-xs">Dano por turno
                        <Input type="number" min={1} max={1000000} className="min-h-11" disabled={disabled}
                          value={action.damage_amount} onChange={e=>changeAction(i,j,{...action,damage_amount:numberValue(e.target.value)})}/>
                      </label>
                      <label className="space-y-1 text-xs">Duração do DoT
                        <Input type="number" min={1} max={1000} className="min-h-11" disabled={disabled}
                          value={action.duration} onChange={e=>changeAction(i,j,{...action,duration:numberValue(e.target.value,1000)})}/>
                      </label>
                      <label className="space-y-1 text-xs">Modo
                        <select className="min-h-11 w-full rounded-lg border border-input bg-background px-2" value={action.damage_mode} disabled={disabled}
                          onChange={e=>changeAction(i,j,{...action,damage_mode:e.target.value as ContinuousDotAction["damage_mode"]})}>
                          <option value="fixed">Dano fixo</option><option value="percent">% do HP máximo</option>
                        </select>
                      </label>
                    </div>
                    <label className="flex min-h-11 items-center gap-2 text-xs">
                      <input type="checkbox" checked={action.repeat} disabled={disabled}
                        onChange={e=>changeAction(i,j,{...action,repeat:e.target.checked})}/>
                      Aplicar um novo DoT a cada turno (pode acumular)
                    </label>
                  </div> : <div className="space-y-3">
                    <label className="block space-y-1 text-xs">Efeito adicional
                      <select className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" disabled={disabled}
                        value={action.effect_type} onChange={e=>changeAction(i,j,{...action,effect_type:e.target.value as ContinuousEffectAction["effect_type"]})}>
                        <option value="stun">Stun</option><option value="no_regen_hp">Bloquear regeneração de HP</option>
                        <option value="no_regen_mana">Bloquear regeneração de Mana</option>
                        <option value="magic_prohibition">Proibição de magia</option><option value="no_mana">Sem Mana</option>
                        <option value="invincible">Invencível</option>
                      </select>
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1 text-xs">Nome exibido
                        <Input className="min-h-11" value={action.name} disabled={disabled} maxLength={120}
                          onChange={e=>changeAction(i,j,{...action,name:e.target.value})}/>
                      </label>
                      <label className="space-y-1 text-xs">Duração
                        <Input type="number" className="min-h-11" min={1} max={1000} value={action.duration} disabled={disabled}
                          onChange={e=>changeAction(i,j,{...action,duration:numberValue(e.target.value,1000)})}/>
                      </label>
                    </div>
                    <label className="flex min-h-11 items-center gap-2 text-xs">
                      <input type="checkbox" checked={action.repeat} disabled={disabled}
                        onChange={e=>changeAction(i,j,{...action,repeat:e.target.checked})}/>
                      Reaplicar mesmo que o efeito ainda esteja ativo
                    </label>
                  </div>}
                </div>
              ))}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Button variant="outline" className="min-h-11" disabled={disabled || rule.actions.length>=12}
                  onClick={()=>changeRule(i,{actions:[...rule.actions,{kind:"status",polarity:"debuff",attributes:[{key:defs.find(d=>d.key==="strength")?.key??defs.find(d=>d.key!=="hp"&&d.key!=="mana")?.key??"strength",mode:"percent",step:5,cap:100}]}]})}>
                  <Plus className="mr-1 h-4 w-4"/> Acúmulo de atributos
                </Button>
                <Button variant="outline" className="min-h-11" disabled={disabled || rule.actions.length>=12}
                  onClick={()=>changeRule(i,{actions:[...rule.actions,{kind:"damage",damage_source:"dice",dice_expression:"1d50",attribute_key:null,attribute_percent:100,fixed_damage:0,damage_kind:"true",damage_type_id:null,physical_damage_type_id:null,magic_level:"baixa",neutralizable:false}]})}>
                  <Plus className="mr-1 h-4 w-4"/> Dano por turno
                </Button>
                <Button variant="outline" className="min-h-11" disabled={disabled||rule.actions.length>=12||registeredDots.length===0}
                  onClick={()=>changeRule(i,{actions:[...rule.actions,{
                    kind:"dot",template_id:registeredDots[0]?.id??"",damage_mode:"fixed",damage_amount:5,duration:2,repeat:false,
                  }]})}>
                  <Plus className="mr-1 h-4 w-4"/> DoT registrado
                </Button>
                <Button variant="outline" className="min-h-11" disabled={disabled||rule.actions.length>=12}
                  onClick={()=>changeRule(i,{actions:[...rule.actions,{
                    kind:"effect",effect_type:"stun",name:"Atordoamento",duration:1,repeat:false,
                  }]})}>
                  <Plus className="mr-1 h-4 w-4"/> Outro efeito
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
