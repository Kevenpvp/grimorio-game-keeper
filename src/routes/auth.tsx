import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2, Swords } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Entrar — Grimório" },
      { name: "description", content: "Entre na sua conta de mestre ou jogador." },
      { property: "og:title", content: "Entrar — Grimório" },
      { property: "og:description", content: "Entre na sua conta de mestre ou jogador." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"in" | "up" | "reset">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [hasSession, setHasSession] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.location.hash.includes("access_token") || window.location.search.includes("code=");
  });

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session) {
        setHasSession(true);
        navigate({ to: "/painel", replace: true });
      }
    });
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setHasSession(true);
        navigate({ to: "/painel", replace: true });
      }
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "in") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (mode === "up") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin, data: { display_name: name } },
        });
        if (error) throw error;
        setSent(true);
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth`,
        });
        if (error) throw error;
        toast.success("E-mail de recuperação enviado! Verifique sua caixa de entrada.");
        setMode("in");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha na autenticação");
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setBusy(true);
    try {
      // Deixa o Supabase iniciar o fluxo OAuth normalmente na mesma aba.
      // Assim, o callback retorna ao endereço atual do app sem popup nem redirecionamento manual.
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: window.location.origin,
        },
      });
      if (error) throw error;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível entrar com Google");
      setBusy(false);
    }
  }

  if (hasSession) {
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
              Sessão identificada. Redirecionando para o painel...
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="panel w-full max-w-sm p-6">
        <div className="mb-6 text-center">
          <Swords className="mx-auto mb-2 h-8 w-8 text-gold" />
          <h1 className="text-2xl text-gold">
            {mode === "in" ? "Entrar" : mode === "up" ? "Criar conta" : "Recuperar senha"}
          </h1>
        </div>
        {sent ? (
          <p className="text-center text-sm text-muted-foreground">
            Conta criada! Confirme pelo link enviado ao seu e-mail e depois entre. O mestre vinculará seu personagem.
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {mode === "up" && (
              <div className="space-y-1.5">
                <Label htmlFor="name">Nome</Label>
                <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email">E-mail</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {mode !== "reset" && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="pw">Senha</Label>
                  {mode === "in" && (
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-gold"
                      onClick={() => setMode("reset")}
                    >
                      Esqueceu a senha?
                    </button>
                  )}
                </div>
                <Input id="pw" type="password" minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {mode === "in" ? "Entrar" : mode === "up" ? "Criar conta" : "Enviar link de recuperação"}
            </Button>
            {mode === "in" && (
              <Button type="button" variant="outline" className="w-full" onClick={google} disabled={busy}>
                Continuar com Google
              </Button>
            )}
          </form>
        )}
        <div className="mt-4 flex flex-col items-center gap-1 text-center text-sm text-muted-foreground">
          {mode === "in" ? (
            <button
              type="button"
              className="hover:text-gold"
              onClick={() => { setMode("up"); setSent(false); }}
            >
              Não tem conta? Cadastre-se
            </button>
          ) : (
            <button
              type="button"
              className="hover:text-gold"
              onClick={() => { setMode("in"); setSent(false); }}
            >
              Já tem conta? Entrar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
