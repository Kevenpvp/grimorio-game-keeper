import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { AbilityEffectsEditor } from "@/components/abilities/AbilityEffectsEditor";
import { type AbilityEffectDefinition, useDotTemplates } from "@/lib/abilities";
import { useDefs } from "@/lib/sheets";
import type { Json } from "@/integrations/supabase/types";

type PermanentDotDraft = {
  templateId: string;
  damageMode: "fixed" | "percent";
  amount: string;
};

export function CharacterSheetEffectsManager({ characterId, characterName }: {
  characterId: string;
  characterName: string;
}) {
  const qc = useQueryClient();
  const { data: defs = [] } = useDefs();
  const { data: dotTemplates = [], isLoading: loadingDotTemplates } = useDotTemplates();
  const [effects, setEffects] = useState<AbilityEffectDefinition[]>([]);
  const [dots, setDots] = useState<PermanentDotDraft[]>([]);
  const [selectedDotTemplateId, setSelectedDotTemplateId] = useState("");
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const { data: permanentEffects = [], isLoading, refetch } = useQuery({
    queryKey: ["manual-sheet-effects", characterId],
    queryFn: async () => {
      const { data, error } = await supabase.from("battle_effects")
        .select("id,name,effect_type,duration,is_sheet_permanent,source_race_id,source_class_id,source_virtue_id,effect_data")
        .eq("character_id", characterId)
        .is("battle_id", null)
        .eq("is_sheet_permanent", true)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  async function applyPermanentEffects() {
    if (effects.length === 0 && dots.length === 0) {
      toast.error("Adicione pelo menos um efeito ou DoT permanente.");
      return;
    }

    const dotPayload = dots.map((dot) => {
      const template = dotTemplates.find((item) => item.id === dot.templateId);
      if (!template) throw new Error("Selecione um modelo válido para cada DoT.");
      const amount = Number(dot.amount);
      const max = dot.damageMode === "percent" ? 1000 : 1_000_000;
      if (!Number.isFinite(amount) || amount <= 0 || amount > max ||
          (dot.damageMode === "fixed" && !Number.isInteger(amount))) {
        throw new Error("Informe um valor válido para o DoT " + template.name + ".");
      }
      return {
        id: template.id,
        template_id: template.id,
        name: template.name,
        damage_kind: template.damage_kind,
        physical_damage_type_id: template.physical_damage_type_id,
        damage_type_id: template.damage_type_id,
        magic_level: template.magic_level,
        damage_mode: dot.damageMode,
        damage_amount: amount,
        duration: 1,
      };
    });

    setSaving(true);
    try {
      const permanentDefinitions = effects.map((effect) => ({
        ...effect,
        target_scope: "target",
        remove_on_attack: false,
        until_combat_end: false,
      }));
      const { data, error } = await supabase.rpc("apply_manual_character_effects", {
        _character_id: characterId,
        _effects: permanentDefinitions as unknown as Json,
        _dots: dotPayload as unknown as Json,
        _permanent: true,
      });
      if (error) throw error;

      const count = Number(data ?? 0);
      if (count < 1) {
        toast.info("Nenhum efeito foi aplicado. Verifique a imunidade a DoTs do personagem.");
      } else {
        toast.success(count + " efeito(s)/DoT(s) permanente(s) aplicado(s) à ficha de " + characterName + ".");
      }
      setEffects([]);
      setDots([]);
      await Promise.all([
        refetch(),
        qc.invalidateQueries({ queryKey: ["manual-sheet-effects", characterId] }),
        qc.invalidateQueries({ queryKey: ["character-active-effects"] }),
        qc.invalidateQueries({ queryKey: ["character", characterId] }),
        qc.invalidateQueries({ queryKey: ["characters"] }),
        qc.invalidateQueries({ queryKey: ["my-character"] }),
        qc.invalidateQueries({ queryKey: ["battles"] }),
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error), { duration: 10000 });
    } finally {
      setSaving(false);
    }
  }

  async function removePermanentEffect(effect: (typeof permanentEffects)[number]) {
    if (effect.source_race_id || effect.source_class_id || effect.source_virtue_id) {
      toast.error("Este efeito pertence a uma raça, classe ou virtude. Remova ou troque o traço para removê-lo.");
      return;
    }
    setRemovingId(effect.id);
    try {
      const { data, error } = await supabase.rpc("remove_manual_character_effect", { _effect_id: effect.id });
      if (error) throw error;
      if (data !== true) {
        toast.error("O efeito já não está na ficha.");
      } else {
        toast.success("Efeito permanente removido da ficha.");
      }
      await Promise.all([
        refetch(),
        qc.invalidateQueries({ queryKey: ["character-active-effects"] }),
        qc.invalidateQueries({ queryKey: ["character", characterId] }),
        qc.invalidateQueries({ queryKey: ["battles"] }),
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRemovingId(null);
    }
  }

  function addDot() {
    if (!selectedDotTemplateId) {
      toast.error("Cadastre e selecione um modelo de DoT primeiro.");
      return;
    }
    setDots((current) => [...current, { templateId: selectedDotTemplateId, damageMode: "fixed", amount: "10" }]);
  }

  return (
    <section className="panel space-y-4 p-4">
      <div>
        <h2 className="text-xl text-gold">Efeitos permanentes da ficha</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Área exclusiva para o mestre conceder buffs, debuffs ou DoTs que continuam ativos fora de combate. Isso é separado do painel Aplicar dano.
        </p>
      </div>

      <div className="space-y-4 rounded-md border border-border p-3">
        <AbilityEffectsEditor
          effects={effects}
          onChange={setEffects}
          permanent
          defs={defs}
          title="Novos efeitos permanentes"
          description="Eles permanecem na ficha até o mestre removê-los. Não expiram por turnos, ataques ou fim de combate."
          allowHealing={false}
          allowPermanentMagicProhibition
          hideTargeting
          permanentNote="Permanente na ficha; somente o mestre pode remover."
        />

        <div className="space-y-3 rounded-md border border-border p-3">
          <div>
            <h3 className="text-sm font-semibold">DoTs permanentes</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Um DoT permanente causa dano nos turnos aplicáveis até o mestre removê-lo da ficha.
            </p>
          </div>
          {loadingDotTemplates ? (
            <p className="text-xs text-muted-foreground">Carregando modelos de DoT…</p>
          ) : dotTemplates.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhum modelo cadastrado. Crie um na página Dano por Turno.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <select className="h-9 min-w-48 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                value={selectedDotTemplateId}
                onChange={(event) => setSelectedDotTemplateId(event.target.value)}>
                <option value="">Selecione um DoT</option>
                {dotTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} — {template.damage_kind === "physical" ? "Físico" : "Mágico"}
                  </option>
                ))}
              </select>
              <Button type="button" size="sm" variant="outline" onClick={addDot}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Adicionar DoT
              </Button>
            </div>
          )}
          {dots.map((dot, index) => {
            const template = dotTemplates.find((item) => item.id === dot.templateId);
            return (
              <div key={index} className="grid gap-2 rounded-md border border-border/70 p-2 sm:grid-cols-[minmax(0,1fr)_140px_120px_auto] sm:items-end">
                <label className="space-y-1 text-xs font-medium">
                  Modelo de DoT
                  <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={dot.templateId}
                    onChange={(event) => setDots((current) => current.map((item, i) => i === index ? { ...item, templateId: event.target.value } : item))}>
                    {dotTemplates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                  <span className="block text-muted-foreground">
                    {template?.damage_kind === "physical" ? "Físico" : "Mágico"}{template?.magic_level ? " · magia " + template.magic_level : ""}
                  </span>
                </label>
                <label className="space-y-1 text-xs font-medium">
                  Cálculo
                  <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={dot.damageMode}
                    onChange={(event) => setDots((current) => current.map((item, i) => i === index ? { ...item, damageMode: event.target.value as "fixed" | "percent" } : item))}>
                    <option value="fixed">Dano fixo</option>
                    <option value="percent">% do HP</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs font-medium">
                  Dano por turno
                  <Input type="number" min={1} max={dot.damageMode === "percent" ? 1000 : 1000000} value={dot.amount}
                    onChange={(event) => setDots((current) => current.map((item, i) => i === index ? { ...item, amount: event.target.value } : item))} />
                </label>
                <Button type="button" variant="ghost" size="icon" aria-label="Remover DoT da lista" onClick={() => setDots((current) => current.filter((_, i) => i !== index))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
        </div>

        <Button type="button" disabled={saving || (effects.length === 0 && dots.length === 0)} onClick={() => void applyPermanentEffects()}>
          <CheckCircle2 className="mr-1 h-4 w-4" /> {saving ? "Aplicando…" : "Aplicar efeitos permanentes à ficha"}
        </Button>
      </div>

      <div className="space-y-3 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Efeitos persistentes atuais ({permanentEffects.length})</h3>
          <Button type="button" size="sm" variant="outline" disabled={isLoading} onClick={() => void refetch()}>Atualizar lista</Button>
        </div>
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Carregando efeitos…</p>
        ) : permanentEffects.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum efeito permanente nesta ficha.</p>
        ) : (
          <div className="space-y-2">
            {permanentEffects.map((effect) => {
              const traitOwned = Boolean(effect.source_race_id || effect.source_class_id || effect.source_virtue_id);
              const traitName = effect.source_class_id ? "classe" : effect.source_race_id ? "raça" : effect.source_virtue_id ? "virtude" : null;
              return (
                <div key={effect.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/70 p-3">
                  <div className="min-w-0">
                    <div className="font-medium">{effect.name}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {effect.effect_type === "damage_over_time" ? "Dano por turno" : effect.effect_type.replaceAll("_", " ")}
                      {traitName ? " · Concedido pela " + traitName : " · Aplicado diretamente pelo mestre"}
                    </div>
                  </div>
                  {!traitOwned && (
                    <Button type="button" size="sm" variant="destructive" disabled={removingId === effect.id}
                      onClick={() => void removePermanentEffect(effect)}>
                      <Trash2 className="mr-1 h-3.5 w-3.5" /> {removingId === effect.id ? "Removendo…" : "Remover"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
