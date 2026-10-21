import { supabase } from "@/integrations/supabase/client";

let dispatchInFlight: Promise<void> | null = null;
let dispatchRequestedAgain = false;

/**
 * Ask the authenticated master-only Edge Function to drain the server-side ability event queue.
 * Database triggers are the source of events; this is only the dispatcher. Calls are serialized
 * so overlapping Realtime notifications cannot run event batches concurrently.
 */
export function dispatchCustomAbilityScriptEvents(battleId?: string | null): Promise<void> {
  if (dispatchInFlight) {
    dispatchRequestedAgain = true;
    return dispatchInFlight;
  }

  dispatchInFlight = (async () => {
    const { data, error } = await supabase.functions.invoke("ability-runtime", {
      body: { battle_id: battleId ?? null },
    });
    if (error) {
      // Script dispatch failures must not roll back a turn/activation which already committed.
      console.error("Não foi possível processar os scripts customizados de habilidades.", error);
      return;
    }
    if (data?.failed > 0 || data?.pendingLimitReached) {
      console.error("A fila de scripts customizados requer atenção.", data);
    }
  })().finally(() => {
    dispatchInFlight = null;
    if (dispatchRequestedAgain) {
      dispatchRequestedAgain = false;
      // Drain globally so requests that arrived while a battle-scoped dispatch was active
      // do not leave other battles' events waiting indefinitely.
      void dispatchCustomAbilityScriptEvents(null);
    }
  });

  return dispatchInFlight;
}
