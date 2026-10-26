CREATE OR REPLACE FUNCTION public.apply_activation_effect_value_overrides(_effects jsonb, _overrides jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _index_text text;
  _index integer;
  _patch jsonb;
  _field text;
  _value jsonb;
  _number numeric;
  _limit numeric;
  _effect jsonb;
  _type text;
  _allowed boolean;
  _resource text;
BEGIN
  IF NOT public.has_role(auth.uid(),'master') THEN
    RAISE EXCEPTION 'Somente o mestre pode modificar efeitos ao ativar';
  END IF;
  IF jsonb_typeof(_effects) <> 'array' OR jsonb_typeof(_overrides) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(_overrides)) > 100 THEN
    RAISE EXCEPTION 'Configurações de efeitos inválidas';
  END IF;

  FOR _index_text,_patch IN SELECT key,value FROM jsonb_each(_overrides)
  LOOP
    IF _index_text !~ '^(0|[1-9][0-9]*)$'
      OR length(_index_text)>5
      OR _index_text::integer>=jsonb_array_length(_effects)
      OR jsonb_typeof(_patch)<>'object' THEN
      RAISE EXCEPTION 'Um efeito modificado não pertence a esta habilidade';
    END IF;
    _index:=_index_text::integer;
    _effect:=_effects->_index;
    IF coalesce((_effect->>'modify_on_activate')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'O efeito % não permite modificar ao ativar',_index+1;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(_patch))>20 THEN
      RAISE EXCEPTION 'Muitos valores alterados no mesmo efeito';
    END IF;
    _type:=_effect->>'effect_type';
    FOR _field,_value IN SELECT key,value FROM jsonb_each(_patch)
    LOOP
      _allowed:=false;
      _limit:=1000000;
      IF _field='amount' AND _type IN (
        'status','regeneration','mana_regeneration','mana_used','damage_dealt',
        'damage_reduction','damage_received','mental_control_chance','mental_control_resistance'
      ) THEN
        _allowed:=true;
      ELSIF _field='dot_resistance_amount' AND _type='dot_resistance' THEN
        _allowed:=true;
        IF coalesce(_effect->>'dot_resistance_value_mode','percent')='percent' THEN _limit:=100; END IF;
      ELSIF _type='healing' AND _field IN (
        'healing_hp_amount','healing_mana_amount','healing_body_amount','healing_sanity_amount'
      ) THEN
        _resource:=split_part(_field,'_',2);
        _allowed:=coalesce((_effect->>('healing_'||_resource||'_enabled'))::boolean,false);
        IF coalesce(_effect->>('healing_'||_resource||'_mode'),'fixed')='percent' THEN _limit:=100; END IF;
      ELSIF _type='healing' AND _field IN (
        'healing_reduce_debuff_turns_fixed','healing_reduce_debuff_turns_percent',
        'healing_relieve_debuff_percent'
      ) THEN
        _allowed:=coalesce(NULLIF(_effect->>_field,'')::numeric,0)>0;
        IF _field='healing_reduce_debuff_turns_fixed' THEN _limit:=1000;
        ELSE _limit:=100; END IF;
      ELSIF _type='magic_healing_reversal' AND _field='magic_healing_reversal_custom_damage'
        AND coalesce(_effect->>'magic_healing_reversal_damage_mode','healing_amount') IN ('custom','both') THEN
        _allowed:=true;
      END IF;
      IF NOT _allowed OR jsonb_typeof(_value)<>'number' THEN
        RAISE EXCEPTION 'O campo % não pode ser alterado ao ativar',_field;
      END IF;
      _number:=(_value#>>'{}')::numeric;
      IF _number<0 OR _number>_limit THEN
        RAISE EXCEPTION 'O valor de % deve ficar entre 0 e %',_field,_limit;
      END IF;
      IF _field='healing_reduce_debuff_turns_fixed' AND _number<>trunc(_number) THEN
        RAISE EXCEPTION 'A duração de debuffs deve ser um número inteiro';
      END IF;
      _effect:=jsonb_set(_effect,ARRAY[_field],_value,true);
      IF _field='dot_resistance_amount' THEN
        _effect:=jsonb_set(_effect,'{amount}',_value,true);
      END IF;
    END LOOP;
    _effects:=jsonb_set(_effects,ARRAY[_index_text],_effect,false);
  END LOOP;
  RETURN _effects;
END;
$function$
;
NOTIFY pgrst,'reload schema';