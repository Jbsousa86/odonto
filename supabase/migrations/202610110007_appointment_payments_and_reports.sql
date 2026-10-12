alter table odonto.guest_appointments
  add column if not exists payment_method text,
  add column if not exists payment_amount numeric(12, 2),
  add column if not exists paid_at timestamptz;

alter table odonto.guest_appointments
  drop constraint if exists guest_appointments_payment_method_valid,
  drop constraint if exists guest_appointments_payment_amount_nonnegative;

alter table odonto.guest_appointments
  add constraint guest_appointments_payment_method_valid
    check (payment_method is null or payment_method in ('dinheiro', 'cartao', 'pix')),
  add constraint guest_appointments_payment_amount_nonnegative
    check (payment_amount is null or payment_amount >= 0);

create index if not exists idx_guest_appointments_paid_at
  on odonto.guest_appointments (paid_at)
  where paid_at is not null;

grant select (payment_method, payment_amount, paid_at)
  on odonto.guest_appointments to authenticated;

drop function if exists odonto.finish_guest_appointment(uuid);

create or replace function odonto.finish_guest_appointment(
  p_guest_appointment_id uuid,
  p_payment_method text,
  p_payment_amount numeric
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
  if p_payment_method is null or p_payment_method not in ('dinheiro', 'cartao', 'pix')
    or p_payment_amount is null or p_payment_amount < 0
    or p_payment_amount > 9999999999.99
    or p_payment_amount <> round(p_payment_amount, 2) then
    raise exception 'Informe uma forma de pagamento e um valor válido.' using errcode = '22023';
  end if;

  update odonto.guest_appointments
  set status = 'finalizado',
      payment_method = p_payment_method,
      payment_amount = p_payment_amount,
      paid_at = now()
  where id = p_guest_appointment_id
    and status = 'agendado'
    and appointment_end <= now();

  if not found then
    raise exception 'Atendimento não encontrado, já finalizado/cancelado ou ainda não encerrado.' using errcode = '22023';
  end if;
end;
$$;

revoke all on function odonto.finish_guest_appointment(uuid, text, numeric)
  from public, anon, authenticated;
grant execute on function odonto.finish_guest_appointment(uuid, text, numeric)
  to authenticated;

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
    and g.status in ('agendado', 'finalizado');
$$;

revoke all on function odonto.get_guest_appointment(text)
  from public, anon, authenticated;
grant execute on function odonto.get_guest_appointment(text)
  to anon, authenticated;
