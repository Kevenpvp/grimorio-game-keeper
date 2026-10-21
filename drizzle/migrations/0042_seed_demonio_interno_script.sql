-- Automatically wire an already-created Demonio Interno ability to its server-side script.
-- Keep custom values if the master already configured them; only seed defaults for an empty attribute list.
UPDATE public.abilities
SET custom_script_key = 'demonio_interno',
    custom_attributes = CASE
      WHEN jsonb_array_length(custom_attributes) = 0 THEN
        '[
          {"key":"porcentagem_maxima_dano_refletido","name":"Porcentagem máxima de dano refletido","type":"number","value":50},
          {"key":"percentual_hp_perdido_por_refletir","name":"% de HP que perde para refletir","type":"number","value":10}
        ]'::jsonb
      ELSE custom_attributes
    END
WHERE lower(trim(name)) IN ('demônio interno', 'demonio interno');
