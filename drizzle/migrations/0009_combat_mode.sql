CREATE TABLE public.battles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'Batalha',
  active boolean NOT NULL DEFAULT true,
  current_character_id uuid REFERENCES public.characters(id) ON DELETE SET NULL,
  target_character_id uuid REFERENCES public.characters(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.battle_participants (
  battle_id uuid NOT NULL REFERENCES public.battles(id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (battle_id, character_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.battles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.battle_participants TO authenticated;
GRANT ALL ON public.battles TO service_role;
GRANT ALL ON public.battle_participants TO service_role;
ALTER TABLE public.battles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.battle_participants ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.in_my_battle(_battle_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.battle_participants bp
    JOIN public.characters c ON c.id = bp.character_id
    JOIN public.battles b ON b.id = bp.battle_id
    WHERE bp.battle_id = _battle_id AND c.owner_id = auth.uid() AND b.active
  )
$$;
CREATE OR REPLACE FUNCTION public.shares_battle(_character_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.battle_participants bp
    JOIN public.battles b ON b.id = bp.battle_id AND b.active
    JOIN public.battle_participants mine ON mine.battle_id = bp.battle_id
    JOIN public.characters c ON c.id = mine.character_id
    WHERE bp.character_id = _character_id AND c.owner_id = auth.uid()
  )
$$;
REVOKE EXECUTE ON FUNCTION public.in_my_battle(uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.shares_battle(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.in_my_battle(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shares_battle(uuid) TO authenticated;

CREATE POLICY "master all battles" ON public.battles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master')) WITH CHECK (public.has_role(auth.uid(), 'master'));
CREATE POLICY "player reads own battles" ON public.battles FOR SELECT TO authenticated
  USING (public.in_my_battle(id));
CREATE POLICY "master all participants" ON public.battle_participants FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master')) WITH CHECK (public.has_role(auth.uid(), 'master'));
CREATE POLICY "player reads own battle participants" ON public.battle_participants FOR SELECT TO authenticated
  USING (public.in_my_battle(battle_id));
CREATE POLICY "player reads battle characters" ON public.characters FOR SELECT TO authenticated
  USING (public.shares_battle(id));
CREATE POLICY "player reads battle attrs" ON public.character_attributes FOR SELECT TO authenticated
  USING (public.shares_battle(character_id));

ALTER PUBLICATION supabase_realtime ADD TABLE public.battles;
ALTER PUBLICATION supabase_realtime ADD TABLE public.battle_participants;