create schema if not exists odonto;
revoke all on schema odonto from public;
grant usage on schema odonto to anon, authenticated, service_role;

create table odonto.pacientes (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  nome_completo varchar(255) not null,
  whatsapp varchar(20) not null unique,
  email varchar(255) not null,
  data_nascimento date,
  criado_em timestamptz not null default now(),
  constraint pacientes_nome_nao_vazio check (length(trim(nome_completo)) > 0),
  constraint pacientes_whatsapp_nao_vazio check (length(trim(whatsapp)) > 0)
);

create table odonto.dentistas (
  id uuid primary key default gen_random_uuid(),
  nome varchar(255) not null,
  cro varchar(50) not null unique,
  especialidade varchar(100) not null,
  ativo boolean not null default true,
  constraint dentistas_nome_nao_vazio check (length(trim(nome)) > 0),
  constraint dentistas_especialidade_nao_vazia check (length(trim(especialidade)) > 0)
);

create table odonto.procedimentos (
  id uuid primary key default gen_random_uuid(),
  nome varchar(100) not null,
  duracao_minutos integer not null,
  preco_base numeric(10, 2) not null,
  ativo boolean not null default true,
  constraint procedimentos_nome_nao_vazio check (length(trim(nome)) > 0),
  constraint procedimentos_duracao_positiva check (duracao_minutos > 0),
  constraint procedimentos_preco_nao_negativo check (preco_base >= 0)
);

create table odonto.agendamentos (
  id uuid primary key default gen_random_uuid(),
  paciente_id uuid not null references odonto.pacientes(id) on delete restrict,
  dentista_id uuid not null references odonto.dentistas(id) on delete restrict,
  procedimento_id uuid not null references odonto.procedimentos(id) on delete restrict,
  data_hora_inicio timestamptz not null,
  data_hora_fim timestamptz not null,
  status varchar(30) not null default 'pendente',
  criado_em timestamptz not null default now(),
  constraint agendamentos_intervalo_valido check (data_hora_fim > data_hora_inicio),
  constraint agendamentos_status_valido check (
    status in ('pendente', 'confirmado', 'finalizado', 'cancelado', 'no-show')
  )
);

create table odonto.bloqueios_agenda (
  id uuid primary key default gen_random_uuid(),
  dentista_id uuid references odonto.dentistas(id) on delete restrict,
  data_hora_inicio timestamptz not null,
  data_hora_fim timestamptz not null,
  motivo varchar(255) not null,
  criado_em timestamptz not null default now(),
  constraint bloqueios_intervalo_valido check (data_hora_fim > data_hora_inicio),
  constraint bloqueios_motivo_nao_vazio check (length(trim(motivo)) > 0)
);

create table odonto.clinic_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  criado_em timestamptz not null default now()
);

create index idx_agendamentos_dentista_periodo
  on odonto.agendamentos (dentista_id, data_hora_inicio, data_hora_fim);
create index idx_agendamentos_status
  on odonto.agendamentos (status);
create index idx_agendamentos_paciente_periodo
  on odonto.agendamentos (paciente_id, data_hora_inicio);
create index idx_bloqueios_dentista_periodo
  on odonto.bloqueios_agenda (dentista_id, data_hora_inicio, data_hora_fim);
create index idx_procedimentos_ativos_nome
  on odonto.procedimentos (nome) where ativo;
create index idx_dentistas_ativos_nome
  on odonto.dentistas (nome) where ativo;

alter table odonto.pacientes enable row level security;
alter table odonto.dentistas enable row level security;
alter table odonto.procedimentos enable row level security;
alter table odonto.agendamentos enable row level security;
alter table odonto.bloqueios_agenda enable row level security;
alter table odonto.clinic_staff enable row level security;

create or replace function odonto.is_clinic_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from odonto.clinic_staff
    where user_id = (select auth.uid())
  );
$$;

revoke all on function odonto.is_clinic_staff() from public;
grant execute on function odonto.is_clinic_staff() to authenticated;

create policy "patients can read their own profile"
  on odonto.pacientes for select to authenticated
  using ((select auth.uid()) = auth_user_id);
create policy "patients can create their own profile"
  on odonto.pacientes for insert to authenticated
  with check ((select auth.uid()) = auth_user_id);
