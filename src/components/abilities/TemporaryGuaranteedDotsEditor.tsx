import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AbilityDotEffectsEditor } from "@/components/abilities/SheetAbilityAttackEditor";
import type { AbilityDotEffect } from "@/lib/abilities";
import type { useDefs } from "@/lib/sheets";

type DamageType = { id: string; name: string; category: string };

/** The same temporary attack editor, but for DoTs outside chance categories. */
export function TemporaryGuaranteedDotsEditor({
  targetName, dots, expanded, disabled, onToggle, onChange, defs, damageTypes,
}: {
  targetName: string;
  dots: AbilityDotEffect[];
  expanded: boolean;
  disabled: boolean;
  onToggle: () => void;
  onChange: (dots: AbilityDotEffect[]) => void;
  defs: NonNullable<ReturnType<typeof useDefs>["data"]>;
  damageTypes: DamageType[];
}) {
  return (
    <section className="space-y-2 rounded-md border border-orange-500/30 bg-orange-500/5 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-gold">DoTs garantidos (fora do ataque)</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Aplicados em {targetName} mesmo se o ataque não acertar.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {dots.length
              ? dots.map((dot) => {
                  const damage = dot.damage_mode === "percent"
                    ? `${dot.damage_amount}% do HP máximo`
                    : dot.damage_mode === "attribute"
                      ? `${dot.attribute_percent}% de ${dot.attribute_key ?? "atributo"} + ${dot.fixed_damage}`
                      : `${dot.damage_amount} de dano`;
                  return `${dot.name}: ${damage}/turno · ${dot.duration} turno(s)`;
                }).join(" · ")
              : "Nenhum DoT nesta aplicação."}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={disabled}
          aria-expanded={expanded} onClick={onToggle}>
          {expanded ? <ChevronUp className="mr-1 h-3.5 w-3.5" /> : <ChevronDown className="mr-1 h-3.5 w-3.5" />}
          {expanded ? "Minimizar" : "Maximizar"}
        </Button>
      </div>
      {expanded && (
        <div className="space-y-3 border-t border-orange-500/30 pt-3">
          <p className="text-xs text-amber-400">
            Os ajustes são exclusivos deste alvo e deste golpe. Após Causar o Ataque, o editor
            será minimizado e a próxima aplicação usará novamente os valores salvos.
          </p>
          <AbilityDotEffectsEditor
            dots={dots}
            onChange={onChange}
            defs={defs}
            physicalTypes={damageTypes.filter((type) => type.category === "physical")}
            magicalTypes={damageTypes.filter((type) => type.category === "magical")}
            title="Modificar DoTs garantidos"
            description="Configure o dano e a duração nesta aplicação. O DoT cadastrado não será alterado."
          />
        </div>
      )}
    </section>
  );
}
