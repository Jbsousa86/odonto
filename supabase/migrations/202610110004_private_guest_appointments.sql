create table odonto.guest_appointments (
  id uuid primary key default gen_random_uuid(),
  patient_name varchar(255) not null,
  patient_whatsapp varchar(20) not null,
  dentist_id uuid not null references odonto.dentistas(id) on delete restrict,
  procedure_id uuid not null references odonto.procedimentos(id) on delete restrict,
  appointment_start timestamptz not null,
  appointment_end timestamptz not null,
  status text not null default 'agendado',
  access_token_hash text not null unique,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint guest_appointments_interval_valid check (appointment_end > appointment_start),
  constraint guest_appointments_status_valid check (status in ('agendado', 'cancelado')),
  constraint guest_appointments_name_not_empty check (length(trim(patient_name)) > 0),
  constraint guest_appointments_phone_valid check (patient_whatsapp ~ '^\+[1-9][0-9]{7,14}$'),
  constraint guest_appointments_token_hash_valid check (access_token_hash ~ '^[0-9a-f]{64}$')
);

create index idx_guest_appointments_dentist_period
  on odonto.guest_appointments (dentist_id, appointment_start, appointment_end)
  where status = 'agendado';

alter table odonto.guest_appointments enable row level security;

revoke all on table odonto.guest_appointments from public, anon, authenticated;

create policy "clinic staff can read guest appointments"
  on odonto.guest_appointments for select to authenticated
  using ((select odonto.is_clinic_staff()));

grant select (
  id, patient_name, patient_whatsapp, dentist_id, procedure_id,
  appointment_start, appointment_end, status, created_by, created_at
) on odonto.guest_appointments to authenticated;

create or replace function odonto.check_appointment_availability(
  p_dentista_id uuid,
  p_inicio timestamptz,
  p_fim timestamptz
)
returns table (disponivel boolean, motivo text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Autenticação obrigatória.' using errcode = '28000';
  end if;
  if p_inicio is null or p_fim is null or p_fim <= p_inicio then
    raise exception 'O intervalo de horário é inválido.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from odonto.dentistas d where d.id = p_dentista_id and d.ativo
  ) then
    return query select false, 'Dentista não encontrado ou inativo.'::text;
    return;
  end if;
  if exists (
    select 1 from odonto.agendamentos a
    where a.dentista_id = p_dentista_id
      and a.status in ('pendente', 'confirmado')
      and a.data_hora_inicio < p_fim
      and a.data_hora_fim > p_inicio
  ) or exists (
    select 1 from odonto.guest_appointments g
    where g.dentist_id = p_dentista_id
      and g.status = 'agendado'
      and g.appointment_start < p_fim
      and g.appointment_end > p_inicio
  ) then
    return query select false, 'Dentista ocupado neste horário.'::text;
    return;
  end if;
  if exists (
    select 1 from odonto.bloqueios_agenda b
    where (b.dentista_id = p_dentista_id or b.dentista_id is null)
      and b.data_hora_inicio < p_fim
      and b.data_hora_fim > p_inicio
  ) then
    return query select false, 'Horário bloqueado pela clínica.'::text;
    return;
  end if;
  return query select true, null::text;
end;
$$;

