create or replace function odonto.cancel_guest_appointment(
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

  perform pg_advisory_xact_lock(938221771);

  update odonto.guest_appointments
  set status = 'cancelado'
  where id = p_guest_appointment_id
    and status = 'agendado';

  if not found then
    raise exception 'Atendimento não encontrado, já cancelado ou finalizado.' using errcode = '22023';
  end if;
end;
$$;

revoke all on function odonto.cancel_guest_appointment(uuid)
  from public, anon, authenticated;
grant execute on function odonto.cancel_guest_appointment(uuid)
  to authenticated;
