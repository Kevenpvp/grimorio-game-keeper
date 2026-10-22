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
  const [checking, setChecking] = useState(true);
  const [callbackFailed, setCallbackFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let finished = false;

    const hasHashResponse = window.location.hash.includes("access_token") ||
      window.location.hash.includes("error");
    const hasCodeResponse = new URLSearchParams(window.location.search).has("code");
    const hasAuthResponse = hasHashResponse || hasCodeResponse;

    const clearAuthResponseFromUrl = () => {
      // OAuth access tokens must not remain visible in the address bar.
      window.history.replaceState(
        window.history.state,
        document.title,
        window.location.pathname + window.location.search,
      );
    };

    const goToDashboard = () => {
      if (!active || finished) return;
      finished = true;
      clearAuthResponseFromUrl();
      setTimeout(() => {
        // Leave Supabase's auth callback first. Navigating inside the callback
        // can race the SDK's session lock and leave the preview on its loader.
        if (active) navigate({ to: "/painel", replace: true });
      }, 0);
    };

    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const oauthError = hashParams.get("error_description") || hashParams.get("error");
    if (oauthError) {
      finished = true;
      clearAuthResponseFromUrl();
      toast.error("O login com Google não foi concluído. Tente entrar novamente.");
      setChecking(false);
      setCallbackFailed(true);
      return;
    }

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) goToDashboard();
    });

    // The Supabase client parses and persists the OAuth callback during
    // initialization. A valid session should immediately take the user to the panel.
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active || finished) return;
      if (data.session) {
        goToDashboard();
        return;
      }

      // Without OAuth parameters, an ordinary visit should not wait for the timeout.
      if (!hasAuthResponse) {
        finished = true;
        setChecking(false);
        if (error) console.warn("[Grimório] Não foi possível restaurar a sessão.", error);
      }
      // When OAuth parameters exist, allow the auth listener a few seconds to
      // receive the session. The timeout below prevents an infinite spinner.
    }).catch((error) => {
      if (!active || finished) return;
      console.warn("[Grimório] Falha ao verificar sessão.", error);
      if (!hasAuthResponse) {
        finished = true;
        setChecking(false);
      }
    });

    const timeout = window.setTimeout(() => {
      if (!active || finished) return;
      finished = true;
      if (hasAuthResponse) clearAuthResponseFromUrl();
      setChecking(false);
      setCallbackFailed(hasAuthResponse);
    }, hasAuthResponse ? 12000 : 8000);

    return () => {
      active = false;
      window.clearTimeout(timeout);
      listener.subscription.unsubscribe();
    };
  }, [navigate]);

  if (checking) {
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
              {callbackFailed
                ? "Não foi possível concluir o login."
                : "Verificando sua sessão. Isso deve levar apenas alguns segundos."}
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
          {callbackFailed
            ? "O login não terminou corretamente. Tente entrar novamente."
            : "As fichas da sua campanha, guardadas pelo mestre e consultadas pelos jogadores durante a sessão."}
        </p>
        <Button asChild size="lg" className="mt-8">
          <Link to="/auth">{callbackFailed ? "Voltar ao login" : "Entrar"}</Link>
        </Button>
      </div>
    </div>
  );
}
