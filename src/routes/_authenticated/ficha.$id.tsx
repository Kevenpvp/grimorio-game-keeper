import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Check, Eye, Minus, Plus, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { dispatchCustomAbilityScriptEvents } from "@/lib/ability-script-runtime";
import { effectiveHpTotal } from "@/lib/hp-total";
import {
  clampPct, clampNonDefenseAttribute, computeValue, conditionAdjustedValue, physicalAttributePoints, useCharacter, useCharacterLive, useCharacterTraitMods, useDefs, useMe,
  type AttributeDef, type Character, type CharacterAttr,
} from "@/lib/sheets";
import { CharacterSheetView, Portrait } from "@/components/sheet/CharacterSheetView";
import { SheetSectionTabs, SheetTabPanel, type SheetTabKey } from "@/components/sheet/SheetSectionTabs";
import { PointsDistribution } from "@/components/sheet/PointsDistribution";
import { PhysicalPointsDistribution } from "@/components/sheet/PhysicalPointsDistribution";
import { RacePicker } from "@/components/sheet/RacePicker";
import { ClassPicker } from "@/components/sheet/ClassPicker";
import { AttrIcon, barTone } from "@/components/sheet/icons";
import { StatBar } from "@/components/sheet/StatBar";
import { DamageApplier } from "@/components/combat/DamageApplier";
import { CharacterSheetEffectsManager } from "@/components/sheet/CharacterSheetEffectsManager";
import { passiveEffectTypeActive, passiveStatusModifiers, statusEffectModifiers, useCharacterAbilities, useCharacterActiveEffects } from "@/lib/abilities";
import { CharacterAbilitiesManager, CharacterAbilitiesPanel } from "@/components/abilities/CharacterAbilities";
import { CharacterTransformationImages } from "@/components/transformations/CharacterTransformationImages";
import { SummonGrantsEditor } from "@/components/summons/Summons";

