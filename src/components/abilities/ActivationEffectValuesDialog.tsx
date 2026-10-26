import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  customizableActivationEffects, parseActivationValueOverrides,
} from "@/lib/activation-effect-values";
import type { AbilityEffectDefinition } from "@/lib/abilities";

export type ActivationEffectOverrides = Record<string, Record<string, number>>;

export function ActivationEffectValuesDialog({
  abilityName, targetName, effects, onCancel, onConfirm,
}: {
  abilityName: string;
  targetName: string;
  effects: AbilityEffectDefinition[];
  onCancel: () => void;
  onConfirm: (values: ActivationEffectOverrides) => Promise<boolean>;
}) {
  const customizable = customizableActivationEffects(effects);
  const [values, setValues] = useState<Record<string, Record<string, string>>>(() =>
    Object.fromEntries(customizable.map(({ index, fields }) => [
      String(index),
      Object.fromEntries(fields.map((field) => [field.key, String(field.initialValue)])),
    ]))
  );
  const [pending, setPending] = useState(false);

  async function confirm() {
    const parsed = parseActivationValueOverrides(effects, values);
    if (!parsed) {
      toast.error("Revise os valores dos efeitos. Não use valores negativos ou acima do limite.");
      return;
    }
    setPending(true);
    try {
      const success = await onConfirm(parsed);
      if (success) onCancel();
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-gold">Modificar efeitos ao ativar</DialogTitle>
          <DialogDescription>
            {abilityName} · alvo: {targetName}. Escolha os valores desta utilização antes de ativar.
            Os valores originais cadastrados não serão alterados.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
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
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
            Cancelar
          </Button>
          <Button type="button" disabled={pending} onClick={() => void confirm()}>
            {pending ? "Ativando..." : "Confirmar e Ativar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
