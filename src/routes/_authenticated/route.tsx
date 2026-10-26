import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AppHeader } from "@/components/AppHeader";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
  },
  component: () => (
    <div className="grimorio-app min-h-screen">
      <AppHeader />
      <main id="main-content" className="grimorio-shell grimorio-page-content">
        <Outlet />
      </main>
    </div>
  ),
});