create or replace function odonto.create_appointment(
  p_dentista_id uuid,
  p_procedimento_id uuid,
  p_inicio timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_paciente_id uuid;
  v_fim timestamptz;
  v_agendamento_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Autenticação obrigatória.' using errcode = '28000';
  end if;
  if p_inicio is null then
    raise exception 'Informe a data e o horário de início.' using errcode = '22023';
  end if;

  select p.id into v_paciente_id
  from odonto.pacientes p
  where p.auth_user_id = (select auth.uid());
  if v_paciente_id is null then
    raise exception 'Complete seu cadastro antes de solicitar uma consulta.' using errcode = '42501';
  end if;

  select p_inicio + make_interval(mins => p.duracao_minutos)
  into v_fim
  from odonto.procedimentos p
  where p.id = p_procedimento_id and p.ativo;
  if v_fim is null then
    raise exception 'Procedimento não encontrado ou inativo.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from odonto.dentistas d where d.id = p_dentista_id and d.ativo
  ) then
    raise exception 'Dentista não encontrado ou inativo.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(938221771);
  if exists (
    select 1 from odonto.agendamentos a
    where a.dentista_id = p_dentista_id
      and a.status in ('pendente', 'confirmado')
      and a.data_hora_inicio < v_fim
      and a.data_hora_fim > p_inicio
  ) or exists (
    select 1 from odonto.guest_appointments g
    where g.dentist_id = p_dentista_id
      and g.status = 'agendado'
      and g.appointment_start < v_fim
      and g.appointment_end > p_inicio
  ) then
    raise exception 'Dentista ocupado neste horário.' using errcode = '23P01';
  end if;
  if exists (
    select 1 from odonto.bloqueios_agenda b
    where (b.dentista_id = p_dentista_id or b.dentista_id is null)
      and b.data_hora_inicio < v_fim
      and b.data_hora_fim > p_inicio
  ) then
    raise exception 'Horário bloqueado pela clínica.' using errcode = '23P01';
  end if;

  insert into odonto.agendamentos (
    paciente_id, dentista_id, procedimento_id, data_hora_inicio, data_hora_fim
  ) values (
    v_paciente_id, p_dentista_id, p_procedimento_id, p_inicio, v_fim
  ) returning id into v_agendamento_id;

  return v_agendamento_id;
end;
$$;

