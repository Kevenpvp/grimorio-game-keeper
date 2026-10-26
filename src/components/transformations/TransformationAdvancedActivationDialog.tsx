import { useMemo, useState } from "react";
import { Settings2, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { activationEffectValueFields } from "@/lib/activation-effect-values";
import { parseAbilityEffects, type AbilityEffectDefinition } from "@/lib/abilities";
import type { AttributeDef } from "@/lib/sheets";
import type { Json } from "@/integrations/supabase/types";

export type AdvancedTransformationTemplate = {
  id: string;
  name: string;
  duration_turns: number;
  cooldown_turns: number;
  mana_cost: number;
  modifiers: Json;
  effects: Json;
  end_effects: Json;
};

export type TransformationActivationOverrides = Record<string, unknown> & {
  __advanced: {
    duration_turns: number;
    cooldown_turns: number;
    mana_cost: number;
    modifiers: Record<string, number>;
  };
};

function asModifiers(value: Json): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const number = Number(entry);
    if (Number.isFinite(number)) result[key] = number;
  }
  return result;
}

function parseInteger(raw: string, min: number, max: number): number | null {
  if (!/^-?\d+$/.test(raw.trim())) return null;
  const number = Number(raw);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

function initialEffectValues(effects: AbilityEffectDefinition[]) {
  return Object.fromEntries(effects.map((effect, index) => [
    String(index),
    Object.fromEntries(activationEffectValueFields(effect).map((field) => [field.key, String(field.initialValue)])),
  ])) as Record<string, Record<string, string>>;
}

export function TransformationAdvancedActivationDialog({
  transformation, characterName, defs, busy, onCancel, onConfirm,
}: {
  transformation: AdvancedTransformationTemplate;
  characterName: string;
  defs: AttributeDef[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (overrides: TransformationActivationOverrides) => Promise<boolean>;
}) {
  const originalMods = useMemo(() => asModifiers(transformation.modifiers), [transformation.modifiers]);
  const activationEffects = useMemo(() => parseAbilityEffects(transformation.effects), [transformation.effects]);
  const endingEffects = useMemo(() => parseAbilityEffects(transformation.end_effects), [transformation.end_effects]);

  const [duration, setDuration] = useState(String(transformation.duration_turns));
  const [cooldown, setCooldown] = useState(String(transformation.cooldown_turns));
  const [manaCost, setManaCost] = useState(String(transformation.mana_cost));
  const [mods, setMods] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(originalMods).map(([key, value]) => [key, String(value)])),
  );
  const [allStats, setAllStats] = useState(false);
  const [effectValues, setEffectValues] = useState(() => initialEffectValues(activationEffects));
  const [saving, setSaving] = useState(false);

  const modifierDefinitions = useMemo(() => {
    const list = [
      { key: "body", label: "Corpo (%)" },
      { key: "sanity", label: "Sanidade (%)" },
      ...defs.filter((def) => !["body", "sanity"].includes(def.key)).map((def) => ({ key: def.key, label: def.label })),
    ];
    return list.filter(({ key }) => allStats || (originalMods[key] ?? 0) !== 0);
  }, [allStats, defs, originalMods]);
  const numericEffects = activationEffects.map((effect, index) => ({
    effect, index, fields: activationEffectValueFields(effect),
  })).filter((item) => item.fields.length > 0);

  async function activate() {
    const durationValue = parseInteger(duration, 1, 1000);
    const cooldownValue = parseInteger(cooldown, 0, 1000);
    const manaValue = parseInteger(manaCost, 0, 1_000_000);
    if (durationValue === null || cooldownValue === null || manaValue === null) {
      toast.error("Duração: 1–1000; recarga: 0–1000; Mana: 0–1.000.000. Use números inteiros.");
      return;
    }
    const acceptedKeys = new Set(["body", "sanity", ...defs.map((def) => def.key)]);
    const nextMods: Record<string, number> = {};
    for (const [key, value] of Object.entries({ ...originalMods, ...mods })) {
      if (!acceptedKeys.has(key)) {
        toast.error("Atributo não reconhecido na transformação: " + key);
        return;
      }
      const limit = key === "body" || key === "sanity" ? 100 : 1_000_000;
      const number = parseInteger(String(value), -limit, limit);
      if (number === null) {
        toast.error("Ajuste inválido em " + key + ": use um inteiro entre -" + limit + " e +" + limit + ".");
        return;
      }
      if (number !== 0) nextMods[key] = number;
    }

    const payload: TransformationActivationOverrides = {
      __advanced: { duration_turns: durationValue, cooldown_turns: cooldownValue, mana_cost: manaValue, modifiers: nextMods },
    };

    for (const { index, fields } of numericEffects) {
      const changed: Record<string, number> = {};
      for (const field of fields) {
        const raw = effectValues[String(index)]?.[field.key] ?? String(field.initialValue);
        const value = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(value) || value < 0 || value > field.max) {
          toast.error("Valor inválido em " + activationEffects[index].name + " / " + field.label + ".");
          return;
        }
        if (value !== field.initialValue) changed[field.key] = value;
      }
      if (Object.keys(changed).length > 0) payload[String(index)] = changed;
    }

    setSaving(true);
    try {
      const success = await onConfirm(payload);
      if (success) onCancel();
    } finally {
      setSaving(false);
    }
  }

  const blocked = busy || saving;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !blocked) onCancel(); }}>
      <DialogContent className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[min(92dvh,850px)] sm:max-h-[92dvh] sm:max-w-2xl sm:rounded-xl">
        <DialogHeader className="shrink-0 border-b border-border px-4 pb-3 pt-5 pr-12 text-left sm:px-6">
          <DialogTitle className="flex items-center gap-2 text-lg text-gold">
            <Settings2 className="h-5 w-5 shrink-0" /> Opções avançadas
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed sm:text-sm">
            {transformation.name} · {characterName}. Os ajustes valem apenas para esta ativação,
            sem alterar o cadastro da transformação.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
          <section className="space-y-3 rounded-lg border border-gold/30 p-3">
            <h3 className="text-sm font-semibold text-gold">Duração e custo desta ativação</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {([
                { title: "Duração (turnos)", value: duration, set: setDuration, min: 1, max: 1000 },
                { title: "Recarga (turnos)", value: cooldown, set: setCooldown, min: 0, max: 1000 },
                { title: "Custo de Mana", value: manaCost, set: setManaCost, min: 0, max: 1000000 },
              ] as const).map((field) => (
                <label key={field.title} className="space-y-1.5 text-xs font-medium">
                  {field.title}
                  <Input className="min-h-11" type="number" inputMode="numeric" min={field.min} max={field.max}
                    disabled={blocked} value={field.value} onChange={(event) => field.set(event.target.value)} />
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">A redução de recarga concedida por raça ou classe continua sendo aplicada normalmente.</p>
          </section>

          <section className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-gold">Atributos concedidos</h3>
                <p className="text-xs text-muted-foreground">Valores temporários de HP, Mana, Força, Defesa, Corpo e outros.</p>
              </div>
              <Button type="button" variant="outline" size="sm" className="min-h-10" disabled={blocked}
                onClick={() => setAllStats((current) => !current)}>
                {allStats ? "Só configurados" : "Mostrar todos"}
              </Button>
            </div>
            {modifierDefinitions.length === 0 ? <p className="text-xs text-muted-foreground">Nenhum atributo configurado. Use “Mostrar todos” para adicionar ajustes.</p> : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {modifierDefinitions.map(({ key, label }) => (
                  <label key={key} className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs font-medium">
                    <span className="min-w-0 break-words">{label}</span>
                    <Input type="number" inputMode="numeric" step="1" disabled={blocked}
                      className="h-10 w-28 shrink-0 text-right" aria-label={"Modificador de " + label}
                      value={mods[key] ?? String(originalMods[key] ?? 0)}
                      onChange={(event) => setMods((current) => ({ ...current, [key]: event.target.value }))} />
                  </label>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">Zero não concede bônus; valores negativos aplicam penalidades. Corpo e Sanidade aceitam de −100 a +100.</p>
          </section>

          <details className="rounded-lg border border-border p-3">
            <summary className="min-h-10 cursor-pointer py-2 text-sm font-semibold text-gold">Efeitos ao ativar · valores avançados ({numericEffects.length})</summary>
            <div className="mt-2 space-y-3">
              {numericEffects.length === 0 && <p className="text-xs text-muted-foreground">Nenhum efeito possui valores numéricos ajustáveis nesta transformação.</p>}
              {numericEffects.map(({ effect, index, fields }) => (
                <div key={index} className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
                  <h4 className="text-sm font-semibold">{effect.name}</h4>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {fields.map((field) => (
                      <label key={field.key} className="space-y-1 text-xs font-medium">
                        {field.label}
                        <Input className="min-h-11" type="number" step="any" min={0} max={field.max} disabled={blocked}
                          value={effectValues[String(index)]?.[field.key] ?? String(field.initialValue)}
                          onChange={(event) => setEffectValues((current) => ({
                            ...current,
                            [String(index)]: { ...current[String(index)], [field.key]: event.target.value },
                          }))} />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </details>
          {endingEffects.length > 0 && (
            <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
              Os {endingEffects.length} efeito(s) ao terminar e as habilidades concedidas continuam como foram cadastrados.
              Esta personalização ajusta os bônus e efeitos de ativação, não altera efeitos futuros de encerramento.
            </p>
          )}
        </div>
        <div className="shrink-0 space-y-2 border-t border-border bg-background/95 px-4 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-3 sm:flex sm:items-center sm:justify-between sm:gap-3 sm:space-y-0 sm:px-6 sm:pb-4">
          <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={blocked} onClick={onCancel}>Cancelar</Button>
          <Button type="button" className="min-h-11 w-full sm:w-auto" disabled={blocked} onClick={() => void activate()}>
            <Sparkles className="mr-2 h-4 w-4" /> {blocked ? "Ativando..." : "Confirmar e ativar"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
