-- Keep the stored maximum in step with the points invested in each attribute,
-- so bars, caps and the printed sheet always show the real value.
create or replace function public.invest_points(_character_id uuid, _allocations jsonb)
 returns void
 language plpgsql
 security definer
 set search_path = 'public'
as $function$
declare
  _is_master boolean := public.has_role(auth.uid(), 'master');
  _owner uuid; _available int; _total int := 0;
  _k text; _delta int; _cur int;
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;

  select owner_id, available_points into _owner, _available
    from public.characters where id = _character_id for update;
  if not found then raise exception 'Ficha não encontrada'; end if;
  if not _is_master and _owner is distinct from auth.uid() then raise exception 'Sem permissão'; end if;

  for _k, _delta in select key, value::int from jsonb_each_text(_allocations) loop
    if _delta = 0 then continue; end if;
    if not exists (select 1 from public.attribute_definitions where key = _k and accepts_points) then
      raise exception 'O atributo % não aceita pontos', _k;
    end if;
    if _delta < 0 and not _is_master then raise exception 'Apenas o mestre pode retirar pontos'; end if;
    select points into _cur from public.character_attributes
      where character_id = _character_id and attribute_key = _k for update;
    if coalesce(_cur,0) + _delta < 0 then raise exception 'Pontos investidos não podem ficar negativos'; end if;
    insert into public.character_attributes (character_id, attribute_key, points)
      values (_character_id, _k, _delta)
      on conflict (character_id, attribute_key) do update set points = public.character_attributes.points + _delta;
    _total := _total + _delta;
  end loop;

  if _total > _available then raise exception 'Pontos insuficientes (disponível: %)', _available; end if;
  update public.characters set available_points = available_points - _total where id = _character_id;

  -- derived maximum = base value + invested points x multiplier (per definition)
  update public.character_attributes ca
     set max_value = m.new_max,
         current_value = case
           when ad.cap_current and ca.current_value > m.new_max then m.new_max
           else ca.current_value
         end
    from public.attribute_definitions ad
    cross join lateral (
      select greatest(0, round(coalesce(ad.base_value,0) + ca.points * coalesce(ad.points_multiplier,1)))::int as new_max
    ) m
   where ca.character_id = _character_id
     and ad.key = ca.attribute_key
     and ad.accepts_points;
end; $function$;

grant execute on function public.invest_points(uuid, jsonb) to authenticated;
revoke execute on function public.invest_points(uuid, jsonb) from public, anon;