create or replace function odonto.create_schedule_block(
  p_dentista_id uuid,
  p_inicio timestamptz,
  p_fim timestamptz,
  p_motivo text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bloqueio_id uuid;
begin
  if not (select odonto.is_clinic_staff()) then
    raise exception 'Acesso restrito à equipe da clínica.' using errcode = '42501';
  end if;
  if p_inicio is null or p_fim is null or p_fim <= p_inicio
    or p_motivo is null or length(trim(p_motivo)) = 0 then
    raise exception 'Informe um intervalo válido e o motivo do bloqueio.' using errcode = '22023';
  end if;
  if p_dentista_id is not null and not exists (
    select 1 from odonto.dentistas d where d.id = p_dentista_id
  ) then
    raise exception 'Dentista não encontrado.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(938221771);
  if exists (
    select 1 from odonto.agendamentos a
    where (p_dentista_id is null or a.dentista_id = p_dentista_id)
      and a.status in ('pendente', 'confirmado')
      and a.data_hora_inicio < p_fim
      and a.data_hora_fim > p_inicio
  ) or exists (
    select 1 from odonto.guest_appointments g
    where (p_dentista_id is null or g.dentist_id = p_dentista_id)
      and g.status = 'agendado'
      and g.appointment_start < p_fim
      and g.appointment_end > p_inicio
  ) then
    raise exception 'O bloqueio conflita com uma consulta existente.' using errcode = '23P01';
  end if;
  if exists (
    select 1 from odonto.bloqueios_agenda b
    where (p_dentista_id is null or b.dentista_id is null or b.dentista_id = p_dentista_id)
      and b.data_hora_inicio < p_fim
      and b.data_hora_fim > p_inicio
  ) then
    raise exception 'Já existe um bloqueio neste período.' using errcode = '23P01';
  end if;

  insert into odonto.bloqueios_agenda (dentista_id, data_hora_inicio, data_hora_fim, motivo)
  values (p_dentista_id, p_inicio, p_fim, trim(p_motivo))
  returning id into v_bloqueio_id;
  return v_bloqueio_id;
end;
$$;

create or replace function odonto.create_guest_appointment(
  p_patient_name text,
  p_patient_whatsapp text,
  p_dentist_id uuid,
  p_procedure_id uuid,
  p_appointment_start timestamptz,
  p_access_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment_end timestamptz;
  v_guest_appointment_id uuid;
begin
  if not (select odonto.is_clinic_staff()) then
    raise exception 'Acesso restrito à equipe da clínica.' using errcode = '42501';
  end if;
  if p_patient_name is null or length(trim(p_patient_name)) = 0 or length(trim(p_patient_name)) > 255
    or p_patient_whatsapp is null or p_patient_whatsapp !~ '^\+[1-9][0-9]{7,14}$'
    or p_appointment_start is null or p_appointment_start <= now()
    or p_access_token_hash is null or p_access_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Confira nome, WhatsApp, data e link do atendimento.' using errcode = '22023';
  end if;

  select p_appointment_start + make_interval(mins => p.duracao_minutos)
  into v_appointment_end
  from odonto.procedimentos p
  where p.id = p_procedure_id and p.ativo;
  if v_appointment_end is null then
    raise exception 'Procedimento não encontrado ou inativo.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from odonto.dentistas d where d.id = p_dentist_id and d.ativo
  ) then
    raise exception 'Dentista não encontrado ou inativo.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(938221771);
  if exists (
    select 1 from odonto.agendamentos a
    where a.dentista_id = p_dentist_id
      and a.status in ('pendente', 'confirmado')
      and a.data_hora_inicio < v_appointment_end
      and a.data_hora_fim > p_appointment_start
  ) or exists (
    select 1 from odonto.guest_appointments g
    where g.dentist_id = p_dentist_id
      and g.status = 'agendado'
      and g.appointment_start < v_appointment_end
      and g.appointment_end > p_appointment_start
  ) then
    raise exception 'Dentista ocupado neste horário.' using errcode = '23P01';
  end if;
  if exists (
    select 1 from odonto.bloqueios_agenda b
    where (b.dentist_id = p_dentist_id or b.dentist_id is null)
      and b.data_hora_inicio < v_appointment_end
      and b.data_hora_fim > p_appointment_start
  ) then
    raise exception 'Horário bloqueado pela clínica.' using errcode = '23P01';
  end if;

  insert into odonto.guest_appointments (
    patient_name, patient_whatsapp, dentist_id, procedure_id,
    appointment_start, appointment_end, access_token_hash, created_by
  ) values (
    trim(p_patient_name), p_patient_whatsapp, p_dentist_id, p_procedure_id,
    p_appointment_start, v_appointment_end, p_access_token_hash, (select auth.uid())
  ) returning id into v_guest_appointment_id;

  return v_guest_appointment_id;
end;
$$;

create or replace function odonto.rotate_guest_appointment_link(
  p_guest_appointment_id uuid,
  p_access_token_hash text
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
  if p_access_token_hash is null or p_access_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'O link gerado é inválido.' using errcode = '22023';
  end if;
  update odonto.guest_appointments
  set access_token_hash = p_access_token_hash
  where id = p_guest_appointment_id and status = 'agendado';
  if not found then
    raise exception 'Atendimento não encontrado ou cancelado.' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function odonto.get_guest_appointment(p_access_token_hash text)
returns table (
  patient_name text,
  procedure_name text,
  dentist_name text,
  appointment_start timestamptz,
  appointment_end timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select g.patient_name::text, p.nome::text, d.nome::text, g.appointment_start, g.appointment_end
  from odonto.guest_appointments g
  join odonto.procedimentos p on p.id = g.procedure_id
  join odonto.dentistas d on d.id = g.dentist_id
  where g.access_token_hash = p_access_token_hash
    and p_access_token_hash ~ '^[0-9a-f]{64}$'
    and g.status = 'agendado';
$$;

revoke all on function odonto.create_guest_appointment(text, text, uuid, uuid, timestamptz, text)
  from public, anon, authenticated;
revoke all on function odonto.rotate_guest_appointment_link(uuid, text)
  from public, anon, authenticated;
revoke all on function odonto.get_guest_appointment(text)
  from public, anon, authenticated;
revoke all on function odonto.check_appointment_availability(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function odonto.create_appointment(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function odonto.create_guest_appointment(text, text, uuid, uuid, timestamptz, text) to authenticated;
grant execute on function odonto.rotate_guest_appointment_link(uuid, text) to authenticated;
grant execute on function odonto.get_guest_appointment(text) to anon, authenticated;
