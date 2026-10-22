import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2, Swords } from "lucide-react";
import { toast } from "sonner";
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
  // Se a URL contém token OAuth (#access_token=) ou código (?code=), o usuário acabou de autenticar via Google.
  // Mantemos a tela em estado de carregamento/autenticação até que a sessão seja confirmada e o redirecionamento ocorra.
  const [checking, setChecking] = useState(() => {
    if (typeof window === "undefined") return false;
    const hasHashToken = window.location.hash.includes("access_token");
    const hasQueryCode = window.location.search.includes("code=");
    return hasHashToken || hasQueryCode;
  });
  const [isInitialCheck, setIsInitialCheck] = useState(true);

  useEffect(() => {
    let unmounted = false;

    // Tratamento de erros retornados na URL (ex: #error=access_denied)
    if (typeof window !== "undefined" && window.location.hash.includes("error")) {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const errorMsg = params.get("error_description") || params.get("error");
      if (errorMsg) {
        toast.error(`Falha na autenticação: ${decodeURIComponent(errorMsg)}`);
      }
      setChecking(false);
      setIsInitialCheck(false);
      return;
    }

    const goToDashboard = () => {
      if (!unmounted) {
        navigate({ to: "/painel", replace: true });
      }
    };

    // Escuta mudanças de sessão emitidas pelo Supabase
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        goToDashboard();
      } else if (event === "SIGNED_OUT") {
        setChecking(false);
        setIsInitialCheck(false);
      }
    });

    // Checagem imediata de sessão existente no storage
    supabase.auth.getSession().then(({ data }) => {
      if (unmounted) return;
      if (data.session) {
        goToDashboard();
      } else {
        const hasHashToken = typeof window !== "undefined" && window.location.hash.includes("access_token");
        const hasQueryCode = typeof window !== "undefined" && window.location.search.includes("code=");
        if (!hasHashToken && !hasQueryCode) {
          setChecking(false);
        }
        setIsInitialCheck(false);
      }
    });

    // Timeout de segurança para nunca travar a tela caso a hash seja inválida
    const timeout = setTimeout(() => {
      if (!unmounted && checking) {
        setChecking(false);
        setIsInitialCheck(false);
      }
    }, 8000);

    return () => {
      unmounted = true;
      clearTimeout(timeout);
      listener.subscription.unsubscribe();
    };
  }, [navigate, checking]);

  // Enquanto estiver autenticando (ex.: voltando do Google com o token) ou checando sessão inicial
  if (checking || isInitialCheck) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="panel w-full max-w-sm p-8 text-center space-y-4 animate-in fade-in duration-300">
          <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
            <Swords className="h-10 w-10 text-gold animate-pulse" />
            <Loader2 className="absolute inset-0 h-16 w-16 animate-spin text-gold/30" />
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-bold text-gold">Conectando ao Grimório...</h1>
            <p className="text-sm text-muted-foreground">
              Autenticando sua conta. Você será redirecionado para o painel em instantes.
            </p>
          </div>
        </div>
      </div>
    );
  }

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
