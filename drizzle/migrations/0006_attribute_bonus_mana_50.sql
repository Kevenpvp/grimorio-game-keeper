alter table public.character_attributes add column bonus integer not null default 0;
comment on column public.character_attributes.bonus is 'Buff/debuff aplicado pelo mestre; total = valor por pontos + bonus';
update public.attribute_definitions set points_multiplier = 50, cap_current = false where key = 'mana';
update public.character_attributes set max_value = points * 50 where attribute_key = 'mana';