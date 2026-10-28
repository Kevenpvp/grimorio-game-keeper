import { Shield, Sparkles, BookOpen } from "lucide-react";
import { useClasses, useRaces, useVirtues, type Character } from "@/lib/sheets";

/** Read-only origin display for players. Only the master changes the selections. */
export function CharacterOriginOverview({ character }: { character: Character }) {
  const { data: races = [] } = useRaces();
  const { data: virtues = [] } = useVirtues();
  const { data: classes = [] } = useClasses();
  const options = [
    { label: "Raça", id: character.race_id, trait: races.find((entry) => entry.id === character.race_id), Icon: Shield },
    { label: "Virtude", id: character.virtue_id, trait: virtues.find((entry) => entry.id === character.virtue_id), Icon: Sparkles },
    { label: "Classe", id: character.class_id, trait: classes.find((entry) => entry.id === character.class_id), Icon: BookOpen },
  ];
  return (
    <section className="panel space-y-4 p-4 sm:p-5" aria-label="Origens definidas pelo mestre">
      <div>
        <h2 className="font-display text-lg font-semibold text-gold">Raça, Virtude e Classe</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Essas características são escolhidas e alteradas exclusivamente pelo mestre.
          Você pode consultar suas origens e os bônus correspondentes no Resumo.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {options.map(({ label, id, trait, Icon }) => (
          <article key={label} className="min-w-0 rounded-xl border border-gold/20 bg-background/40 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Icon className="h-4 w-4 text-gold" aria-hidden="true" />
              {label}
            </div>
            <p className="font-display font-semibold text-gold">
              {!id ? "Não definida" : trait?.name ?? "Carregando..."}
            </p>
            {!id ? (
              <p className="mt-1 text-xs text-muted-foreground">Aguardando definição do mestre.</p>
            ) : trait?.description ? (
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{trait.description}</p>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
