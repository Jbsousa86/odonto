grant usage on schema odonto to authenticated, service_role;

alter table odonto.pacientes
  add column whatsapp_consentido_em timestamptz;

create table odonto.appointment_confirmation_outbox (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null unique references odonto.agendamentos(id) on delete restrict,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  criado_em timestamptz not null default now(),
  constraint appointment_confirmation_status_valid
    check (status in ('pending', 'sending', 'sent', 'failed')),
  constraint appointment_confirmation_attempts_nonnegative
    check (attempts >= 0)
);

alter table odonto.appointment_confirmation_outbox enable row level security;

create policy "clinic staff can read confirmation delivery status"
  on odonto.appointment_confirmation_outbox for select to authenticated
  using ((select odonto.is_clinic_staff()));

grant select on odonto.appointment_confirmation_outbox to authenticated;

create policy "clinic staff can read all patients"
  on odonto.pacientes for select to authenticated
  using ((select odonto.is_clinic_staff()));

create policy "clinic staff can read all appointments"
  on odonto.agendamentos for select to authenticated
  using ((select odonto.is_clinic_staff()));

grant update (nome_completo, whatsapp, email, data_nascimento, whatsapp_consentido_em)
  on odonto.pacientes to authenticated;

create or replace function odonto.confirm_appointment(p_appointment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment odonto.agendamentos%rowtype;
  v_patient odonto.pacientes%rowtype;
  v_outbox_id uuid;
begin
  if not (select odonto.is_clinic_staff()) then
    raise exception 'Acesso restrito à equipe da clínica.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(938221771);

  select a.* into v_appointment
  from odonto.agendamentos a
  where a.id = p_appointment_id
  for update;

  if not found then
    raise exception 'Consulta não encontrada.' using errcode = 'P0002';
  end if;
  if v_appointment.status <> 'pendente' then
    raise exception 'Somente consultas pendentes podem ser confirmadas.' using errcode = '22023';
  end if;

  select p.* into v_patient
  from odonto.pacientes p
  where p.id = v_appointment.paciente_id;

  if v_patient.whatsapp_consentido_em is null then
    raise exception 'O paciente ainda não autorizou receber confirmações pelo WhatsApp.' using errcode = '22023';
  end if;
  if v_patient.whatsapp !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'O WhatsApp do paciente precisa estar em formato internacional válido.' using errcode = '22023';
  end if;

  update odonto.agendamentos
  set status = 'confirmado'
  where id = p_appointment_id;

  insert into odonto.appointment_confirmation_outbox (appointment_id)
  values (p_appointment_id)
  returning id into v_outbox_id;

  return v_outbox_id;
end;
$$;

create or replace function odonto.claim_appointment_confirmation_notification(
  p_appointment_id uuid
)
returns table (
  outbox_id uuid,
  patient_name text,
  patient_whatsapp text,
  procedure_name text,
  dentist_name text,
  appointment_start timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outbox_id uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'Operação reservada ao serviço de notificações.' using errcode = '42501';
  end if;

  update odonto.appointment_confirmation_outbox o
  set status = 'sending',
      attempts = o.attempts + 1,
      last_attempt_at = now(),
      last_error = null
  where o.appointment_id = p_appointment_id
    and (
      o.status in ('pending', 'failed')
      or (o.status = 'sending' and o.last_attempt_at < now() - interval '5 minutes')
    )
  returning o.id into v_outbox_id;

  if v_outbox_id is null then
    return;
  end if;

  return query
  select
    o.id,
    p.nome_completo::text,
    p.whatsapp::text,
    pr.nome::text,
    d.nome::text,
    a.data_hora_inicio
  from odonto.appointment_confirmation_outbox o
  join odonto.agendamentos a on a.id = o.appointment_id
  join odonto.pacientes p on p.id = a.paciente_id
  join odonto.procedimentos pr on pr.id = a.procedimento_id
  join odonto.dentistas d on d.id = a.dentista_id
  where o.id = v_outbox_id;
end;
$$;

create or replace function odonto.complete_appointment_confirmation_notification(
  p_outbox_id uuid,
  p_provider_message_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'Operação reservada ao serviço de notificações.' using errcode = '42501';
  end if;

  update odonto.appointment_confirmation_outbox
  set status = 'sent',
      sent_at = now(),
      provider_message_id = p_provider_message_id,
      last_error = null
  where id = p_outbox_id and status = 'sending';

  if not found then
    raise exception 'Notificação não encontrada ou não está em envio.' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function odonto.fail_appointment_confirmation_notification(
  p_outbox_id uuid,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'Operação reservada ao serviço de notificações.' using errcode = '42501';
  end if;

  update odonto.appointment_confirmation_outbox
  set status = 'failed',
      last_error = left(coalesce(p_error, 'Falha no envio de WhatsApp.'), 500)
  where id = p_outbox_id and status = 'sending';

  if not found then
    raise exception 'Notificação não encontrada ou não está em envio.' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function odonto.confirm_appointment(uuid) from public, anon;
revoke all on function odonto.claim_appointment_confirmation_notification(uuid) from public, anon, authenticated;
revoke all on function odonto.complete_appointment_confirmation_notification(uuid, text) from public, anon, authenticated;
revoke all on function odonto.fail_appointment_confirmation_notification(uuid, text) from public, anon, authenticated;
grant execute on function odonto.confirm_appointment(uuid) to authenticated;
grant execute on function odonto.claim_appointment_confirmation_notification(uuid) to service_role;
grant execute on function odonto.complete_appointment_confirmation_notification(uuid, text) to service_role;
grant execute on function odonto.fail_appointment_confirmation_notification(uuid, text) to service_role;
