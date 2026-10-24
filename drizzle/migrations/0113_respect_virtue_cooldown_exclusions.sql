-- Excluded virtues must not receive either multiplier or cooldown reduction.
DO $patch$
DECLARE
  _fn record;
  _def text;
  _mechanic text;
  _old text;
  _new text;
BEGIN
  FOR _fn IN
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('activate_character_ability', 'activate_character_ability_attack', 'activate_character_transformation')
  LOOP
    _def := pg_get_functiondef(_fn.oid);
    FOREACH _mechanic IN ARRAY ARRAY['race', 'class']
    LOOP
      _old := format(
        'IF COALESCE(NULLIF(_%s_mechanics->>''virtue_cooldown_reduction_percent'', '''')::numeric, 0) > 0 THEN',
        _mechanic
      );
      _new := format(
        'IF COALESCE(NULLIF(_%s_mechanics->>''virtue_cooldown_reduction_percent'', '''')::numeric, 0) > 0 AND NOT COALESCE((_%s_mechanics->''virtue_effect_blacklist'') @> jsonb_build_array(_cooldown_virtue_id::text), false) THEN',
        _mechanic, _mechanic
      );
      IF position(_new IN _def) > 0 THEN CONTINUE; END IF;
      IF position(_old IN _def) = 0 THEN
        RAISE EXCEPTION 'Cooldown exclusion anchor missing in % for %', _fn.proname, _mechanic;
      END IF;
      _def := replace(_def, _old, _new);
    END LOOP;
    EXECUTE _def;
  END LOOP;
END;
$patch$;
NOTIFY pgrst, 'reload schema';