create policy "patients can update their own profile"
  on odonto.pacientes for update to authenticated
  using ((select auth.uid()) = auth_user_id)
  with check ((select auth.uid()) = auth_user_id);

create policy "authenticated users can read active dentists"
  on odonto.dentistas for select to authenticated
  using (ativo or (select odonto.is_clinic_staff()));
create policy "clinic staff can create dentists"
  on odonto.dentistas for insert to authenticated
  with check ((select odonto.is_clinic_staff()));
create policy "clinic staff can update dentists"
  on odonto.dentistas for update to authenticated
  using ((select odonto.is_clinic_staff()))
  with check ((select odonto.is_clinic_staff()));

create policy "authenticated users can read active procedures"
  on odonto.procedimentos for select to authenticated
  using (ativo or (select odonto.is_clinic_staff()));
create policy "clinic staff can create procedures"
  on odonto.procedimentos for insert to authenticated
  with check ((select odonto.is_clinic_staff()));
create policy "clinic staff can update procedures"
  on odonto.procedimentos for update to authenticated
  using ((select odonto.is_clinic_staff()))
  with check ((select odonto.is_clinic_staff()));

create policy "patients can read their own appointments"
  on odonto.agendamentos for select to authenticated
  using (
    exists (
      select 1 from odonto.pacientes
      where pacientes.id = agendamentos.paciente_id
        and pacientes.auth_user_id = (select auth.uid())
    )
  );

create policy "clinic staff can read schedule blocks"
  on odonto.bloqueios_agenda for select to authenticated
  using ((select odonto.is_clinic_staff()));
create policy "clinic staff can remove schedule blocks"
  on odonto.bloqueios_agenda for delete to authenticated
  using ((select odonto.is_clinic_staff()));

create policy "users can read their own staff membership"
  on odonto.clinic_staff for select to authenticated
  using (user_id = (select auth.uid()) or (select odonto.is_clinic_staff()));

grant select, insert on odonto.pacientes to authenticated;
grant update (nome_completo, whatsapp, email, data_nascimento) on odonto.pacientes to authenticated;
grant select, insert, update on odonto.dentistas to authenticated;
grant select, insert, update on odonto.procedimentos to authenticated;
grant select on odonto.agendamentos to authenticated;
grant select, delete on odonto.bloqueios_agenda to authenticated;
grant select on odonto.clinic_staff to authenticated;

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
    select 1
    from odonto.agendamentos a
    where a.dentista_id = p_dentista_id
      and a.status in ('pendente', 'confirmado')
      and a.data_hora_inicio < p_fim
      and a.data_hora_fim > p_inicio
  ) then
    return query select false, 'Dentista ocupado neste horário.'::text;
    return;
  end if;
  if exists (
    select 1
    from odonto.bloqueios_agenda b
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
    select 1
    from odonto.agendamentos a
    where a.dentista_id = p_dentista_id
      and a.status in ('pendente', 'confirmado')
      and a.data_hora_inicio < v_fim
      and a.data_hora_fim > p_inicio
  ) then
    raise exception 'Dentista ocupado neste horário.' using errcode = '23P01';
  end if;
  if exists (
    select 1
    from odonto.bloqueios_agenda b
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
    select 1
    from odonto.agendamentos a
    where (p_dentista_id is null or a.dentista_id = p_dentista_id)
      and a.status in ('pendente', 'confirmado')
      and a.data_hora_inicio < p_fim
      and a.data_hora_fim > p_inicio
  ) then
    raise exception 'O bloqueio conflita com uma consulta existente.' using errcode = '23P01';
  end if;
  if exists (
    select 1
    from odonto.bloqueios_agenda b
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

revoke all on function odonto.check_appointment_availability(uuid, timestamptz, timestamptz) from public;
revoke all on function odonto.create_appointment(uuid, uuid, timestamptz) from public;
revoke all on function odonto.create_schedule_block(uuid, timestamptz, timestamptz, text) from public;
grant execute on function odonto.check_appointment_availability(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function odonto.create_appointment(uuid, uuid, timestamptz) to authenticated;
grant execute on function odonto.create_schedule_block(uuid, timestamptz, timestamptz, text) to authenticated;
