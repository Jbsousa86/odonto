create table if not exists odonto.clinic_clients (
  id uuid primary key default gen_random_uuid(),
  nome_completo varchar(255) not null,
  whatsapp varchar(20) not null,
  email varchar(255),
  data_nascimento date,
  criado_por uuid not null references auth.users(id) on delete restrict,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint clinic_clients_name_not_empty check (length(trim(nome_completo)) > 0),
  constraint clinic_clients_whatsapp_valid check (whatsapp ~ '^\+[1-9][0-9]{7,14}$'),
  constraint clinic_clients_email_valid check (email is null or length(trim(email)) > 0)
);

create index if not exists idx_clinic_clients_name on odonto.clinic_clients (nome_completo);
create index if not exists idx_clinic_clients_whatsapp on odonto.clinic_clients (whatsapp);

alter table odonto.clinic_clients enable row level security;
revoke all on table odonto.clinic_clients from public, anon, authenticated;

drop policy if exists "clinic staff can read clinic clients" on odonto.clinic_clients;
create policy "clinic staff can read clinic clients"
  on odonto.clinic_clients for select to authenticated
  using ((select odonto.is_clinic_staff()));
drop policy if exists "clinic staff can register clinic clients" on odonto.clinic_clients;
create policy "clinic staff can register clinic clients"
  on odonto.clinic_clients for insert to authenticated
  with check ((select odonto.is_clinic_staff()) and criado_por = (select auth.uid()));
drop policy if exists "clinic staff can update clinic clients" on odonto.clinic_clients;
create policy "clinic staff can update clinic clients"
  on odonto.clinic_clients for update to authenticated
  using ((select odonto.is_clinic_staff()))
  with check ((select odonto.is_clinic_staff()));

grant select, insert, update on odonto.clinic_clients to authenticated;

alter table odonto.guest_appointments
  add column if not exists clinic_client_id uuid;

grant select (clinic_client_id) on odonto.guest_appointments to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'odonto.guest_appointments'::regclass
      and conname = 'guest_appointments_clinic_client_id_fkey'
  ) then
    alter table odonto.guest_appointments
      add constraint guest_appointments_clinic_client_id_fkey
      foreign key (clinic_client_id)
      references odonto.clinic_clients(id)
      on delete restrict;
  end if;
end;
$$;

create index if not exists idx_guest_appointments_client
  on odonto.guest_appointments (clinic_client_id, appointment_start);

drop function if exists odonto.create_guest_appointment(text, text, uuid, uuid, timestamptz, text);

create or replace function odonto.create_guest_appointment(
  p_clinic_client_id uuid,
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
  v_client odonto.clinic_clients%rowtype;
  v_appointment_end timestamptz;
  v_guest_appointment_id uuid;
begin
  if not (select odonto.is_clinic_staff()) then
    raise exception 'Acesso restrito à equipe da clínica.' using errcode = '42501';
  end if;
  if p_clinic_client_id is null
    or p_appointment_start is null or p_appointment_start <= now()
    or p_access_token_hash is null or p_access_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Selecione um cliente cadastrado e informe data e link válidos.' using errcode = '22023';
  end if;

  select c.* into v_client
  from odonto.clinic_clients c
  where c.id = p_clinic_client_id;
  if not found then
    raise exception 'Cliente não encontrado. Cadastre o cliente antes de agendar.' using errcode = 'P0002';
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
    where (b.dentista_id = p_dentist_id or b.dentista_id is null)
      and b.data_hora_inicio < v_appointment_end
      and b.data_hora_fim > p_appointment_start
  ) then
    raise exception 'Horário bloqueado pela clínica.' using errcode = '23P01';
  end if;

  insert into odonto.guest_appointments (
    clinic_client_id, patient_name, patient_whatsapp, dentist_id, procedure_id,
    appointment_start, appointment_end, access_token_hash, created_by
  ) values (
    v_client.id, v_client.nome_completo, v_client.whatsapp, p_dentist_id, p_procedure_id,
    p_appointment_start, v_appointment_end, p_access_token_hash, (select auth.uid())
  ) returning id into v_guest_appointment_id;

  return v_guest_appointment_id;
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
  select coalesce(c.nome_completo, g.patient_name)::text,
    p.nome::text, d.nome::text, g.appointment_start, g.appointment_end
  from odonto.guest_appointments g
  left join odonto.clinic_clients c on c.id = g.clinic_client_id
  join odonto.procedimentos p on p.id = g.procedure_id
  join odonto.dentistas d on d.id = g.dentist_id
  where g.access_token_hash = p_access_token_hash
    and p_access_token_hash ~ '^[0-9a-f]{64}$'
    and g.status = 'agendado';
$$;

revoke all on function odonto.create_guest_appointment(uuid, uuid, uuid, timestamptz, text)
  from public, anon, authenticated;
grant execute on function odonto.create_guest_appointment(uuid, uuid, uuid, timestamptz, text)
  to authenticated;
