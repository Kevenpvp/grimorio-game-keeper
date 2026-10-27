import { Component, useEffect, useState, type ReactNode } from "react";
import { reportLovableError } from "@/lib/lovable-error-reporting";
import { Backpack, BookOpen, ChartNoAxesCombined, HeartPulse, Layers3, Shield, Sparkles, Swords, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";

export type SheetTabKey = "overview" | "attributes" | "origin" | "abilities" | "transformations" | "resources" | "points" | "inventory";

const tabIcons = {
  overview: BookOpen,
  attributes: ChartNoAxesCombined,
  points: Wallet,
  origin: Shield,
  abilities: Swords,
  inventory: Backpack,
  transformations: Sparkles,
  resources: HeartPulse,
} as const;

export function SheetSectionTabs({ active, onChange, tabs }: {
  active: SheetTabKey;
  onChange: (next: SheetTabKey) => void;
  tabs: Array<{ key: SheetTabKey; label: string; badge?: number | null }>;
}) {
  return (
    <nav aria-label="Seções da ficha" className="sticky top-[4.65rem] z-30 -mx-1 rounded-xl border border-gold/30 bg-[#110d0b]/95 p-1.5 shadow-lg backdrop-blur-xl sm:mx-0">
      <div role="tablist" aria-label="Áreas da ficha" className="flex gap-1 overflow-x-auto overscroll-x-contain pb-0.5 [scrollbar-width:thin]">
        {tabs.map(({ key, label, badge }) => {
          const Icon = tabIcons[key];
          return (
            <button key={key} type="button" role="tab" aria-selected={active === key}
              aria-controls={"character-tab-panel-" + key} id={"character-tab-" + key}
              onClick={(event) => {
                onChange(key);
                event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
              }}
              className={cn(
                "flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors sm:text-sm",
                active === key
                  ? "border-gold/45 bg-gold/15 text-gold shadow-[inset_0_1px_0_rgba(242,200,120,.08)]"
                  : "border-transparent text-muted-foreground hover:bg-gold/5 hover:text-foreground",
              )}>
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{label}</span>
              {!!badge && badge > 0 && (
                <span className="rounded-full border border-gold/35 bg-gold/10 px-1.5 text-[10px] tabular-nums text-gold">{badge}</span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

type SectionErrorProps = { tab: SheetTabKey; children: ReactNode };
type SectionErrorState = { error: Error | null };

class SheetSectionErrorBoundary extends Component<SectionErrorProps, SectionErrorState> {
  state: SectionErrorState = { error: null };

  static getDerivedStateFromError(error: Error): SectionErrorState {
    return { error };
  }

  componentDidCatch(error: Error) {
    reportLovableError(error, { boundary: "sheet_section", section: this.props.tab });
    console.error("Erro na seção da ficha:", this.props.tab, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="panel space-y-3 border-red-500/40 p-4 sm:p-5">
        <h3 className="text-base font-semibold text-red-300">Não foi possível carregar esta seção da ficha</h3>
        <p className="text-sm text-muted-foreground">
          As outras abas continuam disponíveis. Seus personagens e pontos não foram alterados.
        </p>
        <details className="rounded-lg border border-red-500/20 px-3 py-2">
          <summary className="cursor-pointer text-xs text-red-200">Ver detalhes técnicos</summary>
          <p className="mt-2 break-words font-mono text-xs text-muted-foreground">
            {this.state.error.message || "Erro desconhecido ao exibir esta seção."}
          </p>
        </details>
        <button type="button" className="min-h-11 rounded-lg border border-gold/40 px-4 text-sm font-semibold text-gold hover:bg-gold/10"
          onClick={() => this.setState({ error: null })}>
          Tentar abrir seção novamente
        </button>
      </div>
    );
  }
}

export function SheetTabPanel({ tab, active, children, className }: {
  tab: SheetTabKey;
  active: SheetTabKey;
  children: ReactNode;
  className?: string;
}) {
  // Render only the selected tab on first load. Previously every tab was
  // mounted immediately, causing 10+ unrelated queries and any hidden-panel
  // rendering failure to break the entire sheet. Once visited, a panel stays
  // mounted to preserve draft fields when switching tabs.
  const [visited, setVisited] = useState(active === tab);
  useEffect(() => {
    if (active === tab) setVisited(true);
  }, [active, tab]);
  if (!visited && active !== tab) return null;
  return (
    <div role="tabpanel" id={"character-tab-panel-" + tab} aria-labelledby={"character-tab-" + tab}
      hidden={active !== tab} className={cn("min-w-0 space-y-4", active !== tab && "hidden", className)}>
      <SheetSectionErrorBoundary tab={tab}>
        {children}
      </SheetSectionErrorBoundary>
    </div>
  );
}
