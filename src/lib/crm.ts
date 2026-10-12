export type PatientSearchFields = {
  nome_completo: string
  email: string
  whatsapp: string
}

export function searchPatients<T extends PatientSearchFields>(patients: readonly T[], query: string): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('pt-BR')
  return patients.filter((patient) =>
    [patient.nome_completo, patient.email, patient.whatsapp]
      .some((value) => value.toLocaleLowerCase('pt-BR').includes(normalizedQuery)),
  )
}
