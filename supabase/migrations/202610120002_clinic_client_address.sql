alter table odonto.clinic_clients
  add column if not exists rua varchar(255),
  add column if not exists bairro varchar(120),
  add column if not exists cidade varchar(120);

grant update (rua, bairro, cidade)
  on odonto.clinic_clients to authenticated;
