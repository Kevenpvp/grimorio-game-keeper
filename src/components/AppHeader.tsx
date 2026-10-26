import { useState } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  BookOpenText, BookUser, ChevronRight, Compass, Flame, Gem, LogOut,
  Menu, ScrollText, Shield, Sparkles, Swords, UserRound, WandSparkles, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useMe } from "@/lib/sheets";

const navigation = [
  { to: "/combate", label: "Combate", icon: Swords, masterOnly: false },
  { to: "/painel", label: "Fichas", icon: BookUser, masterOnly: false },
  { to: "/racas", label: "Raças", icon: Compass, masterOnly: true },
  { to: "/classes", label: "Classes", icon: Shield, masterOnly: true },
  { to: "/virtudes", label: "Virtudes", icon: Gem, masterOnly: true },
  { to: "/habilidades", label: "Habilidades", icon: WandSparkles, masterOnly: true },
  { to: "/tipos-dano", label: "Tipos de dano", icon: Sparkles, masterOnly: true },
  { to: "/dots", label: "DoTs", icon: Flame, masterOnly: true },
  { to: "/transformacoes", label: "Transformações", icon: ScrollText, masterOnly: true },
] as const;

export function AppHeader() {
  const { data: me } = useMe();
  const { pathname } = useLocation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const links = navigation.filter((item) => !item.masterOnly || me?.isMaster);

  async function signOut() {
    setMobileOpen(false);
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <header className="grimorio-header">
      <div className="grimorio-shell">
        <div className="grimorio-header-inner flex min-w-0 items-center justify-between gap-3">
          <Link to="/painel" className="grimorio-brand group" onClick={() => setMobileOpen(false)}
            aria-label="Grimório Game Keeper — abrir fichas">
            <span className="grimorio-brand-mark transition-colors group-hover:border-gold">
              <BookOpenText className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="grimorio-brand-text">Grimório
              <span className="grimorio-brand-subtitle">GAME KEEPER</span>
            </span>
          </Link>

          <nav aria-label="Navegação principal" className="hidden min-w-0 items-center justify-center gap-0.5 xl:flex">
            {links.map(({ to, label, icon: Icon }) => (
              <Link key={to} to={to} title={label} aria-current={pathname === to ? "page" : undefined}
                className={cn("grimorio-nav-link", pathname === to && "is-active")}>
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{label}</span>
              </Link>
            ))}
          </nav>

          <div className="hidden shrink-0 items-center gap-2 xl:flex">
            {me && (
              <div className="grimorio-user-pill">
                <span className="grimorio-user-avatar"><UserRound className="h-4 w-4" aria-hidden="true" /></span>
                <span className="min-w-0 text-left">
                  <span className="block max-w-28 truncate text-xs font-semibold text-foreground">
                    {me.profile?.display_name || (me.isMaster ? "Mestre" : "Jogador")}
                  </span>
                  <span className="block text-[11px] text-gold">{me.isMaster ? "Mestre" : "Jogador"}</span>
                </span>
              </div>
            )}
            <Button variant="outline" size="sm" onClick={() => void signOut()} className="border-gold/25"
              title="Sair da conta">
              <LogOut className="h-4 w-4" /> <span className="sr-only">Sair</span>
            </Button>
          </div>

          <div className="flex shrink-0 items-center gap-2 xl:hidden">
            {me && <span className="hidden max-w-32 truncate text-xs font-semibold text-gold sm:block">{me.isMaster ? "Mestre" : "Jogador"}</span>}
            <Button type="button" variant="outline" size="icon"
              className="h-11 w-11 border-gold/40"
              aria-label={mobileOpen ? "Fechar menu de navegação" : "Abrir menu de navegação"}
              aria-controls="grimorio-mobile-navigation" aria-expanded={mobileOpen}
              onClick={() => setMobileOpen((open) => !open)}>
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          </div>
        </div>

        {mobileOpen && (
          <nav id="grimorio-mobile-navigation" aria-label="Navegação móvel"
            className="grimorio-mobile-menu grid grid-cols-1 gap-0.5 sm:grid-cols-2 xl:hidden">
            {links.map(({ to, label, icon: Icon }) => (
              <Link key={to} to={to}
                aria-current={pathname === to ? "page" : undefined}
                className={cn("grimorio-mobile-link", pathname === to && "is-active")}
                onClick={() => setMobileOpen(false)}>
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">{label}</span>
                {pathname === to && <ChevronRight className="h-4 w-4" aria-hidden="true" />}
              </Link>
            ))}
            <div className="col-span-full mt-1 flex items-center justify-between gap-3 border-t border-gold/20 px-3 pt-3">
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {me?.profile?.display_name || "Grimório"} · <strong className="text-gold">{me?.isMaster ? "Mestre" : "Jogador"}</strong>
              </span>
              <Button size="sm" variant="outline" onClick={() => void signOut()} className="min-h-10">
                <LogOut className="mr-1 h-4 w-4" /> Sair
              </Button>
            </div>
          </nav>
        )}
      </div>
    </header>
  );
}
