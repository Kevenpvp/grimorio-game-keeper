-- Summons may originate in a character sheet or an ability catalog.
-- Templates are permanent character sheets; battle instances are temporary.
CREATE TABLE public.summon_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  summoner_character_id uuid REFERENCES public.characters(id) ON DELETE CASCADE,
  ability_id uuid REFERENCES public.abilities(id) ON DELETE CASCADE,
  template_character_id uuid NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT '',
  custom_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  transfer_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  borrowed_assignment_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT summon_grant_origin CHECK ((summoner_character_id IS NULL) <> (ability_id IS NULL)),
  CONSTRAINT summon_custom_stats_object CHECK (jsonb_typeof(custom_stats)='object'),
  CONSTRAINT summon_transfer_stats_object CHECK (jsonb_typeof(transfer_stats)='object')
);
CREATE INDEX summon_grants_summoner_idx ON public.summon_grants(summoner_character_id);
CREATE INDEX summon_grants_ability_idx ON public.summon_grants(ability_id);

CREATE TABLE public.active_summons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  battle_id uuid NOT NULL REFERENCES public.battles(id) ON DELETE CASCADE,
  grant_id uuid REFERENCES public.summon_grants(id) ON DELETE SET NULL,
  summoned_character_id uuid NOT NULL UNIQUE REFERENCES public.characters(id) ON DELETE CASCADE,
  summoner_character_id uuid NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  template_character_id uuid NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  transferred_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX active_summons_battle_idx ON public.active_summons(battle_id);
CREATE UNIQUE INDEX active_summons_one_per_grant
  ON public.active_summons(battle_id,grant_id,summoner_character_id)
  WHERE grant_id IS NOT NULL;
ALTER TABLE public.character_abilities ADD COLUMN source_summon_grant_id uuid
  REFERENCES public.summon_grants(id) ON DELETE CASCADE;

ALTER TABLE public.summon_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.active_summons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "master manages summon grants" ON public.summon_grants FOR ALL
TO authenticated USING (public.has_role(auth.uid(),'master'))
WITH CHECK (public.has_role(auth.uid(),'master'));
CREATE POLICY "players view own summon grants" ON public.summon_grants FOR SELECT
TO authenticated USING (
  EXISTS (SELECT 1 FROM public.characters c WHERE c.id=summoner_character_id AND c.owner_id=auth.uid())
  OR EXISTS (
    SELECT 1 FROM public.character_abilities ca JOIN public.characters c ON c.id=ca.character_id
    WHERE ca.ability_id=summon_grants.ability_id AND c.owner_id=auth.uid()
  )
);
CREATE POLICY "master manages active summons" ON public.active_summons FOR ALL
TO authenticated USING (public.has_role(auth.uid(),'master'))
WITH CHECK (public.has_role(auth.uid(),'master'));
CREATE POLICY "players view summons in their battles" ON public.active_summons FOR SELECT
TO authenticated USING (
  EXISTS (SELECT 1 FROM public.characters c WHERE c.id=summoner_character_id AND c.owner_id=auth.uid())
  OR public.in_my_battle(battle_id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.summon_grants TO authenticated;
GRANT SELECT ON public.active_summons TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_summon_borrowed_abilities()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.character_abilities WHERE source_summon_grant_id=NEW.id;
  IF NEW.summoner_character_id IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.character_abilities (
    character_id,ability_id,name,description,is_passive,can_activate,is_magical,
    self_target_only,cooldown_turns,cooldown_remaining,mana_cost,
    effects,passive_effects,end_effects,once_per_battle,custom_attributes,toggle_mode,
    source_summon_grant_id
  )
  SELECT NEW.summoner_character_id,ca.ability_id,ca.name,
    'Habilidade emprestada por invocação: '||ca.name,ca.is_passive,ca.can_activate,
    ca.is_magical,ca.self_target_only,ca.cooldown_turns,0,ca.mana_cost,
    ca.effects,ca.passive_effects,ca.end_effects,ca.once_per_battle,ca.custom_attributes,
    ca.toggle_mode,NEW.id
  FROM public.character_abilities ca
  WHERE ca.id=ANY(NEW.borrowed_assignment_ids)
    AND ca.character_id=NEW.template_character_id
    AND NOT EXISTS (
      SELECT 1 FROM public.character_abilities already
      WHERE already.character_id=NEW.summoner_character_id
        AND ca.ability_id IS NOT NULL AND already.ability_id=ca.ability_id
    );
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.validate_summon_grant()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _entry record; _ability uuid;
BEGIN
  IF NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode cadastrar invocações';
  END IF;
  IF EXISTS (SELECT 1 FROM public.active_summons s WHERE s.summoned_character_id=NEW.template_character_id)
     OR (NEW.summoner_character_id IS NOT NULL AND NEW.summoner_character_id=NEW.template_character_id) THEN
    RAISE EXCEPTION 'Escolha uma ficha original diferente do invocador';
  END IF;
  FOR _entry IN SELECT key,value FROM jsonb_each(NEW.custom_stats)
    UNION ALL SELECT key,value FROM jsonb_each(NEW.transfer_stats)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.attribute_definitions WHERE key=_entry.key)
      OR jsonb_typeof(_entry.value)<>'number'
      OR (_entry.value#>>'{}')::numeric<0
      OR (_entry.value#>>'{}')::numeric>1000000
      OR trunc((_entry.value#>>'{}')::numeric)<>(_entry.value#>>'{}')::numeric THEN
      RAISE EXCEPTION 'Atributo personalizado ou transferido inválido: %',_entry.key;
    END IF;
  END LOOP;
  IF NEW.borrowed_assignment_ids IS NULL THEN NEW.borrowed_assignment_ids:=ARRAY[]::uuid[]; END IF;
  IF NEW.summoner_character_id IS NULL AND cardinality(NEW.borrowed_assignment_ids)>0 THEN
    RAISE EXCEPTION 'Habilidades emprestadas precisam ser vinculadas à ficha do invocador';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.borrowed_assignment_ids) item(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.character_abilities ca
      WHERE ca.id=item.id AND ca.character_id=NEW.template_character_id
    )
  ) THEN
    RAISE EXCEPTION 'Habilidade emprestada não pertence à ficha da criatura';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE TRIGGER summon_grants_validate BEFORE INSERT OR UPDATE ON public.summon_grants
FOR EACH ROW EXECUTE FUNCTION public.validate_summon_grant();
CREATE TRIGGER summon_grants_sync_borrowed AFTER INSERT OR UPDATE ON public.summon_grants
FOR EACH ROW EXECUTE FUNCTION public.sync_summon_borrowed_abilities();
REVOKE ALL ON FUNCTION public.validate_summon_grant() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.sync_summon_borrowed_abilities() FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';
