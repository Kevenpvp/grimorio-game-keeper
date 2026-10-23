-- The ability-runtime Edge Function uses the service role to read race mechanics
-- when resolving custom ability scripts granted by virtues.
GRANT SELECT ON TABLE public.races TO service_role;
