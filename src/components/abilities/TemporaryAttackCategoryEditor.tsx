import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import { AbilityDotEffectsEditor } from "@/components/abilities/SheetAbilityAttackEditor";
import type { AbilityEffectDefinition, AbilityDotEffect, AbilityAttackEffectGroup } from "@/lib/abilities";
import type { useDefs } from "@/lib/sheets";

type DamageType = { id: string; name: string; category: string };

export function TemporaryAttackCategoryEditor({
  group, targetName, checked, expanded, disabled, summary,
  effects, dots, defs, damageTypes,
  onCheckedChange, onExpandedChange, onEffectsChange, onDotsChange,
}: {
  group: AbilityAttackEffectGroup;
  targetName: string;
  checked: boolean;
  expanded: boolean;
  disabled: boolean;
  summary: string;
  effects: AbilityEffectDefinition[];
  dots: AbilityDotEffect[];
  defs: NonNullable<ReturnType<typeof useDefs>["data"]>;
  damageTypes: DamageType[];
  onCheckedChange: (next: boolean) => void;
  onExpandedChange: () => void;
  onEffectsChange: (next: AbilityEffectDefinition[]) => void;
  onDotsChange: (next: AbilityDotEffect[]) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border/70 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2">
          <input type="checkbox" className="mt-1" disabled={disabled}
            checked={checked} onChange={(event) => onCheckedChange(event.target.checked)} />
          <span className="min-w-0">
            <span className="block font-medium">{group.name} — {group.chance}% de chance</span>
            <span className="mt-1 block text-xs text-muted-foreground">{summary}</span>
            <span className="mt-1 block text-[11px] text-muted-foreground">Marque esta categoria se os efeitos acertaram este alvo.</span>
          </span>
        </label>
        <Button size="sm" type="button" variant="outline" disabled={disabled}
          aria-expanded={expanded} onClick={onExpandedChange}>
          {expanded ? <ChevronUp className="mr-1 h-3.5 w-3.5" /> : <ChevronDown className="mr-1 h-3.5 w-3.5" />}
          {expanded ? "Minimizar" : "Maximizar"}
        </Button>
      </div>
      {expanded && (
        <div className="space-y-3 border-t border-violet-500/30 pt-3">
          <p className="text-xs text-amber-400">
            Ajustes temporários apenas para este ataque contra {targetName}. Não alteram a habilidade salva.
            Após Causar o Ataque, esta seção será minimizada e os ajustes descartados.
          </p>
          <AbilityEffectsEditor
            effects={effects}
            onChange={onEffectsChange}
            defs={defs}
            title="Efeitos deste ataque"
            description="Edite os efeitos que esta categoria aplicará neste acerto."
          />
          <AbilityDotEffectsEditor
            dots={dots}
            onChange={onDotsChange}
            defs={defs}
            physicalTypes={damageTypes.filter((type) => type.category === "physical")}
            magicalTypes={damageTypes.filter((type) => type.category === "magical")}
            title="DoTs deste ataque"
            description="Altere o dano por turno, tipo, duração e outros valores para esta aplicação."
          />
        </div>
      )}
    </div>
  );
}
