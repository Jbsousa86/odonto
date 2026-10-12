create or replace function odonto.reschedule_guest_appointment(
  p_guest_appointment_id uuid,
  p_appointment_start timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment odonto.guest_appointments%rowtype;
  v_appointment_end timestamptz;
  v_duration_minutes integer;
begin
  if not (select odonto.is_clinic_staff()) then
    raise exception 'Acesso restrito à equipe da clínica.' using errcode = '42501';
  end if;
  if p_appointment_start is null or p_appointment_start <= now() then
    raise exception 'Escolha uma data e um horário futuros.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(938221771);

  select g.* into v_appointment
  from odonto.guest_appointments g
  where g.id = p_guest_appointment_id
    and g.status = 'agendado'
  for update;
  if not found then
    raise exception 'Atendimento não encontrado, cancelado ou finalizado.' using errcode = '22023';
  end if;

  select p.duracao_minutos into v_duration_minutes
  from odonto.procedimentos p
  where p.id = v_appointment.procedure_id;
  if v_duration_minutes is null then
    raise exception 'Não foi possível determinar a duração do procedimento.' using errcode = '22023';
  end if;
  v_appointment_end := p_appointment_start + make_interval(mins => v_duration_minutes);

  if exists (
    select 1 from odonto.agendamentos a
    where a.dentista_id = v_appointment.dentist_id
      and a.status in ('pendente', 'confirmado')
      and a.data_hora_inicio < v_appointment_end
      and a.data_hora_fim > p_appointment_start
  ) or exists (
    select 1 from odonto.guest_appointments g
    where g.id <> p_guest_appointment_id
      and g.dentist_id = v_appointment.dentist_id
      and g.status = 'agendado'
      and g.appointment_start < v_appointment_end
      and g.appointment_end > p_appointment_start
  ) then
    raise exception 'Dentista ocupado neste horário.' using errcode = '23P01';
  end if;
  if exists (
    select 1 from odonto.bloqueios_agenda b
    where (b.dentista_id = v_appointment.dentist_id or b.dentista_id is null)
      and b.data_hora_inicio < v_appointment_end
      and b.data_hora_fim > p_appointment_start
  ) then
    raise exception 'Horário bloqueado pela clínica.' using errcode = '23P01';
  end if;

  update odonto.guest_appointments
  set appointment_start = p_appointment_start,
      appointment_end = v_appointment_end
  where id = p_guest_appointment_id
    and status = 'agendado';

  if not found then
    raise exception 'O atendimento não está mais disponível para remarcação.' using errcode = '22023';
  end if;
end;
$$;

revoke all on function odonto.reschedule_guest_appointment(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function odonto.reschedule_guest_appointment(uuid, timestamptz)
  to authenticated;
