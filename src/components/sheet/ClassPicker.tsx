import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Shield } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useClasses, useDefs, type Character, type ClassTrait, type Trait } from "@/lib/sheets";
import { parseAbilityEffects, useAbilities } from "@/lib/abilities";
import { ModsList } from "@/components/sheet/RacePicker";
import { TransformationGrantPicker } from "@/components/transformations/TransformationGrantPicker";

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
  const { data: transformationCatalog = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ["transformations", "class-picker"],
    queryFn: async () => {
      const { data, error } = await db.from("transformations").select("id,name").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: classTransformationRows = [] } = useQuery<Array<{ class_id: string; transformation_id: string }>>({
    queryKey: ["class-transformations", "all-class-picker"],
    queryFn: async () => {
      const { data, error } = await db.from("class_transformations").select("class_id,transformation_id");
      if (error) throw error;
      return data ?? [];
    },
  });
  const [pendingClassId, setPendingClassId] = useState<string | null>(character.class_id ?? null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setPendingClassId(character.class_id ?? null), [character.id, character.class_id]);

  if (!classes || !defs) return null;
  if (!isMaster && character.class_id) return null;

  async function confirmClass() {
    if (!isMaster && !pendingClassId) {
      toast.error("Selecione uma classe antes de confirmar");
      return;
    }
    if (pendingClassId === (character.class_id ?? null)) return;
    setBusy(true);
    const { error } = await db.rpc("choose_character_class", {
      _character_id: character.id,
      _class_id: pendingClassId,
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
          <Button size="sm" disabled={busy || pendingClassId === (character.class_id ?? null) || (!isMaster && !pendingClassId) || (noClasses && !pendingClassId)} onClick={() => void confirmClass()}>
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
            const grantedTransformations = transformationCatalog.filter((transformation) => classTransformationRows.some((row) => row.class_id === classTrait.id && row.transformation_id === transformation.id));
            return (
              <article key={classTrait.id} className={`rounded-lg border p-3 transition-colors ${selected ? "border-gold bg-gold/5" : "border-border"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold">{classTrait.name}</div>
                    {classTrait.description && <p className="mt-1 text-xs text-muted-foreground">{classTrait.description}</p>}
                  </div>
                  <Button size="sm" variant={selected ? "default" : "outline"} className="shrink-0" disabled={busy || lockedForPlayer} onClick={() => setPendingClassId(classTrait.id)}>
                    {selected ? <><Check className="mr-1 h-3.5 w-3.5" /> Selecionada</> : "Selecionar"}
                  </Button>
                </div>
                <div className="mt-2">
                  <ModsList
                    race={classTrait as Trait}
                    defs={defs}
                    abilities={grantedAbilities}
                    transformations={grantedTransformations}
                    startingEffects={parseAbilityEffects(classTrait.starting_effects)}
                  />
                </div>
              </article>
            );
          })}
        </div>
      )}
      {isMaster && pendingClassId && <TransformationGrantPicker scope="class" traitId={pendingClassId} />}
    </section>
  );
}
