import { User } from "lucide-react";
import type { AttributeDef, Character, CharacterAttr } from "@/lib/sheets";
import { computeValue, usePhotoUrl, useRaceMods } from "@/lib/sheets";
import { AttrIcon, barTone } from "./icons";
import { StatBar } from "./StatBar";

export function Portrait({ path, name, className }: { path: string | null; name: string; className?: string }) {
  const url = usePhotoUrl(path);
  return (
    <div className={`overflow-hidden rounded-lg bg-muted gold-frame ${className ?? ""}`}>
      {url ? (
        <img src={url} alt={name} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <User className="h-1/3 w-1/3" />
        </div>
      )}
    </div>
  );
}

export function PercentStat({ label, value, tone, icon }: { label: string; value: number; tone: string; icon: string }) {
  return (
    <div className="panel p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm uppercase tracking-wider text-muted-foreground">
          <AttrIcon name={icon} className="h-4 w-4 text-gold" /> {label}
        </span>
        <span className="tabular text-2xl font-bold">{value}%</span>
      </div>
      <StatBar value={value} max={100} tone={tone} />
    </div>
  );
}

export function CharacterSheetView({
  character, attrs, defs,
}: { character: Character; attrs: CharacterAttr[]; defs: AttributeDef[] }) {
  const byKey = new Map(attrs.map((a) => [a.attribute_key, a]));
  const { race, mods } = useRaceMods(character.race_id);
  const barDefs = defs.filter((d) => d.show_bar);
  const otherDefs = defs.filter((d) => !d.show_bar);

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <section className="grid gap-6 md:grid-cols-[240px_1fr]">
        <Portrait path={character.photo_path} name={character.name} className="aspect-[3/4] w-full max-w-[240px] mx-auto" />
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gold md:text-4xl">{character.name}</h1>
            <p className="text-muted-foreground">Jogador: {character.player_name || "—"}</p>
            {character.description && <p className="mt-3 max-w-prose text-sm leading-relaxed">{character.description}</p>}
          </div>

          <div className="flex flex-wrap gap-3">
            {race && (
              <span className="panel px-3 py-1.5 text-xs uppercase tracking-wider text-gold">Raça: {race.name}</span>
            )}
            <span className="panel tabular px-3 py-1.5 text-xs uppercase tracking-wider text-gold">
              {character.available_points} ponto{character.available_points === 1 ? "" : "s"} livre{character.available_points === 1 ? "" : "s"}
            </span>
            <span className="panel tabular px-3 py-1.5 text-xs uppercase tracking-wider text-muted-foreground">
              {character.kills} abate{character.kills === 1 ? "" : "s"}
            </span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {barDefs.map((d) => {
              const a = byKey.get(d.key);
              const cur = a?.current_value ?? 0;
              const rm = mods[d.key] ?? 0;
              const pts = (a?.points ?? 0) + (d.accepts_points ? rm : 0);
              const bonus = a?.bonus ?? 0;
              const base = d.accepts_points ? computeValue(d, pts) : 0;
              const max = d.accepts_points ? base + bonus : (a?.max_value ?? 0) + rm;
              return (
                <div key={d.key} className="panel p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="flex items-center gap-2 text-sm uppercase tracking-wider text-muted-foreground">
                      <AttrIcon name={d.icon} className="h-4 w-4 text-gold" /> {d.label}
                    </span>
                    <span className="tabular text-2xl font-bold">
                      {cur} <span className="text-base text-muted-foreground">/ {max}</span>
                    </span>
                  </div>
                  <StatBar value={cur} max={max} tone={barTone(d.key)} />
                  {d.accepts_points && (
                    <div className="tabular mt-2 text-xs text-muted-foreground">
                      {pts} pts{(mods[d.key] ?? 0) !== 0 && <> ({mods[d.key] > 0 ? "+" : ""}{mods[d.key]} raça)</>} · {base} por pontos{bonus !== 0 && <> · <span className={bonus > 0 ? "text-gold" : "text-destructive"}>{bonus > 0 ? "+" : ""}{bonus} buff/debuff</span></>}
                    </div>
                  )}
                </div>
              );
            })}
            <PercentStat label="Corpo" value={character.body} tone={barTone("body")} icon="activity" />
            <PercentStat label="Sanidade" value={character.sanity} tone={barTone("sanity")} icon="eye" />
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg text-gold">Atributos</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {otherDefs.map((d) => {
            const a = byKey.get(d.key);
            const rm = mods[d.key] ?? 0;
            const pts = (a?.points ?? 0) + rm;
            const bonus = a?.bonus ?? 0;
            const base = d.accepts_points ? computeValue(d, pts) : 0;
            const value = d.accepts_points ? base + bonus : a?.current_value ?? 0;
            return (
              <div key={d.key} className="panel p-4">
                <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
                  <AttrIcon name={d.icon} className="h-4 w-4 text-gold" /> {d.label}
                </div>
                <div className="tabular mt-2 text-2xl font-bold">{value}</div>
                {d.accepts_points && (
                  <div className="tabular mt-1 text-xs text-muted-foreground">
                    {base} por pontos ({pts} pt{pts === 1 ? "" : "s"}{rm !== 0 && <>, {rm > 0 ? "+" : ""}{rm} raça</>})
                    {bonus !== 0 && <> · <span className={bonus > 0 ? "text-gold" : "text-destructive"}>{bonus > 0 ? "+" : ""}{bonus}</span></>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
