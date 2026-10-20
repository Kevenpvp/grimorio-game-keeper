import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Menu, Sparkles, Swords, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useMe } from "@/lib/sheets";

export function AppHeader() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  async function signOut() {
    setMobileOpen(false);
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  const navClass =
    "rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-gold";

  return (
    <header className="border-b border-border/60 bg-background/90 backdrop-blur">
      <div className="mx-auto max-w-6xl px-4 py-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <Link
            to="/painel"
            onClick={() => setMobileOpen(false)}
            className="flex shrink-0 items-center gap-2 font-display text-lg text-gold"
          >
            <Swords className="h-5 w-5" /> Grimório
          </Link>

          {/* Desktop navigation keeps its single-row layout only when there is room. */}
          <nav aria-label="Navegação principal" className="hidden min-w-0 items-center gap-3 text-sm lg:flex">
            {me && <Link to="/combate" className="whitespace-nowrap text-muted-foreground hover:text-gold">Combate</Link>}
            {me?.isMaster && (
              <>
                <Link to="/racas" className="whitespace-nowrap text-muted-foreground hover:text-gold">Raças</Link>
                <Link to="/virtudes" className="whitespace-nowrap text-muted-foreground hover:text-gold">Virtudes</Link>
                <Link to="/habilidades" className="whitespace-nowrap text-muted-foreground hover:text-gold">Habilidades</Link>
                <Link to="/tipos-dano" className="flex whitespace-nowrap items-center gap-1 text-muted-foreground hover:text-gold">
                  <Sparkles className="h-3.5 w-3.5" /> Tipos de dano
                </Link>
              </>
            )}
            {me && (
              <span className="whitespace-nowrap text-muted-foreground">
                {me.profile?.display_name} · <span className="text-gold">{me.isMaster ? "Mestre" : "Jogador"}</span>
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={() => void signOut()} className="shrink-0">
              <LogOut className="mr-1 h-4 w-4" /> Sair
            </Button>
          </nav>

          {/* Mobile gets a dedicated menu instead of squeezing every link into the header. */}
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0 lg:hidden"
            aria-label={mobileOpen ? "Fechar menu" : "Abrir menu"}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </Button>
        </div>

        {mobileOpen && (
          <nav aria-label="Navegação móvel" className="mt-3 grid gap-1 border-t border-border/60 pt-3 lg:hidden">
            {me && (
              <Link to="/combate" className={navClass} onClick={() => setMobileOpen(false)}>
                Combate
              </Link>
            )}
            {me?.isMaster && (
              <>
                <Link to="/racas" className={navClass} onClick={() => setMobileOpen(false)}>Raças</Link>
                <Link to="/virtudes" className={navClass} onClick={() => setMobileOpen(false)}>Virtudes</Link>
                <Link to="/habilidades" className={navClass} onClick={() => setMobileOpen(false)}>Habilidades</Link>
                <Link to="/tipos-dano" className={navClass} onClick={() => setMobileOpen(false)}>
                  <span className="flex items-center gap-2"><Sparkles className="h-4 w-4" /> Tipos de dano</span>
                </Link>
              </>
            )}
            {me && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {me.profile?.display_name} · <span className="text-gold">{me.isMaster ? "Mestre" : "Jogador"}</span>
              </div>
            )}
            <Button variant="ghost" size="sm" onClick={() => void signOut()} className="mt-1 w-full justify-start px-3">
              <LogOut className="mr-2 h-4 w-4" /> Sair
            </Button>
          </nav>
        )}
      </div>
    </header>
  );
}
