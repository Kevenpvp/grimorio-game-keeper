import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Swords } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Grimório — Fichas de personagens de RPG" },
      { name: "description", content: "O mestre gerencia as fichas; cada jogador consulta a sua em tempo real." },
      { property: "og:title", content: "Grimório — Fichas de personagens de RPG" },
      { property: "og:description", content: "O mestre gerencia as fichas; cada jogador consulta a sua em tempo real." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const navigate = useNavigate();
  useEffect(() => {
    const goToDashboard = () => navigate({ to: "/painel", replace: true });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) goToDashboard();
    });
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) goToDashboard();
    });
    return () => listener.subscription.unsubscribe();
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-xl text-center">
        <Swords className="mx-auto mb-6 h-12 w-12 text-gold" />
        <h1 className="text-4xl font-bold text-gold md:text-5xl">Grimório</h1>
        <p className="mt-4 text-lg text-muted-foreground">
          As fichas da sua campanha, guardadas pelo mestre e consultadas pelos jogadores durante a sessão.
        </p>
        <Button asChild size="lg" className="mt-8">
          <Link to="/auth">Entrar</Link>
        </Button>
      </div>
    </div>
  );
}
