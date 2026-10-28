-- Per-fighter, per-battle master-controlled Mana regeneration.
-- Default: disabled, fixed 40 Mana, until the master opts in for that fighter.
ALTER TABLE public.battle_participants
  ADD COLUMN IF NOT EXISTS mana_regen_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mana_regen_mode text NOT NULL DEFAULT 'fixed'
    CHECK (mana_regen_mode IN ('fixed','percent')),
  ADD COLUMN IF NOT EXISTS mana_regen_amount numeric NOT NULL DEFAULT 40
    CHECK (mana_regen_amount >= 0 AND mana_regen_amount <= 1000000);

CREATE OR REPLACE FUNCTION public.configure_battle_mana_regeneration(
  _battle_id uuid, _character_id uuid, _enabled boolean,
  _mode text DEFAULT NULL, _amount numeric DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='public'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode configurar a regeneração de Mana';
  END IF;
  IF _enabled IS NULL THEN RAISE EXCEPTION 'Escolha se a regeneração ficará ligada ou desligada'; END IF;
  IF _mode IS NOT NULL AND _mode NOT IN ('fixed','percent') THEN
    RAISE EXCEPTION 'Modo de regeneração inválido';
  END IF;
  IF _amount IS NOT NULL AND (_amount < 0 OR _amount > 1000000) THEN
    RAISE EXCEPTION 'Valor de regeneração inválido';
  END IF;
  -- Serialize with advance_combat_turn, which locks the same battle row.
  PERFORM 1 FROM public.battles WHERE id=_battle_id AND active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Batalha não encontrada ou encerrada'; END IF;

  UPDATE public.battle_participants
  SET mana_regen_enabled=_enabled,
      mana_regen_mode=COALESCE(_mode,mana_regen_mode),
      mana_regen_amount=COALESCE(_amount,mana_regen_amount)
  WHERE battle_id=_battle_id AND character_id=_character_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Personagem não participa desta batalha'; END IF;
  RETURN true;
END;
$fn$;
REVOKE ALL ON FUNCTION public.configure_battle_mana_regeneration(uuid,uuid,boolean,text,numeric)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.configure_battle_mana_regeneration(uuid,uuid,boolean,text,numeric)
  TO authenticated;

-- The server decides which fighters regenerate, so an old browser tab or
-- a stale client cannot regenerate a fighter whose checkbox was disabled.
-- The input JSONB parameter remains for API compatibility; authoritative
-- config is now read from battle_participants in the existing turn function.
DO $patch$
DECLARE
  _fn text;
  _old text := 'for _fighter in select key, value from jsonb_each(coalesce(_mana_regeneration_settings, ''{}''::jsonb))';
  _new text := $fragment$for _fighter in select key, value from jsonb_each(
    coalesce((
      SELECT jsonb_object_agg(bp.character_id::text,
        jsonb_build_object('mode',bp.mana_regen_mode,'amount',bp.mana_regen_amount))
      FROM public.battle_participants bp
      WHERE bp.battle_id=_battle_id
        AND bp.mana_regen_enabled
        AND (_character_id IS NULL OR bp.character_id=_character_id)
    ),'{}'::jsonb)
  )$fragment$;
BEGIN
  SELECT pg_get_functiondef('public.advance_combat_turn(uuid,uuid,jsonb)'::regprocedure) INTO _fn;
  IF strpos(_fn,_old)=0 THEN RAISE EXCEPTION 'A rotina de turnos mudou. Revise a integração da regeneração.'; END IF;
  EXECUTE replace(_fn,_old,_new);
END;
$patch$;
