-- Restore table-level DML privileges so the existing master-only RLS policy
-- can authorize transformation ability grant changes.
-- Players still cannot insert/update/delete: transformation_abilities_master_manage
-- requires public.has_role(auth.uid(), 'master') for all write operations.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.transformation_abilities
  TO authenticated;
