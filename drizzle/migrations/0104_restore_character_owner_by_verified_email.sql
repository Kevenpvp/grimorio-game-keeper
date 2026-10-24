-- Restore ownership of characters after accounts are recreated in the Brazil project.
-- Claims are private and only the verified email from auth.users can trigger them.
CREATE TABLE IF NOT EXISTS public.character_owner_migration_claims (
  email text PRIMARY KEY,
  character_id uuid NOT NULL UNIQUE REFERENCES public.characters(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.character_owner_migration_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.character_owner_migration_claims FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.character_owner_migration_claims TO service_role;

INSERT INTO public.character_owner_migration_claims (email, character_id)
VALUES
  ('ferrosjoa@gmail.com', 'd8dc24a5-bdf9-4c88-9ee0-70c8544f6c4d'::uuid),
  ('kevenrzanluchi@gmail.com', '0f212c32-3e3b-4e78-aefb-2cd4058eb25b'::uuid)
ON CONFLICT (email) DO UPDATE
SET character_id = EXCLUDED.character_id;

CREATE OR REPLACE FUNCTION public.sync_my_role()
RETURNS public.app_role
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _email text;
  _resolved_role public.app_role;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;

  SELECT lower(email)
    INTO _email
  FROM auth.users
  WHERE id = auth.uid()
    AND email_confirmed_at IS NOT NULL;

  IF _email IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.master_emails WHERE lower(email) = _email) THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (auth.uid(), 'master')
    ON CONFLICT DO NOTHING;
    _resolved_role := 'master';
  ELSE
    INSERT INTO public.user_roles (user_id, role)
    VALUES (auth.uid(), 'player')
    ON CONFLICT DO NOTHING;
    _resolved_role := 'player';
  END IF;

  -- Claim only the specifically mapped character, and only after email confirmation.
  -- Never steal a character that is already linked to a different account.
  IF _email IS NOT NULL THEN
    UPDATE public.characters c
    SET owner_id = auth.uid()
    FROM public.character_owner_migration_claims claim
    WHERE lower(claim.email) = _email
      AND claim.character_id = c.id
      AND (c.owner_id IS NULL OR c.owner_id = auth.uid());
  END IF;

  RETURN _resolved_role;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_my_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_my_role() TO authenticated;
