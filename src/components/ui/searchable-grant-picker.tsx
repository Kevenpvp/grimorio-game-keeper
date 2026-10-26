import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type GrantOption = {
  id: string;
  name: string;
  description?: string | null;
};

/**
 * Bounded, searchable catalog for abilities, transformations and battle participants.
 * Selected entries are ALWAYS discoverable, while unselected entries only render
 * when the master opens "Adicionar" or searches. No 500-item checkbox wall.
 *
 * Persistence belongs to the caller; it receives the same add/remove events as
 * the previous checkboxes. This UI never deletes a grant by itself.
 */
export function SearchableGrantPicker({
  options, selectedIds, onToggle, addLabel = "Adicionar", searchPlaceholder = "Buscar pelo nome…",
  selectedLabel = "Selecionados", emptyLabel = "Nenhum item selecionado.",
  description, selectedExtra, disabled = false, showSelected = true,
}: {
  options: GrantOption[];
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string, selected: boolean) => void | Promise<void>;
  addLabel?: string;
  searchPlaceholder?: string;
  selectedLabel?: string;
  emptyLabel?: string;
  description?: string;
  selectedExtra?: (id: string) => ReactNode;
  disabled?: boolean;
  showSelected?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [showAllSelected, setShowAllSelected] = useState(false);
  const [limit, setLimit] = useState(16);

  const normalized = query.trim().toLocaleLowerCase("pt-BR");
  const selected = useMemo(() => options.filter((option) => selectedIds.has(option.id)), [options, selectedIds]);
  const available = useMemo(() => options.filter((option) =>
    !selectedIds.has(option.id) &&
    (normalized === "" ||
      (option.name + " " + (option.description ?? "")).toLocaleLowerCase("pt-BR").includes(normalized))
  ), [options, selectedIds, normalized]);

  useEffect(() => { setLimit(16); }, [normalized]);
  const displayedSelected = showAllSelected ? selected : selected.slice(0, 6);

  function add(id: string) {
    if (disabled) return;
    void onToggle(id, true);
    // Leave the catalog open so the master can grant several items without
    // repeatedly opening it. The item will leave the available list on success.
  }

  return (
    <div className="min-w-0 space-y-3">
      {showSelected && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-muted-foreground">{selectedLabel} <span className="rounded-md border border-gold/30 bg-gold/10 px-1.5 py-0.5 text-gold">{selected.length}</span></p>
            {selected.length > 6 && (
              <button type="button" className="min-h-9 text-xs font-semibold text-gold hover:underline"
                aria-expanded={showAllSelected} onClick={() => setShowAllSelected((value) => !value)}>
                {showAllSelected ? "Mostrar menos" : "Ver todos os " + selected.length}
              </button>
            )}
          </div>
          {selected.length === 0 && <p className="rounded-md border border-dashed border-gold/20 p-3 text-xs text-muted-foreground">{emptyLabel}</p>}
          {displayedSelected.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {displayedSelected.map((item) => (
                <div key={item.id} className="flex min-w-0 flex-col gap-2 rounded-lg border border-gold/25 bg-gold/5 px-3 py-2 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-start gap-2">
                    <Check className="mt-1 h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
                    <span className="min-w-0 break-words text-sm font-medium">{item.name}</span>
                  </div>
                  <div className="flex min-w-0 items-center gap-2">
                    {selectedExtra?.(item.id)}
                    <button type="button" disabled={disabled}
                      className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md border border-red-500/25 px-2 text-xs text-red-300 hover:border-red-500/60 hover:bg-red-500/10 disabled:opacity-50"
                      aria-label={"Remover " + item.name}
                      onClick={() => void onToggle(item.id, false)}>
                      <X className="h-3.5 w-3.5" aria-hidden="true" /> Remover
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="rounded-lg border border-gold/20 bg-[#100c0a]/50 p-2.5 sm:p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-gold">{addLabel}</p>
            <p className="text-[11px] text-muted-foreground">{options.length - selected.length} disponível(is)</p>
          </div>
          <Button type="button" size="sm" variant="outline"
            className="min-h-10" disabled={disabled || options.length === selected.length}
            aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? <ChevronUp className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {open ? "Ocultar busca" : "Pesquisar e adicionar"}
          </Button>
        </div>
        {open && (
          <div className="mt-3 space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input type="search" className="min-h-11 pl-9" aria-label={searchPlaceholder}
                placeholder={searchPlaceholder} value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
            {description && <p className="text-xs text-muted-foreground">{description}</p>}
            {available.length === 0
              ? <p role="status" className="p-3 text-center text-xs text-muted-foreground">{normalized ? "Nenhum resultado para esta busca." : "Nenhum item disponível para adicionar."}</p>
              : <div className="max-h-[min(38dvh,340px)] space-y-1.5 overflow-y-auto overscroll-contain pr-1">
                  {available.slice(0, limit).map((item) => (
                    <button type="button" key={item.id} disabled={disabled}
                      className={cn("flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-gold/15 bg-[#1a120d]/60 px-3 py-2 text-left transition-colors hover:border-gold/50 hover:bg-gold/10 disabled:opacity-50")}
                      onClick={() => add(item.id)}>
                      <span className="min-w-0">
                        <span className="block break-words text-sm font-medium">{item.name}</span>
                        {item.description && <span className="mt-0.5 block line-clamp-2 text-[11px] text-muted-foreground">{item.description}</span>}
                      </span>
                      <Plus className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
                    </button>
                  ))}
                  {available.length > limit && (
                    <Button type="button" variant="outline" className="mt-1 min-h-10 w-full" size="sm"
                      onClick={() => setLimit((number) => number + 24)}>
                      <ChevronDown className="h-4 w-4" /> Mostrar mais ({available.length - limit} restantes)
                    </Button>
                  )}
                </div>}
          </div>
        )}
      </div>
    </div>
  );
}
