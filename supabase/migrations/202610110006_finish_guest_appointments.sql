alter table odonto.guest_appointments
  drop constraint if exists guest_appointments_status_valid;

alter table odonto.guest_appointments
  add constraint guest_appointments_status_valid
  check (status in ('agendado', 'cancelado', 'finalizado'));

create or replace function odonto.finish_guest_appointment(
  p_guest_appointment_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select odonto.is_clinic_staff()) then
    raise exception 'Acesso restrito à equipe da clínica.' using errcode = '42501';
  end if;

  update odonto.guest_appointments
  set status = 'finalizado'
  where id = p_guest_appointment_id
    and status = 'agendado'
    and appointment_end <= now();

  if not found then
    raise exception 'Atendimento não encontrado, já finalizado/cancelado ou ainda não encerrado.' using errcode = '22023';
  end if;
end;
$$;

revoke all on function odonto.finish_guest_appointment(uuid)
  from public, anon, authenticated;
grant execute on function odonto.finish_guest_appointment(uuid)
  to authenticated;
