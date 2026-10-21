import { supabase } from "@/integrations/supabase/client";

const dispatchesInFlight = new Map<string, Promise<void>>();

/**
 * Ask the authenticated master-only Edge Function to drain the server-side ability event queue.
 * Database triggers are the source of events; this is only the dispatcher.
 */
export function dispatchCustomAbilityScriptEvents(battleId?: string | null): Promise<void> {
  const key = battleId ?? "*";
  const existing = dispatchesInFlight.get(key);
  if (existing) return existing;

  const dispatch = (async () => {
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
    dispatchesInFlight.delete(key);
  });

  dispatchesInFlight.set(key, dispatch);
  return dispatch;
}
