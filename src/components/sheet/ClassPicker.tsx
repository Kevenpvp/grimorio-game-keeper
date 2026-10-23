import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Shield } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { numberAllocation, useClasses, useDefs, type Character, type ClassTrait } from "@/lib/sheets";
import { parseAbilityEffects, useAbilities } from "@/lib/abilities";
import { ModsList } from "@/components/sheet/RacePicker";

export function ClassPicker({ character, isMaster }: { character: Character; isMaster: boolean }) {
  const qc = useQueryClient();
  const { data: classes } = useClasses();
  const { data: defs } = useDefs();
  const { data: abilities = [] } = useAbilities();
  const db = supabase as any;
  const { data: classAbilityRows = [] } = useQuery<Array<{ class_id: string; ability_id: string }>>({
    queryKey: ["class-abilities", "character-picker"],
    queryFn: async () => {
      const { data, error } = await db.from("class_abilities").select("class_id,ability_id");
      if (error) throw error;
      return data ?? [];
    },
  });
  const [pendingClassId, setPendingClassId] = useState<string | null>(character.class_id ?? null);
  const [pendingClassModifiers, setPendingClassModifiers] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(numberAllocation(character.class_custom_modifiers)).map(([key, value]) => [key, String(value)]))
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPendingClassId(character.class_id ?? null);
    setPendingClassModifiers(Object.fromEntries(Object.entries(numberAllocation(character.class_custom_modifiers)).map(([key, value]) => [key, String(value)])));
  }, [character.id, character.class_id, character.class_custom_modifiers]);

  if (!classes || !defs) return null;
  if (!isMaster && character.class_id) return null;

  async function confirmClass() {
    if (!isMaster && !pendingClassId) {
      toast.error("Selecione uma classe antes de confirmar");
      return;
    }
    const cleanCustomModifiers: Record<string, number> = {};
    if (isMaster && pendingClassId !== null) {
      for (const definition of defs ?? []) {
        const raw = pendingClassModifiers[definition.key];
        const value = raw === undefined || raw.trim() === "" ? 0 : Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > 1000000 || Math.floor(value) !== value) {
          toast.error(`O bônus de ${definition.label} deve ser um inteiro de 0 a 1.000.000.`);
          return;
        }
        if (value > 0) cleanCustomModifiers[definition.key] = value;
      }
    }
    const currentCustom = numberAllocation(character.class_custom_modifiers);
    const customChanged = JSON.stringify(Object.fromEntries(Object.entries(cleanCustomModifiers).sort(([a], [b]) => a.localeCompare(b))))
      !== JSON.stringify(Object.fromEntries(Object.entries(currentCustom).sort(([a], [b]) => a.localeCompare(b))));
    if (pendingClassId === (character.class_id ?? null) && (!isMaster || !customChanged)) return;
    setBusy(true);
    const { error } = await db.rpc("choose_character_class", {
      _character_id: character.id,
      _class_id: pendingClassId,
      _custom_modifiers: cleanCustomModifiers,
    });
    if (error) {
      toast.error(error.message);
      setBusy(false);
      return;
    }
    toast.success("Classe confirmada!");
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["character", character.id] }),
      qc.invalidateQueries({ queryKey: ["characters"] }),
      qc.invalidateQueries({ queryKey: ["my-character"] }),
      qc.invalidateQueries({ queryKey: ["character-abilities", character.id] }),
      qc.invalidateQueries({ queryKey: ["character-abilities-battle"] }),
      qc.invalidateQueries({ queryKey: ["character-active-effects", character.id] }),
      qc.invalidateQueries({ queryKey: ["classes"] }),
    ]);
    setBusy(false);
  }

  const noClasses = classes.length === 0;
  return (
    <section className="panel space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="rounded-lg bg-gold/10 p-2 text-gold"><Shield className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg text-gold">{isMaster ? "Classe da ficha" : "Escolha sua Classe"}</h2>
          <p className="text-xs text-muted-foreground">A classe é independente da raça e da virtude. Os pontos, modificadores, habilidades e efeitos são aplicados separadamente.</p>
        </div>
        <div className="flex items-center gap-2">
          {isMaster && pendingClassId && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPendingClassId(null)}>Nenhuma</Button>}
          <Button size="sm" disabled={busy || (!isMaster && pendingClassId === (character.class_id ?? null)) || (!isMaster && !pendingClassId) || (noClasses && !pendingClassId)} onClick={() => void confirmClass()}>
            <Check className="mr-1 h-3.5 w-3.5" /> {busy ? "Confirmando..." : "Confirmar classe"}
          </Button>
        </div>
      </div>
      {noClasses ? <p className="text-sm text-muted-foreground">Nenhuma classe cadastrada ainda. Peça ao mestre para cadastrar uma.</p> : (
        <div className="grid gap-3 sm:grid-cols-2">
          {classes.map((classTrait: ClassTrait) => {
            const selected = pendingClassId === classTrait.id;
            const lockedForPlayer = !isMaster && !!character.class_id && classTrait.id !== character.class_id;
            const grantedAbilities = abilities.filter((ability) => classAbilityRows.some((row) => row.class_id === classTrait.id && row.ability_id === ability.id));
            return (
              <article key={classTrait.id} className={`rounded-lg border p-3 transition-colors ${selected ? "border-gold bg-gold/5" : "border-border"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold">{classTrait.name}</div>
                    {classTrait.description && <p className="mt-1 text-xs text-muted-foreground">{classTrait.description}</p>}
                  </div>
                  <Button size="sm" variant={selected ? "default" : "outline"} className="shrink-0" disabled={busy || lockedForPlayer} onClick={() => {
                     setPendingClassId(classTrait.id);
                     setPendingClassModifiers(classTrait.id === character.class_id
                       ? Object.fromEntries(Object.entries(numberAllocation(character.class_custom_modifiers)).map(([key, value]) => [key, String(value)]))
                       : {});
                   }}>
                    {selected ? <><Check className="mr-1 h-3.5 w-3.5" /> Selecionada</> : "Selecionar"}
                  </Button>
                </div>
                <div className="mt-2">
                  <ModsList
                    race={classTrait}
                    defs={defs}
                    abilities={grantedAbilities}
                    startingEffects={parseAbilityEffects(classTrait.starting_effects)}
                  />
                </div>
                {isMaster && selected && (
                  <div className="mt-3 space-y-2 rounded-md border border-gold/25 bg-gold/5 p-3">
                    <div>
                      <div className="text-xs font-semibold text-gold">Bônus extras desta ficha</div>
                      <p className="mt-1 text-[11px] text-muted-foreground">Só afeta este personagem enquanto ele tiver esta classe. Os modificadores base da classe continuam iguais para todos.</p>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {defs.filter((definition) => definition.key !== "hp" && definition.key !== "mana").map((definition) => (
                        <label key={definition.key} className="space-y-1 text-xs font-medium">
                          + {definition.label}
                          <input
                            aria-label={`Bônus extra de ${definition.label} nesta ficha`}
                            type="number" min={0} max={1000000} step={1}
                            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                            value={pendingClassModifiers[definition.key] ?? ""}
                            disabled={busy}
                            onChange={(event) => setPendingClassModifiers((current) => ({ ...current, [definition.key]: event.target.value }))}
                            placeholder="0"
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
