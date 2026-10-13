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
import {
  clampPct, computeValue, useCharacter, useCharacterLive, useDefs, useMe,
  type AttributeDef, type Character, type CharacterAttr,
} from "@/lib/sheets";
import { CharacterSheetView, Portrait } from "@/components/sheet/CharacterSheetView";
import { PointsDistribution } from "@/components/sheet/PointsDistribution";
import { AttrIcon, barTone } from "@/components/sheet/icons";
import { StatBar } from "@/components/sheet/StatBar";

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

  if (isLoading || !me || !defs) return <p className="text-muted-foreground">Carregando…</p>;
  if (!data?.character)
    return (
      <div className="panel mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl text-gold">Ficha não encontrada</h1>
        <Link to="/painel" className="mt-4 inline-block text-sm text-muted-foreground hover:text-gold">Voltar</Link>
      </div>
    );
  if (!me.isMaster) return <CharacterSheetView character={data.character} attrs={data.attrs} defs={defs} />;
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/painel" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-gold">
          <ArrowLeft className="h-4 w-4" /> Todas as fichas
        </Link>
        <div className="flex items-center gap-2">
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
        <CharacterSheetView character={character} attrs={attrs} defs={defs} />
      ) : (
        <>
          <section className="panel grid gap-6 p-5 md:grid-cols-[200px_1fr]">
            <div className="space-y-2">
              <Portrait path={character.photo_path} name={character.name} className="mx-auto aspect-[3/4] w-full max-w-[200px]" />
              <input ref={fileRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
              <Button variant="outline" size="sm" className="w-full" onClick={() => fileRef.current?.click()}>
                <Upload className="mr-1 h-4 w-4" /> {character.photo_path ? "Trocar foto" : "Enviar foto"}
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Nome do personagem</Label>
                <Input value={info.name} onChange={(e) => setInfo({ ...info, name: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Nome do jogador</Label>
                <Input value={info.player_name} onChange={(e) => setInfo({ ...info, player_name: e.target.value })} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Conta do jogador vinculada</Label>
                <Select value={info.owner_id ?? "none"} onValueChange={(v) => setInfo({ ...info, owner_id: v === "none" ? null : v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Nenhuma</SelectItem>
                    {profiles?.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.display_name} {p.email ? `(${p.email})` : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Descrição</Label>
                <Textarea rows={3} value={info.description} onChange={(e) => setInfo({ ...info, description: e.target.value })} />
              </div>
              <div className="sm:col-span-2">
                <Button onClick={saveInfo}>Salvar informações</Button>
              </div>
            </div>
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <PercentEditor label="Corpo" icon="activity" tone={barTone("body")} value={character.body}
              onSave={(v) => updateCharacter({ body: v })} />
            <PercentEditor label="Sanidade" icon="eye" tone={barTone("sanity")} value={character.sanity}
              onSave={(v) => updateCharacter({ sanity: v })} />
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <NumberField label="Pontos disponíveis" icon="sparkles" value={character.available_points}
              onSave={(v) => updateCharacter({ available_points: v })} />
            <NumberField label="Abates" icon="flame" value={character.kills}
              onSave={(v) => updateCharacter({ kills: v })} />
          </section>

          <section>
            <h2 className="mb-3 text-lg text-gold">Pontos de atributo</h2>
            <PointsDistribution character={character} attrs={attrs} defs={defs} canRemove />
          </section>

          <section>
            <h2 className="mb-3 text-lg text-gold">Atributos</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {defs.map((d) => (
                <AttrEditor key={d.key} def={d} characterId={character.id} attr={byKey.get(d.key)}
                  onSaved={() => { mark(); refresh(); }} />
              ))}
            </div>
          </section>
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
    <div className="panel flex items-center justify-between gap-3 p-4">
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
    <div className="panel space-y-3 p-4">
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

function AttrEditor({ def, characterId, attr, onSaved }: {
  def: AttributeDef; characterId: string; attr: CharacterAttr | undefined; onSaved: () => void;
}) {
  const cur0 = attr?.current_value ?? 0;
  const max0 = attr?.max_value ?? 0;
  const pts0 = attr?.points ?? 0;
  const bonus0 = attr?.bonus ?? 0;
  const base = def.accepts_points ? computeValue(def, pts0) : max0;
  const total = def.accepts_points ? base + bonus0 : max0;
  const [cur, setCur] = useState(cur0);
  const [max, setMax] = useState(max0);
  const [bonus, setBonus] = useState(bonus0);
  const [pendingMax, setPendingMax] = useState<number | null>(null);
  useEffect(() => { setCur(cur0); setMax(max0); setBonus(bonus0); }, [cur0, max0, bonus0]);

  async function save(c: number, m: number) {
    const { error } = await supabase.from("character_attributes").upsert({
      character_id: characterId, attribute_key: def.key, current_value: c, max_value: m,
    });
    if (error) { toast.error(error.message); setCur(cur0); setMax(max0); return; }
    onSaved();
  }

  async function commitBonus(n: number) {
    const b = Math.round(Number.isFinite(n) ? n : 0);
    setBonus(b);
    if (b === bonus0) return;
    const { error } = await supabase.from("character_attributes").upsert({
      character_id: characterId, attribute_key: def.key, bonus: b,
    });
    if (error) { toast.error(error.message); setBonus(bonus0); return; }
    onSaved();
  }

  function commitCur(n: number) {
    let c = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
    if (def.accepts_points) c = Math.min(c, Math.max(0, total));
    else if (def.cap_current) c = Math.min(c, max);
    setCur(c);
    if (c !== cur0) save(c, max);
  }

  function commitMax(n: number) {
    const m = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
    setMax(m);
    if (m === max0) return;
    if (def.cap_current && cur > m) { setPendingMax(m); return; }
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
            <>{cur0} <span className="text-sm text-muted-foreground">/ {max0}</span></>
          )}
        </span>
      </div>

      {def.accepts_points ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Pontos investidos</Label>
              <div className="tabular panel px-4 py-1.5 text-center text-sm">{pts0}</div>
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
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Máximo</Label>
            <Input type="number" min={0} className="tabular h-9 w-24 text-center" value={max}
              onChange={(e) => setMax(Number(e.target.value))} onBlur={() => commitMax(max)}
              onKeyDown={(e) => e.key === "Enter" && commitMax(max)} />
          </div>
        </div>
      )}

      {def.show_bar && <StatBar value={cur0} max={def.accepts_points ? total : max0} tone={barTone(def.key)} className="mt-3" />}

      <AlertDialog open={pendingMax !== null} onOpenChange={(o) => { if (!o) { setPendingMax(null); setMax(max0); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Máximo menor que o valor atual</AlertDialogTitle>
            <AlertDialogDescription>
              O valor atual de {def.label} ({cur}) é maior que o novo máximo ({pendingMax}). Deseja reduzir o valor atual para {pendingMax}?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              const m = pendingMax ?? 0;
              setCur(m); setPendingMax(null); save(m, m);
            }}>Ajustar e salvar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
