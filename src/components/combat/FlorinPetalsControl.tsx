import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Droplets, Minus, Plus, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";

const db = supabase as any;

export type FlorinPetalsState = {
  ability_id: string;
  character_id: string;
  weapon_name: string;
  stacks: number;
  max_stacks: number;
  threshold: number;
  pending: { damage_mode: "fixed" | "percent"; damage_amount: number; duration: number } | null;
};

/** Master-only controls nested under the granted ability, responsive on phones. */
export function FlorinPetalsControl({ state, battleId, active }: {
  state: FlorinPetalsState;
  battleId: string;
  active: boolean;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"fixed" | "percent">("fixed");
  const [damage, setDamage] = useState("");
  const [duration, setDuration] = useState("");
  const [expanded, setExpanded] = useState(false);

  // After a successful weapon hit, the pending DoT is consumed on the server.
  // Never retain the previous editable value for accidental rearming.
  useEffect(() => {
    if (!state.pending) {
      setDamage("");
      setDuration("");
      setMode("fixed");
    }
  }, [state.pending?.damage_amount, state.pending?.duration, state.pending?.damage_mode]);

  async function run(action: "adjust" | "threshold" | "arm" | "clear", value?: number) {
    if (busy || !active) return;
    if (action === "arm") {
      const amount = Number(damage);
      const ticks = Number(duration);
      if (!damage || !Number.isFinite(amount) || amount <= 0 ||
        amount > (mode === "fixed" ? 1000000 : 1000) ||
        (mode === "fixed" && !Number.isInteger(amount)) ||
        !Number.isInteger(ticks) || ticks < 1 || ticks > 1000) {
        toast.error("Informe dano válido e duração de 1 a 1000 turnos.");
        return;
      }
    }
    setBusy(true);
    try {
      const { error } = await db.rpc("control_florin_petals", {
        _battle_id: battleId,
        _ability_id: state.ability_id,
        _action: action,
        _value: value ?? null,
        _mode: action === "arm" ? mode : null,
        _damage: action === "arm" ? Number(damage) : null,
        _duration: action === "arm" ? Number(duration) : null,
      });
      if (error) throw error;
      if (action === "arm") {
        toast.success("Sangramento preparado para o próximo golpe da Florin!");
        setDamage(""); setDuration(""); setMode("fixed");
      }
      if (action === "clear") {
        toast.info("Sangramento preparado removido.");
        setDamage(""); setDuration(""); setMode("fixed");
      }
      await qc.invalidateQueries({queryKey:["florin-petals",battleId]});
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível atualizar Lágrimas das pétalas.");
    } finally { setBusy(false); }
  }

  const ready = state.stacks >= state.threshold && state.max_stacks > 0;

  return (
    <section className="min-w-0 space-y-2 rounded-xl border border-rose-500/35 bg-rose-950/10 p-3"
      aria-label={`Lágrimas das pétalas — ${state.weapon_name}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-bold text-rose-200">
            <Droplets className="h-4 w-4 shrink-0" /> Controle de stacks
          </div>
          <p className="truncate text-[11px] text-muted-foreground">{state.weapon_name}</p>
        </div>
        <span className="shrink-0 rounded-lg border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-sm font-bold tabular-nums text-rose-200">
          {state.stacks} / {state.max_stacks} stacks
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" className="min-h-11 min-w-12 border-rose-500/35"
          aria-label="Diminuir um stack de Lágrimas das pétalas"
          disabled={busy || !active || state.stacks<=0} onClick={() => void run("adjust",-1)}>
          <Minus className="h-4 w-4" />
        </Button>
        <div className="flex min-w-0 flex-1 gap-1">
          {Array.from({length:Math.min(30,state.max_stacks)},(_,index) => (
            <span key={index} className={`h-2 flex-1 rounded-full ${index<state.stacks ? "bg-rose-400" : "bg-rose-400/15"}`} />
          ))}
          {state.max_stacks>30 && <span className="ml-1 text-xs text-rose-200">{state.stacks} acumulados</span>}
        </div>
        <Button type="button" size="sm" variant="outline" className="min-h-11 min-w-12 border-rose-500/35"
          aria-label="Aumentar um stack de Lágrimas das pétalas"
          disabled={busy || !active || state.stacks>=state.max_stacks} onClick={() => void run("adjust",1)}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <span className={ready ? "font-semibold text-emerald-300" : "text-muted-foreground"}>
          {ready ? "Gatilho atingido: pode preparar Sangramento" : `Faltam ${Math.max(0,state.threshold-state.stacks)} stack(s) para o gatilho`}
        </span>
        {state.pending
          ? <span className="font-semibold text-rose-200">DoT armado para o próximo golpe</span>
          : <span className="text-muted-foreground">Sem DoT preparado</span>}
      </div>
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}
        className="rounded-lg border border-rose-500/20 bg-background/40">
        <summary className="min-h-10 cursor-pointer select-none px-3 py-2 text-xs font-semibold text-gold">
          {state.pending ? "Ver Sangramento preparado" : "Configurar Sangramento"}
        </summary>
        <div className="space-y-3 border-t border-rose-500/20 p-3">
          <label className="block space-y-1 text-xs">
            <span>Stacks necessários para preparar o DoT</span>
            <select aria-label="Stacks necessários para Sangramento"
              className="min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={state.threshold} disabled={busy || !active}
              onChange={(event) => void run("threshold",Number(event.target.value))}>
              {Array.from({length:Math.min(10000,state.max_stacks)},(_,index) =>
                <option key={index+1} value={index+1}>{index+1} stack{index>0?"s":""}</option>)}
            </select>
          </label>
          {state.pending ? (
            <div className="space-y-2 rounded-lg border border-rose-500/35 bg-rose-500/10 p-3 text-xs">
              <p className="font-semibold text-rose-200">Sangramento pronto para aplicar</p>
              <p>Dano: {state.pending.damage_amount}{state.pending.damage_mode==="percent"?"% do HP máximo":" HP"} por turno</p>
              <p>Duração: {state.pending.duration} turno(s) do alvo</p>
              <p className="text-muted-foreground">Será aplicado apenas se o ataque com esta arma causar dano. Depois o valor é apagado; os stacks permanecem.</p>
              <Button type="button" size="sm" variant="outline" className="min-h-11 w-full"
                disabled={busy || !active} onClick={() => void run("clear")}>
                Cancelar Sangramento preparado
              </Button>
            </div>
          ) : (
            <>
              {!ready && (
                <p className="flex gap-2 rounded-lg bg-amber-500/5 p-2 text-xs text-amber-200">
                  <ShieldAlert className="h-4 w-4 shrink-0" />
                  Alcance o gatilho de stacks para liberar a preparação do DoT.
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs">
                  <span>Tipo do dano por turno</span>
                  <select aria-label="Tipo de dano do Sangramento" value={mode}
                    onChange={event => setMode(event.target.value === "percent" ? "percent" : "fixed")}
                    disabled={busy || !active || !ready}
                    className="min-h-11 w-full rounded-md border border-input bg-background px-2 text-sm">
                    <option value="fixed">Dano fixo</option>
                    <option value="percent">% do HP máximo do alvo</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs">
                  <span>Dano por turno {mode==="percent"?"(%)":"(HP)"}</span>
                  <Input aria-label="Dano do Sangramento" type="number" value={damage}
                    min={1} max={mode==="percent"?1000:1000000}
                    step={mode==="percent"?"0.1":"1"}
                    disabled={busy || !active || !ready}
                    onChange={event => setDamage(event.target.value)} />
                </label>
                <label className="space-y-1 text-xs sm:col-span-2">
                  <span>Duração (turnos do alvo)</span>
                  <Input aria-label="Duração do Sangramento" type="number" min={1} max={1000}
                    step={1} value={duration} disabled={busy || !active || !ready}
                    onChange={event => setDuration(event.target.value)} />
                </label>
              </div>
              <Button type="button" className="min-h-11 w-full" disabled={busy || !active || !ready}
                onClick={() => void run("arm")}>
                <Droplets className="mr-2 h-4 w-4" />
                {busy ? "Preparando..." : "Preparar Sangramento para o próximo ataque"}
              </Button>
              <p className="text-[11px] text-muted-foreground">
                Usa o Sangramento já cadastrado. Uma preparação vale somente para o próximo ataque com esta relíquia que causar dano.
              </p>
            </>
          )}
        </div>
      </details>
    </section>
  );
}
