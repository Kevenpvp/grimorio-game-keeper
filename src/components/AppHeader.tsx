import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Sparkles, Swords } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useMe } from "@/lib/sheets";

export function AppHeader() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <header className="border-b border-border/60 bg-background/70 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link to="/painel" className="flex items-center gap-2 font-display text-lg text-gold">
          <Swords className="h-5 w-5" /> Grimório
        </Link>
        <div className="flex items-center gap-3 text-sm">
          {me && <Link to="/combate" className="text-muted-foreground hover:text-gold">Combate</Link>}
          {me?.isMaster && (
            <>
              <Link to="/racas" className="text-muted-foreground hover:text-gold">Raças</Link>
              <Link to="/virtudes" className="text-muted-foreground hover:text-gold">Virtudes</Link>
              <Link to="/tipos-dano" className="flex items-center gap-1 text-muted-foreground hover:text-gold"><Sparkles className="h-3.5 w-3.5" /> Tipos de dano</Link>
            </>
          )}
          {me && (
            <span className="hidden text-muted-foreground sm:inline">
              {me.profile?.display_name} · <span className="text-gold">{me.isMaster ? "Mestre" : "Jogador"}</span>
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut className="mr-1 h-4 w-4" /> Sair
          </Button>
        </div>
      </div>
    </header>
  );
}
