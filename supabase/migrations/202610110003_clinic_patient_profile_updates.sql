create policy "clinic staff can update patient profiles"
  on odonto.pacientes for update to authenticated
  using ((select odonto.is_clinic_staff()))
  with check ((select odonto.is_clinic_staff()));

grant update (nome_completo, whatsapp, data_nascimento)
  on odonto.pacientes to authenticated;

create or replace function odonto.clear_whatsapp_consent_on_number_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.whatsapp is distinct from old.whatsapp then
    new.whatsapp_consentido_em := null;
  end if;
  return new;
end;
$$;

create trigger clear_whatsapp_consent_on_number_change
  before update of whatsapp on odonto.pacientes
  for each row
  execute function odonto.clear_whatsapp_consent_on_number_change();
