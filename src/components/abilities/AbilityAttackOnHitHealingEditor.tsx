import type { Dispatch, SetStateAction } from "react";
import { HeartPulse } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { AbilityAttackDamageConfig } from "@/lib/abilities";

/** Shared by catalog and sheet (including accessories' editable abilities). */
export function AbilityAttackOnHitHealingEditor({ value, onChange, disabled = false }: {
  value: AbilityAttackDamageConfig;
  onChange: Dispatch<SetStateAction<AbilityAttackDamageConfig>>;
  disabled?: boolean;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 sm:p-4">
      <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm font-semibold text-emerald-300">
        <input type="checkbox" className="h-4 w-4 accent-emerald-500"
          checked={value.heal_on_damage_enabled}
          disabled={disabled}
          onChange={(event) => onChange((current) => ({
            ...current, heal_on_damage_enabled: event.target.checked,
          }))} />
        <HeartPulse className="h-4 w-4" />
        Curar no Dano
      </label>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Ao acertar com Atacar, recupera HP de quem usou a habilidade.
        A porcentagem considera somente o dano final após defesa, mitigação,
        crítico e efeitos do combate. O valor fixo recupera a quantidade escolhida
        a cada alvo acertado, mesmo que a defesa reduza o dano a zero.
        Esquivas não geram cura. Respeita o HP máximo e bloqueios de cura.
      </p>
      {value.heal_on_damage_enabled && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-medium">
            Tipo de cura
            <select aria-label="Tipo de Curar no Dano"
              className="min-h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
              disabled={disabled} value={value.heal_on_damage_mode}
              onChange={(event) => onChange((current) => ({
                ...current,
                heal_on_damage_mode: event.target.value === "fixed" ? "fixed" : "percent",
                heal_on_damage_amount: 0,
              }))}>
              <option value="percent">% do dano final causado</option>
              <option value="fixed">Valor fixo de HP</option>
            </select>
          </label>
          <label className="space-y-1 text-xs font-medium">
            {value.heal_on_damage_mode === "percent" ? "Porcentagem do dano final (%)" : "HP recuperado por acerto"}
            <Input aria-label="Quantidade de Curar no Dano"
              type="number" min={0}
              max={value.heal_on_damage_mode === "percent" ? 1000 : 1000000}
              step={value.heal_on_damage_mode === "percent" ? "0.1" : "1"}
              disabled={disabled}
              value={value.heal_on_damage_amount}
              onChange={(event) => onChange((current) => ({
                ...current,
                heal_on_damage_amount: Math.max(0, Math.min(
                  current.heal_on_damage_mode === "percent" ? 1000 : 1000000,
                  current.heal_on_damage_mode === "fixed"
                    ? Math.floor(Number(event.target.value) || 0)
                    : Number(event.target.value) || 0,
                )),
              }))} />
          </label>
        </div>
      )}
    </section>
  );
}

export function onHitHealingDescription(value: AbilityAttackDamageConfig): string | null {
  if (!value.heal_on_damage_enabled || value.heal_on_damage_amount <= 0) return null;
  return value.heal_on_damage_mode === "percent"
    ? `Cura ${value.heal_on_damage_amount}% do dano final causado a cada acerto`
    : `Cura ${value.heal_on_damage_amount} HP por alvo acertado`;
}
