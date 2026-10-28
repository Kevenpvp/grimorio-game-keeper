-- A CHECK constraint executes its validating function as the inserting
-- authenticated user. The validator is pure/IMMUTABLE and reads no user data.
-- Allow authenticated ability editors to pass the DB constraint.
GRANT EXECUTE ON FUNCTION public.valid_sustain_costs(jsonb) TO authenticated;