export const Route = createFileRoute("/_authenticated/ficha/$id")({
  head: () => ({
    meta: [
      { title: "Ficha — Grimório" },
      { name: "description", content: "Ficha de personagem." },
      { property: "og:title", content: "Ficha — Grimório" },
      { property: "og:description", content: "Ficha de personagem." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: FichaPage,
});

function FichaPage() {
  const { id } = Route.useParams();
  const { data: me } = useMe();
  const { data, isLoading } = useCharacter(id);
  const { data: defs } = useDefs();
  useCharacterLive(id);
  const [playerTab, setPlayerTab] = useState<SheetTabKey>("overview");

  if (isLoading || !me || !defs) return <p className="text-muted-foreground">Carregando…</p>;
  if (!data?.character)
    return (
      <div className="panel mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl text-gold">Ficha não encontrada</h1>
        <Link to="/painel" className="mt-4 inline-block text-sm text-muted-foreground hover:text-gold">Voltar</Link>
      </div>
    );
  if (!me.isMaster)
    return (
      <div className="min-w-0 space-y-4">
        <header className="grimorio-section-header flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Link to="/painel" className="flex min-h-9 items-center gap-1 text-xs text-muted-foreground hover:text-gold"><ArrowLeft className="h-4 w-4" /> Todas as fichas</Link>
            <h1 className="truncate font-display text-2xl text-gold sm:text-3xl">{data.character.name}</h1>
            <p className="text-xs text-muted-foreground">Minha ficha · escolha uma seção abaixo</p>
          </div>
        </header>
        <SheetSectionTabs active={playerTab} onChange={setPlayerTab} tabs={[
          { key: "overview", label: "Resumo" },
          { key: "points", label: "Pontos", badge: data.character.available_points },
          { key: "origin", label: "Origem" },
          { key: "abilities", label: "Habilidades" },
          { key: "transformations", label: "Transformações" },
        ]} />
        <SheetTabPanel tab="overview" active={playerTab}>
          <CharacterSheetView character={data.character} attrs={data.attrs} defs={defs} />
        </SheetTabPanel>
        <SheetTabPanel tab="points" active={playerTab}>
          <section className="space-y-3">
            <h2 className="text-lg text-gold">Distribuir pontos físicos</h2>
            <p className="text-xs text-muted-foreground">Pontos específicos de Força, Defesa, Velocidade e Velocidade de Ataque.</p>
            <PhysicalPointsDistribution character={data.character} attrs={data.attrs} defs={defs} />
          </section>
          {(data.character.available_points > 0 || data.character.race_points_granted > 0 || data.character.virtue_points_granted > 0 || (data.character.class_points_granted ?? 0) > 0) && (
            <section className="space-y-3">
              <h2 className="text-lg text-gold">Pontos gerais</h2>
              <PointsDistribution character={data.character} attrs={data.attrs} defs={defs} />
            </section>
          )}
        </SheetTabPanel>
        <SheetTabPanel tab="origin" active={playerTab}>
          <RacePicker character={data.character} isMaster={false} />
          <ClassPicker character={data.character} isMaster={false} />
          {data.character.race_id && data.character.virtue_id && data.character.class_id && (
            <p className="panel p-4 text-xs text-muted-foreground">Raça, Virtude e Classe já estão confirmadas. Seus bônus aparecem no Resumo.</p>
          )}
        </SheetTabPanel>
        <SheetTabPanel tab="abilities" active={playerTab}>
          <CharacterAbilitiesManager characterId={data.character.id} personalOnly />
          <SummonGrantsEditor characterId={data.character.id} master={false} />
          <CharacterAbilitiesPanel characterId={data.character.id} characterName={data.character.name} mode="sheet" canUse={false} allowCustomAttributeEdit />
        </SheetTabPanel>
        <SheetTabPanel tab="transformations" active={playerTab}>
          <CharacterTransformationImages character={data.character} />
        </SheetTabPanel>
      </div>
    );
  return <Editor character={data.character} attrs={data.attrs} defs={defs} />;
}

function useSaved() {
  const [at, setAt] = useState<number | null>(null);
  return { savedAt: at, mark: () => setAt(Date.now()) };
}

function Editor({ character, attrs, defs }: { character: Character; attrs: CharacterAttr[]; defs: AttributeDef[] }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { savedAt, mark } = useSaved();
  const [preview, setPreview] = useState(false);
  const [tab, setTab] = useState<SheetTabKey>("overview");
  const [info, setInfo] = useState({
    name: character.name,
    player_name: character.player_name,
    description: character.description ?? "",
    owner_id: character.owner_id,
  });
  useEffect(() => {
    setInfo({ name: character.name, player_name: character.player_name, description: character.description ?? "", owner_id: character.owner_id });
  }, [character.id, character.name, character.player_name, character.description, character.owner_id]);

  const { data: profiles } = useQuery({
    queryKey: ["profiles"],
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("id, display_name, email").order("display_name");
      return data ?? [];
    },
  });

  const { data: sourceCharacters = [] } = useQuery({
    queryKey: ["damage-source-characters"],
    queryFn: async () => {
      const { data, error } = await supabase.from("characters").select("id,name").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["character", character.id] });
    qc.invalidateQueries({ queryKey: ["characters"] });
  };

  async function updateCharacter(patch: Partial<Character>) {
    const { error } = await supabase.from("characters").update(patch).eq("id", character.id);
    if (error) { toast.error(error.message); return false; }
    mark();
    refresh();
    return true;
  }

  async function saveInfo() {
    if (!info.name.trim()) { toast.error("Informe o nome do personagem"); return; }
    const ok = await updateCharacter({
      name: info.name.trim(),
      player_name: info.player_name.trim(),
      description: info.description.trim() || null,
      owner_id: info.owner_id,
    });
    if (ok) toast.success("Informações salvas");
  }

  const fileRef = useRef<HTMLInputElement>(null);
  async function upload(file: File) {
    if (!file.type.startsWith("image/")) { toast.error("Envie uma imagem"); return; }
    const ext = file.name.split(".").pop() || "jpg";
    const path = `${character.id}/${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from("character-photos").upload(path, file, { contentType: file.type });
    if (error) { toast.error("Falha no envio: " + error.message); return; }
    const old = character.photo_path;
    if (await updateCharacter({ photo_path: path })) {
      if (old) await supabase.storage.from("character-photos").remove([old]);
      toast.success("Foto atualizada");
    }
  }

  async function remove() {
    if (character.photo_path) await supabase.storage.from("character-photos").remove([character.photo_path]);
    const { error } = await supabase.from("characters").delete().eq("id", character.id);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries({ queryKey: ["characters"] });
    toast.success("Ficha excluída");
    navigate({ to: "/painel" });
  }

  const byKey = new Map(attrs.map((a) => [a.attribute_key, a]));
  const { mods, raceModifiers, classModifiers, virtueModifiers } = useCharacterTraitMods(character.race_id, character.virtue_id, character.class_id, character.class_custom_modifiers);
  const { data: characterAbilities = [] } = useCharacterAbilities(character.id);
  const { data: activeEffects = [] } = useCharacterActiveEffects(character.id);
  const passiveStatus = passiveStatusModifiers(characterAbilities);
  const noMana = (activeEffects ?? []).some((effect) => effect.effect_type === "no_mana" && effect.polarity === "debuff")
    || passiveEffectTypeActive(characterAbilities, "no_mana");

  return (
    <div className="space-y-6">
      <div className="grimorio-section-header flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <Link to="/painel" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-gold">
            <ArrowLeft className="h-4 w-4" /> Todas as fichas
          </Link>
          <h1 className="max-w-[80vw] truncate font-display text-2xl text-gold sm:text-3xl">{character.name}</h1>
          <p className="text-xs text-muted-foreground">Ficha do mestre · {character.player_name || "Sem jogador"} · {character.available_points} pontos livres</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SavedBadge savedAt={savedAt} />
          <Button variant="outline" size="sm" onClick={() => setPreview((p) => !p)}>
            <Eye className="mr-1 h-4 w-4" /> {preview ? "Editar" : "Ver como jogador"}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm"><Trash2 className="mr-1 h-4 w-4" /> Excluir</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Excluir {character.name}?</AlertDialogTitle>
                <AlertDialogDescription>A ficha e a foto serão apagadas permanentemente.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                <AlertDialogAction onClick={remove}>Excluir</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>


      {preview ? (
        <div className="space-y-4">
          <div className="panel flex flex-wrap items-center justify-between gap-2 p-3">
            <p className="text-sm text-muted-foreground">Prévia da ficha na visão de jogador.</p>
            <Button variant="outline" size="sm" onClick={() => setPreview(false)}>Voltar à edição</Button>
          </div>
          <CharacterSheetView character={character} attrs={attrs} defs={defs} />
          <SummonGrantsEditor characterId={character.id} master={false} />
          <CharacterAbilitiesPanel characterId={character.id} characterName={character.name} mode="sheet" canUse />
        </div>
      ) : (
        <>
          <SheetSectionTabs active={tab} onChange={setTab} tabs={[
            { key: "overview", label: "Resumo" },
            { key: "attributes", label: "Atributos", badge: character.available_points },
            { key: "origin", label: "Origem" },
            { key: "abilities", label: "Habilidades" },
            { key: "transformations", label: "Transformações" },
            { key: "resources", label: "Recursos" },
          ]} />

          <SheetTabPanel tab="overview" active={tab}>
            <div className="space-y-1">
              <h2 className="font-display text-xl text-gold">Identidade do personagem</h2>
              <p className="text-xs text-muted-foreground">Nome, imagem, jogador responsável e uma prévia dos atributos.</p>
            </div>
          <section className="panel grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 border-gold/35 p-4 sm:p-6 md:grid-cols-[175px_minmax(0,1fr)]">
            <div className="min-w-0 space-y-2">
              <Portrait path={character.photo_path} name={character.name} className="mx-auto aspect-[3/4] w-32 max-w-full rounded-xl border border-gold/30 sm:w-44" />
              <input ref={fileRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
              <Button variant="outline" size="sm" className="w-full" onClick={() => fileRef.current?.click()}>
                <Upload className="mr-1 h-4 w-4" /> {character.photo_path ? "Trocar foto" : "Enviar foto"}
              </Button>
            </div>
            <div className="grid min-w-0 w-full max-w-full grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
              <div className="min-w-0 space-y-1.5">
                <Label>Nome do personagem</Label>
                <Input className="min-w-0 max-w-full" value={info.name} onChange={(e) => setInfo({ ...info, name: e.target.value })} />
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label>Nome do jogador</Label>
                <Input className="min-w-0 max-w-full" value={info.player_name} onChange={(e) => setInfo({ ...info, player_name: e.target.value })} />
              </div>
              <div className="min-w-0 space-y-1.5 sm:col-span-2">
                <Label>Conta do jogador vinculada</Label>
                <Select value={info.owner_id ?? "none"} onValueChange={(v) => setInfo({ ...info, owner_id: v === "none" ? null : v })}>
                  <SelectTrigger className="min-w-0 max-w-full overflow-hidden [&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0"
                    title={profiles?.find((profile) => profile.id === info.owner_id)?.email ?? undefined}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-w-[calc(100vw-2rem)]">
                    <SelectItem value="none">Nenhuma</SelectItem>
                    {profiles?.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.display_name} {p.email ? `(${p.email})` : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0 space-y-1.5 sm:col-span-2">
                <Label>Descrição</Label>
                <Textarea className="min-w-0 max-w-full" rows={3} value={info.description} onChange={(e) => setInfo({ ...info, description: e.target.value })} />
              </div>
              <div className="min-w-0 sm:col-span-2">
                <Button className="max-w-full" onClick={saveInfo}>Salvar informações</Button>
              </div>
            </div>
          </section>
            <CharacterSheetView character={character} attrs={attrs} defs={defs} />
          </SheetTabPanel>

          <SheetTabPanel tab="attributes" active={tab}>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField label="Pontos disponíveis" icon="sparkles" value={character.available_points}
                onSave={(v) => updateCharacter({ available_points: v })} />
              <NumberField label="Abates" icon="flame" value={character.kills}
                onSave={(v) => updateCharacter({ kills: v })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <PercentEditor label="Corpo" icon="activity" tone={barTone("body")} value={character.body}
                onSave={(v) => updateCharacter({ body: v })} />
              <PercentEditor label="Sanidade" icon="eye" tone={barTone("sanity")} value={character.sanity}
                onSave={(v) => updateCharacter({ sanity: v })} />
            </div>
            <details className="panel p-3 sm:p-4" open>
              <summary className="min-h-10 text-sm font-semibold text-gold">Distribuição de pontos</summary>
              <div className="mt-3 space-y-4 border-t border-gold/15 pt-3">
                <PointsDistribution character={character} attrs={attrs} defs={defs} canRemove />
                <PhysicalPointsDistribution character={character} attrs={attrs} defs={defs} />
              </div>
            </details>
            <div className="space-y-3">
              <h2 className="font-display text-xl text-gold">Editar atributos individuais</h2>
              <p className="text-xs text-muted-foreground">Abra somente o grupo que deseja ajustar. As alterações mantêm as regras de bônus e valores máximos.</p>
              {[
              { key: "resources", label: "HP e Mana", hint: "Vida, Mana atual e seus limites", filter: (key: string) => key === "hp" || key === "mana" },
              { key: "physical", label: "Atributos físicos", hint: "Força, Defesa, Velocidade e ataques", filter: (key: string) => ["strength", "phys_def", "speed", "atk_speed"].includes(key) },
              { key: "magical", label: "Atributos mágicos e mentais", hint: "Poder mágico, defesa mágica e mente", filter: (key: string) => ["mag_dmg", "mag_def", "iq", "mental"].includes(key) },
              { key: "other", label: "Outros atributos", hint: "Atributos adicionais cadastrados", filter: (key: string) => !["hp", "mana", "strength", "phys_def", "speed", "atk_speed", "mag_dmg", "mag_def", "iq", "mental"].includes(key) },
            ].map((group) => {
                const entries = defs.filter((definition) => group.filter(definition.key));
                if (entries.length === 0) return null;
                return (
                  <details key={group.key} className="panel min-w-0 p-3 sm:p-4">
                    <summary className="flex min-h-10 cursor-pointer items-center justify-between gap-3 text-sm font-semibold text-gold">
                      <span>{group.label} <span className="text-xs text-muted-foreground">({entries.length})</span></span>
                    </summary>
                    <p className="mb-3 mt-1 text-xs text-muted-foreground">{group.hint}</p>
                    <div className="grid min-w-0 gap-3 lg:grid-cols-2">
                      {entries.map((d) => (
                <AttrEditor key={d.key} def={d} characterId={character.id} body={character.body} sanity={character.sanity} attr={byKey.get(d.key)} racePts={raceModifiers[d.key] ?? 0} virtuePts={virtueModifiers[d.key] ?? 0} classPts={classModifiers[d.key] ?? 0} physicalPts={physicalAttributePoints(character, d.key)} noMana={noMana && d.key === "mana"} statusModifier={{ fixed: (passiveStatus[d.key]?.fixed ?? 0) + statusEffectModifiers(activeEffects, d.key).fixed, percent: (passiveStatus[d.key]?.percent ?? 0) + statusEffectModifiers(activeEffects, d.key).percent }}
                  onSaved={() => { mark(); refresh(); }} />
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>
          </SheetTabPanel>

          <SheetTabPanel tab="origin" active={tab}>
            <div className="space-y-1">
              <h2 className="font-display text-xl text-gold">Raça, Virtude e Classe</h2>
              <p className="text-xs text-muted-foreground">As escolhas de origem ficam juntas, com seus pontos e habilidades concedidos.</p>
            </div>
            <RacePicker character={character} isMaster />
            <ClassPicker character={character} isMaster />
          </SheetTabPanel>

          <SheetTabPanel tab="abilities" active={tab}>
            <CharacterAbilitiesManager characterId={character.id} />
            <SummonGrantsEditor characterId={character.id} master />
          </SheetTabPanel>

          <SheetTabPanel tab="transformations" active={tab}>
            <CharacterTransformationImages character={character} isMaster />
          </SheetTabPanel>

          <SheetTabPanel tab="resources" active={tab}>
            <details className="panel p-3 sm:p-4" open>
              <summary className="min-h-10 text-sm font-semibold text-gold">Aplicar dano manualmente</summary>
              <div className="mt-3 min-w-0">
                <DamageApplier target={{ id: character.id, name: character.name }}
                  sources={sourceCharacters.filter((source) => source.id !== character.id).map((source) => ({ id: source.id, name: source.name }))} />
              </div>
            </details>
            <CharacterSheetEffectsManager characterId={character.id} characterName={character.name} />
          </SheetTabPanel>
        </>
      )}
    </div>
  );
}

function SavedBadge({ savedAt }: { savedAt: number | null }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!savedAt) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 2000);
    return () => clearTimeout(t);
  }, [savedAt]);
  return (
    <span className={`flex items-center gap-1 text-sm text-vital transition-opacity ${show ? "opacity-100" : "opacity-0"}`}>
      <Check className="h-4 w-4" /> Salvo
    </span>
  );
}

function NumberField({ label, icon, value, onSave }: {
  label: string; icon: string; value: number; onSave: (v: number) => Promise<unknown>;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = (n: number) => {
    const c = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
    setV(c);
    if (c !== value) onSave(c);
  };
  return (
    <div className="panel flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
      <span className="flex items-center gap-2 text-sm uppercase tracking-wider text-muted-foreground">
        <AttrIcon name={icon} className="h-4 w-4 text-gold" /> {label}
      </span>
      <div className="flex items-center gap-1">
        <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => commit(v - 1)}><Minus className="h-4 w-4" /></Button>
        <Input type="number" min={0} className="tabular h-8 w-20 text-center" value={v}
          onChange={(e) => setV(Number(e.target.value))} onBlur={() => commit(v)}
          onKeyDown={(e) => e.key === "Enter" && commit(v)} />
        <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => commit(v + 1)}><Plus className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}

function PercentEditor({ label, icon, tone, value, onSave }: {
  label: string; icon: string; tone: string; value: number; onSave: (v: number) => Promise<unknown>;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = (n: number) => { const c = clampPct(n); setV(c); if (c !== value) onSave(c); };
  return (
    <div className="panel min-w-0 space-y-3 p-3 sm:p-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm uppercase tracking-wider text-muted-foreground">
          <AttrIcon name={icon} className="h-4 w-4 text-gold" /> {label}
        </span>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => commit(v - 5)}><Minus className="h-4 w-4" /></Button>
          <Input type="number" min={0} max={100} className="tabular h-8 w-16 text-center"
            value={v} onChange={(e) => setV(Number(e.target.value))} onBlur={() => commit(v)}
            onKeyDown={(e) => e.key === "Enter" && commit(v)} />
          <span className="text-muted-foreground">%</span>
          <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => commit(v + 5)}><Plus className="h-4 w-4" /></Button>
        </div>
      </div>
      <Slider min={0} max={100} step={1} value={[v]} onValueChange={([n]) => setV(n ?? 0)} onValueCommit={([n]) => commit(n ?? 0)} />
      <StatBar value={v} max={100} tone={tone} />
    </div>
  );
}

function AttrEditor({ def, characterId, body, sanity, attr, racePts, virtuePts, classPts, physicalPts, noMana, statusModifier, onSaved }: {
  def: AttributeDef; characterId: string; body: number; sanity: number; attr: CharacterAttr | undefined; racePts: number; virtuePts: number; classPts: number; physicalPts: number; noMana: boolean; statusModifier: { fixed: number; percent: number }; onSaved: () => void;
}) {
  const cur0 = noMana ? 0 : attr?.current_value ?? 0;
  const max0 = noMana ? 0 : attr?.max_value ?? 0;
  const pts0 = attr?.points ?? 0;
  const bonus0 = attr?.bonus ?? 0;
  const traitPts = racePts + virtuePts + classPts + physicalPts;
  const base = def.accepts_points ? computeValue(def, pts0 + traitPts) : max0;
  const rawTotal = def.accepts_points ? base + bonus0 : max0 + traitPts + bonus0;
  const adjustedTotal = Math.floor((rawTotal + statusModifier.fixed) * (1 + statusModifier.percent / 100));
  // The editable HP maximum is the stored base. "Total" adds all traits and
  // active modifiers, matching the limit validated by Supabase.
  const total = noMana ? 0 : def.key === "hp"
    ? effectiveHpTotal(max0, traitPts, bonus0, statusModifier.fixed, statusModifier.percent)
    : conditionAdjustedValue({ body, sanity }, def.key, clampNonDefenseAttribute(def.key, adjustedTotal));
  const [cur, setCur] = useState(cur0);
  const [max, setMax] = useState(max0);
  const [bonus, setBonus] = useState(bonus0);
  const [pendingMax, setPendingMax] = useState<number | null>(null);
  useEffect(() => { setCur(cur0); setMax(max0); setBonus(bonus0); }, [cur0, max0, bonus0]);

  async function save(c: number, m: number) {
    // This attribute already exists. An UPSERT fires validate_attribute() as
    // BEFORE INSERT before the conflict is resolved: HP 124 with a stored base
    // maximum of 117 is wrongly rejected even when race bonuses raise the
    // effective total to 124. UPDATE validates against the actual character.
    const changes: { current_value?: number; max_value?: number } = {};
    if (c !== cur0) changes.current_value = c;
    if (m !== max0) changes.max_value = m;
    if (!Object.keys(changes).length) return;

    const { data, error } = await supabase.from("character_attributes")
      .update(changes)
      .eq("character_id", characterId)
      .eq("attribute_key", def.key)
      .select("character_id")
      .maybeSingle();

    if (error || !data) {
      toast.error(error?.message ?? "Atributo não encontrado na ficha");
      setCur(cur0);
      setMax(max0);
      return;
    }
    onSaved();
    if (def.key === "hp") void dispatchCustomAbilityScriptEvents();
  }

  async function commitBonus(n: number) {
    const b = Math.round(Number.isFinite(n) ? n : 0);
    setBonus(b);
    if (b === bonus0) return;
    // Likewise, never insert an incomplete row just to edit an existing bonus.
    const { data, error } = await supabase.from("character_attributes")
      .update({ bonus: b })
      .eq("character_id", characterId)
      .eq("attribute_key", def.key)
      .select("character_id")
      .maybeSingle();
    if (error || !data) {
      toast.error(error?.message ?? "Atributo não encontrado na ficha");
      setBonus(bonus0);
      return;
    }
    onSaved();
  }

  function commitCur(n: number) {
    let c = noMana ? 0 : Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
    // HP is allowed up to its effective total (e.g. base 117 + race 7 = 124),
    // not just the editable base maximum. Applies to direct edits and +/-.
    if (def.accepts_points || def.cap_current) c = Math.min(c, Math.max(0, total));
    setCur(c);
    if (c !== cur0) save(c, max);
  }

  function commitMax(n: number) {
    const m = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
    setMax(m);
    if (m === max0) return;
    const nextTotal = def.key === "hp"
      ? effectiveHpTotal(m, traitPts, bonus0, statusModifier.fixed, statusModifier.percent)
      : m;
    // Lowering the base maximum is valid so long as the current HP fits in
    // the NEW effective total, including race/virtue/class and buffs.
    if (def.cap_current && cur > nextTotal) { setPendingMax(m); return; }
    save(cur, m);
  }

  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm uppercase tracking-wider text-muted-foreground">
          <AttrIcon name={def.icon} className="h-4 w-4 text-gold" /> {def.label}
        </span>
        <span className="tabular text-lg font-bold">
          {def.accepts_points && !def.show_bar ? (
            total
          ) : def.accepts_points ? (
            <>{cur0} <span className="text-sm text-muted-foreground">/ {total}</span></>
          ) : (
            <>{cur0} <span className="text-sm text-muted-foreground">/ {total}{(racePts !== 0 || virtuePts !== 0 || classPts !== 0) && ` (${racePts !== 0 ? `${racePts > 0 ? "+" : ""}${racePts} raça` : ""}${racePts !== 0 && virtuePts !== 0 ? ", " : ""}${virtuePts !== 0 ? `${virtuePts > 0 ? "+" : ""}${virtuePts} virtude` : ""}${(racePts !== 0 || virtuePts !== 0) && classPts !== 0 ? ", " : ""}${classPts !== 0 ? `${classPts > 0 ? "+" : ""}${classPts} classe` : ""})`}</span></>
          )}
        </span>
      </div>

      {def.accepts_points ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Pontos investidos</Label>
              <div className="tabular panel px-4 py-1.5 text-center text-sm">{pts0}{racePts !== 0 && <span className={racePts > 0 ? "text-gold" : "text-destructive"}> {racePts > 0 ? "+" : ""}{racePts} raça</span>}{virtuePts !== 0 && <span className={virtuePts > 0 ? "text-gold" : "text-destructive"}> {virtuePts > 0 ? "+" : ""}{virtuePts} virtude</span>}{classPts !== 0 && <span className={classPts > 0 ? "text-gold" : "text-destructive"}> {classPts > 0 ? "+" : ""}{classPts} classe</span>}{physicalPts !== 0 && <span className="text-gold"> +{physicalPts} físicos</span>}</div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Valor por pontos</Label>
              <div className="tabular panel px-4 py-1.5 text-center text-sm">{base}</div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Buff / Debuff</Label>
              <Input type="number" className="tabular h-9 w-24 text-center" value={bonus}
                onChange={(e) => setBonus(Number(e.target.value))} onBlur={() => commitBonus(bonus)}
                onKeyDown={(e) => e.key === "Enter" && commitBonus(bonus)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{def.show_bar ? "Total" : "Valor aplicado"}</Label>
              <div className="tabular panel px-4 py-1.5 text-center text-sm font-bold text-gold">{total}</div>
            </div>
          </div>
          {def.show_bar && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{def.label} atual</Label>
              <div className="flex items-center gap-1">
                <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => commitCur(cur - 1)}><Minus className="h-4 w-4" /></Button>
                <Input type="number" min={0} className="tabular h-9 w-24 text-center" value={cur}
                  onChange={(e) => setCur(Number(e.target.value))} onBlur={() => commitCur(cur)}
                  onKeyDown={(e) => e.key === "Enter" && commitCur(cur)} />
                <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => commitCur(cur + 1)}><Plus className="h-4 w-4" /></Button>
                <Button size="sm" variant="ghost" onClick={() => commitCur(total)}>Encher</Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Atual</Label>
            <div className="flex items-center gap-1">
              <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => commitCur(cur - 1)}><Minus className="h-4 w-4" /></Button>
              <Input type="number" min={0} className="tabular h-9 w-20 text-center" value={cur}
                onChange={(e) => setCur(Number(e.target.value))} onBlur={() => commitCur(cur)}
                onKeyDown={(e) => e.key === "Enter" && commitCur(cur)} />
              <Button size="icon" variant="outline" className="h-9 w-9" onClick={() => commitCur(cur + 1)}><Plus className="h-4 w-4" /></Button>
              {def.key === "hp" && <Button size="sm" variant="ghost" onClick={() => commitCur(total)}>Encher</Button>}
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Máximo</Label>
            <Input type="number" min={0} className="tabular h-9 w-24 text-center" value={max}
              onChange={(e) => setMax(Number(e.target.value))} onBlur={() => commitMax(max)}
              onKeyDown={(e) => e.key === "Enter" && commitMax(max)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Total</Label>
            <div className="tabular flex h-9 min-w-20 items-center justify-center rounded-md border border-border bg-muted/40 px-3 text-sm font-semibold text-gold">
              {total}
            </div>
          </div>
        </div>
      )}

      {/* Use the effective maximum after race/virtue modifiers so the bar matches the displayed total. */}
      {def.show_bar && <StatBar value={cur0} max={total} tone={barTone(def.key)} className="mt-3" />}

      <AlertDialog open={pendingMax !== null} onOpenChange={(o) => { if (!o) { setPendingMax(null); setMax(max0); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Máximo menor que o valor atual</AlertDialogTitle>
            <AlertDialogDescription>
              O valor atual de {def.label} ({cur}) é maior que o novo Total ({def.key === "hp"
                ? effectiveHpTotal(pendingMax ?? max0, traitPts, bonus0, statusModifier.fixed, statusModifier.percent)
                : pendingMax}), considerando todos os bônus. Deseja ajustar o valor atual ao novo Total?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              const m = pendingMax ?? 0;
              const newTotal = def.key === "hp"
                ? effectiveHpTotal(m, traitPts, bonus0, statusModifier.fixed, statusModifier.percent)
                : m;
              setCur(newTotal); setPendingMax(null); save(newTotal, m);
            }}>Ajustar e salvar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
