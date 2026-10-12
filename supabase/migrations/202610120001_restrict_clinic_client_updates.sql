revoke update on table odonto.clinic_clients from authenticated;
grant update (nome_completo, whatsapp, email, data_nascimento)
  on odonto.clinic_clients to authenticated;

create or replace function odonto.set_clinic_client_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$;

revoke all on function odonto.set_clinic_client_updated_at() from public, anon, authenticated;

drop trigger if exists clinic_clients_set_updated_at on odonto.clinic_clients;
create trigger clinic_clients_set_updated_at
  before update on odonto.clinic_clients
  for each row
  execute function odonto.set_clinic_client_updated_at();
