import type { Dispatch, SetStateAction } from "react";
import { Skull } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { AbilityAttackDamageConfig } from "@/lib/abilities";

/** The same guarded execution setting is used by catalog and sheet attacks. */
export function AbilityAttackExecutionEditor({value,onChange,disabled=false}:{
  value:AbilityAttackDamageConfig;
  onChange:Dispatch<SetStateAction<AbilityAttackDamageConfig>>;
  disabled?:boolean;
}){
  return <section className="space-y-3 rounded-xl border border-red-500/30 bg-red-950/10 p-3 sm:p-4">
    <label className="flex min-h-11 items-start gap-3">
      <input type="checkbox" className="mt-1 h-4 w-4 accent-red-500"
        disabled={disabled} checked={value.execute_enabled}
        onChange={e=>onChange(config=>({...config,execute_enabled:e.target.checked}))}/>
      <span className="min-w-0">
        <strong className="flex items-center gap-2 text-sm text-red-300"><Skull className="h-4 w-4"/> Executar alvo ao acertar</strong>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
          Se o alvo tiver HP igual ou abaixo do limite, o acerto zera seu HP. Funciona mesmo com dano direto 0.
          Não executa quem esquivou. Desativado por padrão.
        </span>
      </span>
    </label>
    {value.execute_enabled&&<div className="grid gap-3 border-t border-red-500/15 pt-3 sm:grid-cols-2">
      <label className="space-y-1 text-xs font-semibold">
        Condição para executar
        <select className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
          value={value.execute_mode} disabled={disabled}
          onChange={e=>onChange(config=>({...config,
            execute_mode:e.target.value as AbilityAttackDamageConfig["execute_mode"],
            execute_threshold:e.target.value==="percent"
              ? Math.min(100,config.execute_threshold):config.execute_threshold,
          }))}>
          <option value="percent">HP atual ≤ % do HP máximo</option>
          <option value="fixed">HP atual ≤ valor fixo</option>
        </select>
      </label>
      <label className="space-y-1 text-xs font-semibold">
        {value.execute_mode==="percent"?"Limite de HP (%)":"Limite de HP (valor)"}
        <Input type="number" className="min-h-11" inputMode="decimal"
          min={0} max={value.execute_mode==="percent"?100:1000000} step={value.execute_mode==="percent"?"any":1}
          disabled={disabled} value={value.execute_threshold}
          onChange={e=>onChange(config=>({...config,execute_threshold:
            Math.max(0,Math.min(config.execute_mode==="percent"?100:1000000,Number(e.target.value)||0)),
          }))}/>
      </label>
      <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">
        Exemplo: 10% executa uma vítima com 8/80 HP, mas não com 9/80 HP.
        A condição usa o HP antes do dano direto deste ataque e só vale para os alvos marcados como acertados.
      </p>
    </div>}
  </section>;
}
