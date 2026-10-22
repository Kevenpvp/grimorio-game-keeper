-- This queue is an internal worker API. Only the server-side Edge Function
-- should claim queued script events; browsers and unauthenticated callers must
-- not be able to lock work or interfere with the event queue.
REVOKE EXECUTE ON FUNCTION public.claim_ability_script_events(integer, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ability_script_events(integer, uuid)
  TO service_role;
