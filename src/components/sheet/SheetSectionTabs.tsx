import { type ReactNode } from "react";
import { BookOpen, ChartNoAxesCombined, HeartPulse, Layers3, Shield, Sparkles, Swords, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";

export type SheetTabKey = "overview" | "attributes" | "origin" | "abilities" | "transformations" | "resources" | "points";

const tabIcons = {
  overview: BookOpen,
  attributes: ChartNoAxesCombined,
  points: Wallet,
  origin: Shield,
  abilities: Swords,
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

export function SheetTabPanel({ tab, active, children, className }: {
  tab: SheetTabKey;
  active: SheetTabKey;
  children: ReactNode;
  className?: string;
}) {
  // Keep inactive panels mounted: field drafts and confirmation dialogs must
  // not lose their local state when the master switches between tabs.
  return (
    <div role="tabpanel" id={"character-tab-panel-" + tab} aria-labelledby={"character-tab-" + tab}
      hidden={active !== tab} className={cn("min-w-0 space-y-4", active !== tab && "hidden", className)}>
      {children}
    </div>
  );
}
