import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  customizableActivationEffects, parseActivationValueOverrides,
} from "@/lib/activation-effect-values";
import type { AbilityEffectDefinition } from "@/lib/abilities";

export type ActivationEffectOverrides = Record<string, Record<string, number>>;
export type ActivationRecipient = { id: string; name: string };

export function ActivationEffectValuesDialog({
  abilityName, recipients, selfOnly = false, initialTargetIds = [], effects, onCancel, onConfirm,
}: {
  abilityName: string;
  recipients: ActivationRecipient[];
  selfOnly?: boolean;
  initialTargetIds?: string[];
  effects: AbilityEffectDefinition[];
  onCancel: () => void;
  onConfirm: (values: ActivationEffectOverrides, targetIds: string[], hitOutside: boolean) => Promise<boolean>;
}) {
  const customizable = useMemo(() => customizableActivationEffects(effects), [effects]);
  const [targetIds, setTargetIds] = useState<string[]>(initialTargetIds);
  const [values, setValues] = useState<Record<string, Record<string, string>>>(() =>
    Object.fromEntries(customizable.map(({ index, fields }) => [
      String(index),
      Object.fromEntries(fields.map((field) => [field.key, String(field.initialValue)])),
    ]))
  );
  const [pending, setPending] = useState(false);
  const [hitOutside, setHitOutside] = useState(false);
  const available = recipients.filter((recipient) => recipient.id.trim().length > 0);
  const selected = available.filter((recipient) => targetIds.includes(recipient.id));
  const toggleRecipient = (id: string, checked: boolean) => {
    if (selfOnly || pending) return;
    setTargetIds((current) => checked ? [...current, id] : current.filter((other) => other !== id));
  };

  async function confirm() {
    const parsed = parseActivationValueOverrides(effects, values);
    if (!parsed) {
      toast.error("Revise os valores dos efeitos. Não use valores negativos ou acima do limite.");
      return;
    }
    setPending(true);
    try {
      const success = await onConfirm(parsed, selected.map((recipient) => recipient.id), selected.length === 0 && hitOutside);
      if (success) onCancel();
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <DialogContent className="max-h-[90vh] w-[calc(100%-1.5rem)] max-w-2xl overflow-y-auto rounded-2xl border-gold/35 bg-background p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="font-display text-xl text-gold">Ativar habilidade · {abilityName}</DialogTitle>
          <DialogDescription>
            Escolha quem receberá os efeitos desta ativação. Você pode selecionar vários personagens.
            Os efeitos do tipo Caster se aplicam ao próprio usuário quando ele estiver selecionado;
            Alvo se aplica aos outros destinatários; Ambos respeita as duas opções.
            O custo de Mana e a recarga são contabilizados uma única vez. Sem selecionar destinatários, a habilidade ainda é usada e não aplica efeitos a ninguém.
          </DialogDescription>
        </DialogHeader>
        <section className="space-y-3 rounded-xl border border-gold/20 bg-gold/5 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gold">Quem receberá os efeitos?</h3>
            <span className="text-xs text-muted-foreground">{selected.length} selecionado(s)</span>
          </div>
          {!selfOnly && available.length > 1 && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" className="min-h-9"
                disabled={pending} onClick={() => setTargetIds(available.map((recipient) => recipient.id))}>
                Selecionar todos
              </Button>
              <Button type="button" size="sm" variant="ghost" className="min-h-9"
                disabled={pending} onClick={() => setTargetIds([])}>
                Limpar seleção
              </Button>
            </div>
          )}
          <div className="grid max-h-52 gap-2 overflow-y-auto sm:grid-cols-2">
            {available.map((recipient) => (
              <label key={recipient.id}
                className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors ${
                  targetIds.includes(recipient.id)
                    ? "border-gold/60 bg-gold/15 text-gold"
                    : "border-border bg-background/60 text-foreground hover:border-gold/35"
                }`}>
                <input type="checkbox" className="h-4 w-4 shrink-0 accent-[#e8b95a]"
                  disabled={pending || selfOnly} checked={targetIds.includes(recipient.id)}
                  onChange={(event) => toggleRecipient(recipient.id, event.target.checked)}
                  aria-label={`Aplicar habilidade em ${recipient.name}`} />
                <span className="min-w-0 break-words font-medium">{recipient.name}</span>
              </label>
            ))}
          </div>
          {selfOnly && <p className="text-xs text-muted-foreground">Esta habilidade só pode ser ativada no próprio personagem.</p>}
          {!selfOnly && selected.length === 0 && (
            <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
              <p className="text-xs text-amber-200">Nenhum destinatário: a ativação gastará Mana e iniciará cooldown, mas não aplicará efeitos nem DoTs em personagens cadastrados.</p>
              <label className="flex min-h-10 items-center gap-2 text-xs font-medium">
                <input type="checkbox" disabled={pending} checked={hitOutside} onChange={event=>setHitOutside(event.target.checked)} />
                Acertou alguém fora do sistema (registrar acerto sem alvo cadastrado)
              </label>
            </div>
          )}
        </section>
        {customizable.length > 0 && (
          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-gold">Modificar valores nesta ativação</h3>
              <p className="text-xs text-muted-foreground">Os valores originais cadastrados não serão alterados.</p>
            </div>
            {customizable.map(({ effect, index, fields }) => (
              <div key={index} className="space-y-3 rounded-md border border-gold/30 bg-gold/5 p-3">
                <div className="text-sm font-semibold">{effect.name}</div>
                <p className="text-xs text-muted-foreground">
                  {effect.value_mode === "percent" ? "Valor em porcentagem." : "Valor fixo, salvo quando indicado."}
                  {" "}Duração: {effect.until_combat_end ? "até o fim do combate" : `${effect.duration} turno(s)`}.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {fields.map((field) => (
                    <label key={field.key} className="space-y-1 text-xs font-medium">
                      {field.label}
                      <Input
                        type="number" min={0} max={field.max} step="any"
                        value={values[String(index)]?.[field.key] ?? String(field.initialValue)}
                        disabled={pending}
                        onChange={(event) => setValues((current) => ({
                          ...current,
                          [String(index)]: {
                            ...current[String(index)],
                            [field.key]: event.target.value,
                          },
                        }))}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-3">
          <Button type="button" variant="outline" className="min-h-11" disabled={pending} onClick={onCancel}>
            Cancelar
          </Button>
          <Button type="button" className="min-h-11" disabled={pending}
            onClick={() => void confirm()}>
            {pending ? "Ativando..." : selected.length === 0 ? "Ativar sem destinatários" : `Ativar em ${selected.length} personagem(ns)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
