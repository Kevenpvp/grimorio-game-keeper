CREATE OR REPLACE FUNCTION public.create_summon_instance(
  _grant_id uuid, _summoner_id uuid, _battle_id uuid,
  _transfer_override jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  _grant public.summon_grants;
  _template public.characters;
  _summoner public.characters;
  _summon_id uuid;
  _instance_id uuid;
  _transfer jsonb;
  _config record;
  _attribute record;
  _value numeric;
  _sort integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode invocar criaturas';
  END IF;
  SELECT * INTO _grant FROM public.summon_grants WHERE id=_grant_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invocação não configurada'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.battles WHERE id=_battle_id AND active) THEN
    RAISE EXCEPTION 'A batalha precisa estar ativa';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.battle_participants WHERE battle_id=_battle_id AND character_id=_summoner_id) THEN
    RAISE EXCEPTION 'O invocador precisa estar na batalha';
  END IF;
  IF NOT (
    _grant.summoner_character_id=_summoner_id
    OR (_grant.ability_id IS NOT NULL AND EXISTS(
      SELECT 1 FROM public.character_abilities ca
      WHERE ca.character_id=_summoner_id AND ca.ability_id=_grant.ability_id
    ))
  ) THEN
    RAISE EXCEPTION 'A invocação não pertence ao personagem';
  END IF;
  IF EXISTS (SELECT 1 FROM public.active_summons s
    WHERE s.grant_id=_grant_id AND s.battle_id=_battle_id AND s.summoner_character_id=_summoner_id)
  THEN RAISE EXCEPTION 'Essa invocação já está na batalha'; END IF;

  SELECT * INTO _template FROM public.characters WHERE id=_grant.template_character_id;
  SELECT * INTO _summoner FROM public.characters WHERE id=_summoner_id;
  IF NOT FOUND OR _template.id IS NULL THEN RAISE EXCEPTION 'Ficha de origem ou invocador não encontrado'; END IF;
  IF EXISTS(SELECT 1 FROM public.active_summons WHERE summoned_character_id=_template.id) THEN
    RAISE EXCEPTION 'Não é possível usar uma invocação temporária como modelo';
  END IF;

  _transfer := COALESCE(_transfer_override,_grant.transfer_stats);
  IF jsonb_typeof(_transfer)<>'object' THEN RAISE EXCEPTION 'Transferência inválida'; END IF;
  FOR _config IN SELECT key,value FROM jsonb_each(_transfer) LOOP
    IF NOT EXISTS(SELECT 1 FROM public.attribute_definitions WHERE key=_config.key)
       OR jsonb_typeof(_config.value)<>'number'
       OR (_config.value#>>'{}')::numeric<0
       OR (_config.value#>>'{}')::numeric>1000000
       OR trunc((_config.value#>>'{}')::numeric)<>(_config.value#>>'{}')::numeric THEN
      RAISE EXCEPTION 'Transferência inválida: %', _config.key;
    END IF;
    SELECT ca.current_value,ca.max_value,ca.points,ca.bonus,ad.base_value,ad.points_multiplier,ad.accepts_points
    INTO _attribute
    FROM public.character_attributes ca JOIN public.attribute_definitions ad ON ad.key=ca.attribute_key
    WHERE ca.character_id=_summoner_id AND ca.attribute_key=_config.key;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invocador não possui o atributo %',_config.key; END IF;
    _value := (_config.value#>>'{}')::numeric;
    IF _value>GREATEST(0,CASE WHEN _config.key IN ('hp','mana') THEN _attribute.current_value
       WHEN _attribute.accepts_points THEN _attribute.base_value + _attribute.points*_attribute.points_multiplier + _attribute.bonus
       ELSE _attribute.max_value END) THEN
      RAISE EXCEPTION 'Não há pontos suficientes para transferir %',_config.key;
    END IF;
  END LOOP;

  INSERT INTO public.characters (
    name,player_name,description,photo_path,owner_id,body,sanity,race_id,virtue_id,class_id,
    class_custom_modifiers,race_attribute_allocations,virtue_attribute_allocations,
    class_attribute_allocations,race_physical_allocations,virtue_physical_allocations,
    class_physical_allocations
  )
  SELECT
    COALESCE(NULLIF(_grant.display_name,''),_template.name)||' · Invocação',
    _summoner.name, _template.description,_template.photo_path,_summoner.owner_id,
    _template.body,_template.sanity,_template.race_id,_template.virtue_id,_template.class_id,
    _template.class_custom_modifiers,_template.race_attribute_allocations,_template.virtue_attribute_allocations,
    _template.class_attribute_allocations,_template.race_physical_allocations,_template.virtue_physical_allocations,
    _template.class_physical_allocations
  RETURNING id INTO _summon_id;

  -- Snapshot all resource/stat rows. The original creature is never modified.
  INSERT INTO public.character_attributes
    (character_id,attribute_key,current_value,max_value,points,bonus)
  SELECT _summon_id,attribute_key,current_value,max_value,points,bonus
  FROM public.character_attributes WHERE character_id=_template.id
  ON CONFLICT(character_id,attribute_key) DO UPDATE
  SET current_value=EXCLUDED.current_value,max_value=EXCLUDED.max_value,
      points=EXCLUDED.points,bonus=EXCLUDED.bonus;

  FOR _config IN SELECT key,value FROM jsonb_each(_grant.custom_stats) LOOP
    _value:=(_config.value#>>'{}')::numeric;
    UPDATE public.character_attributes a
    SET points=CASE WHEN d.accepts_points AND a.attribute_key<>'hp' THEN
      LEAST(1000000,FLOOR(_value/GREATEST(1,d.points_multiplier))::integer) ELSE a.points END,
      max_value=CASE WHEN a.attribute_key='hp' OR a.attribute_key='mana' THEN _value::integer ELSE a.max_value END,
      current_value=CASE WHEN a.attribute_key IN ('hp','mana') THEN _value::integer ELSE a.current_value END,
      bonus=CASE WHEN d.accepts_points AND a.attribute_key<>'mana' THEN
        (_value-(d.base_value+a.points*d.points_multiplier))::integer
        ELSE a.bonus END
    FROM public.attribute_definitions d
    WHERE a.character_id=_summon_id AND a.attribute_key=_config.key AND d.key=a.attribute_key;
  END LOOP;

  INSERT INTO public.character_abilities (
    character_id,ability_id,name,description,is_passive,can_activate,
    self_target_only,is_magical,cooldown_turns,cooldown_remaining,mana_cost,
    effects,passive_effects,end_effects,once_per_battle,custom_attributes,toggle_mode
  )
  SELECT _summon_id,ca.ability_id,ca.name,ca.description,ca.is_passive,
    ca.can_activate,ca.self_target_only,ca.is_magical,ca.cooldown_turns,0,ca.mana_cost,
    ca.effects,ca.passive_effects,ca.end_effects,ca.once_per_battle,ca.custom_attributes,ca.toggle_mode
  FROM public.character_abilities ca WHERE ca.character_id=_template.id
  ON CONFLICT (character_id,ability_id) DO NOTHING;

  SELECT COALESCE(MAX(sort_order)+1,0) INTO _sort FROM public.battle_participants WHERE battle_id=_battle_id;
  INSERT INTO public.battle_participants(battle_id,character_id,sort_order)
  VALUES (_battle_id,_summon_id,_sort);

  INSERT INTO public.active_summons
    (battle_id,grant_id,summoned_character_id,summoner_character_id,template_character_id,transferred_stats)
  VALUES (_battle_id,_grant_id,_summon_id,_summoner_id,_template.id,_transfer)
  RETURNING id INTO _instance_id;

  FOR _config IN SELECT key,value FROM jsonb_each(_transfer) LOOP
    _value := (_config.value#>>'{}')::numeric;
    IF _value=0 THEN CONTINUE; END IF;
    INSERT INTO public.battle_effects(
      battle_id,character_id,name,effect_type,attribute_key,polarity,value_mode,
      amount,duration,until_combat_end,duration_scope,effect_data
    ) VALUES
      (_battle_id,_summoner_id,'Pontos emprestados à invocação','status',_config.key,
       'debuff','fixed',_value,1,true,'global',jsonb_build_object('summon_instance_id',_instance_id::text)),
      (_battle_id,_summon_id,'Pontos recebidos do invocador','status',_config.key,
       'buff','fixed',_value,1,true,'global',jsonb_build_object('summon_instance_id',_instance_id::text));
  END LOOP;
  RETURN _summon_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.summon_character_companion(
 _grant_id uuid,_summoner_id uuid,_battle_id uuid,_transfer_override jsonb DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  RETURN public.create_summon_instance(_grant_id,_summoner_id,_battle_id,_transfer_override);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.activate_ability_summons(
 _character_ability_id uuid,_battle_id uuid
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE _item record;
BEGIN
  IF _battle_id IS NULL THEN RETURN; END IF;
  FOR _item IN
    SELECT g.id,ca.character_id
    FROM public.character_abilities ca
    JOIN public.summon_grants g ON g.ability_id=ca.ability_id
    WHERE ca.id=_character_ability_id
  LOOP
    PERFORM public.create_summon_instance(_item.id,_item.character_id,_battle_id,NULL);
  END LOOP;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.remove_summon_companion(
 _summoned_character_id uuid,_battle_id uuid
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Apenas o mestre pode remover uma invocação';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.active_summons
    WHERE summoned_character_id=_summoned_character_id AND battle_id=_battle_id) THEN
    RAISE EXCEPTION 'Invocação não encontrada nesta batalha';
  END IF;
  DELETE FROM public.characters WHERE id=_summoned_character_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cleanup_summon_transfers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  -- Removes caster's temporary penalty immediately; original stats restore.
  DELETE FROM public.battle_effects
  WHERE effect_data->>'summon_instance_id'=OLD.id::text;
  RETURN OLD;
END;
$fn$;
CREATE TRIGGER active_summons_restore_transfer AFTER DELETE ON public.active_summons
FOR EACH ROW EXECUTE FUNCTION public.cleanup_summon_transfers();

CREATE OR REPLACE FUNCTION public.cleanup_summon_participant()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM public.active_summons s
    WHERE s.battle_id=OLD.battle_id AND s.summoned_character_id=OLD.character_id) THEN
    DELETE FROM public.characters WHERE id=OLD.character_id;
  END IF;
  RETURN OLD;
END;
$fn$;
CREATE TRIGGER battle_participants_cleanup_summon AFTER DELETE ON public.battle_participants
FOR EACH ROW EXECUTE FUNCTION public.cleanup_summon_participant();

CREATE OR REPLACE FUNCTION public.cleanup_summons_at_battle_end()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  IF OLD.active IS TRUE AND NEW.active IS FALSE THEN
    DELETE FROM public.characters c
    WHERE c.id IN (SELECT s.summoned_character_id FROM public.active_summons s WHERE s.battle_id=NEW.id);
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER battles_cleanup_summons AFTER UPDATE OF active ON public.battles
FOR EACH ROW EXECUTE FUNCTION public.cleanup_summons_at_battle_end();

CREATE OR REPLACE FUNCTION public.update_summon_stat_bonuses(
 _summoned_character_id uuid,_bonuses jsonb
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE _entry record;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode ajustar os atributos da invocação';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.active_summons s JOIN public.battles b ON b.id=s.battle_id
    WHERE s.summoned_character_id=_summoned_character_id AND b.active) THEN
    RAISE EXCEPTION 'A criatura não é uma invocação ativa';
  END IF;
  IF _bonuses IS NULL OR jsonb_typeof(_bonuses)<>'object' THEN RAISE EXCEPTION 'Atributos inválidos'; END IF;
  FOR _entry IN SELECT key,value FROM jsonb_each(_bonuses) LOOP
    IF jsonb_typeof(_entry.value)<>'number' OR (_entry.value#>>'{}')::numeric NOT BETWEEN -1000000 AND 1000000
       OR trunc((_entry.value#>>'{}')::numeric)<>(_entry.value#>>'{}')::numeric THEN
      RAISE EXCEPTION 'Bônus inválido: %',_entry.key;
    END IF;
    UPDATE public.character_attributes SET bonus=(_entry.value#>>'{}')::integer
    WHERE character_id=_summoned_character_id AND attribute_key=_entry.key;
    IF NOT FOUND THEN RAISE EXCEPTION 'Atributo inexistente: %',_entry.key; END IF;
  END LOOP;
END;
$fn$;

REVOKE ALL ON FUNCTION public.create_summon_instance(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.activate_ability_summons(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.summon_character_companion(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.remove_summon_companion(uuid,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.update_summon_stat_bonuses(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.summon_character_companion(uuid,uuid,uuid,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_summon_companion(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_summon_stat_bonuses(uuid,jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.cleanup_summon_transfers() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cleanup_summon_participant() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cleanup_summons_at_battle_end() FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';
