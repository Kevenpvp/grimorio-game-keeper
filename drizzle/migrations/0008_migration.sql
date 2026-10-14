drop policy if exists "player reads own photo" on storage.objects;
create policy "player reads own photo" on storage.objects for select to authenticated
  using (bucket_id = 'character-photos' and exists (
    select 1 from public.characters c
    where c.owner_id = auth.uid() and c.id::text = (storage.foldername(storage.objects.name))[1]));