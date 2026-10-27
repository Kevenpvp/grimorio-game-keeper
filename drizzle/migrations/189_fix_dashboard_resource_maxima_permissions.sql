-- Fix permission denied for function calculate_character_resource_max in the
-- master character-list RPC. The calculation function intentionally denies
-- direct EXECUTE to authenticated users. Keep that protection unchanged.
-- The wrapper is strictly read-only and checks the caller's master role
-- using auth.uid() before performing the privileged calculation.
ALTER FUNCTION public.list_character_resource_maxima() SECURITY DEFINER;
REVOKE ALL ON FUNCTION public.list_character_resource_maxima() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_character_resource_maxima() TO authenticated;
