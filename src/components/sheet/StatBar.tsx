import { cn } from "@/lib/utils";

export function StatBar({ value, max, tone, className }: { value: number; max: number; tone: string; className?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={cn("h-2.5 w-full overflow-hidden rounded-full bg-black/60 ring-1 ring-gold/20 shadow-[inset_0_1px_3px_rgba(0,0,0,.65)]", className)}>
      <div
        className={cn("relative h-full rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,.2),0_0_8px_rgba(255,255,255,.07)] transition-[width] duration-500 ease-out", tone)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
