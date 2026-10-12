export const paymentMethods = ['dinheiro', 'cartao', 'pix'] as const

export type PaymentMethod = (typeof paymentMethods)[number]

export type PaymentRecord = {
  status: string
  payment_method: string | null
  payment_amount: number | null
  paid_at: string | null
}

export type PaymentMethodTotal = {
  count: number
  cents: number
}

function isPaymentMethod(value: string | null): value is PaymentMethod {
  return value === 'dinheiro' || value === 'cartao' || value === 'pix'
}

export function localDateKey(value: string) {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function countCompletedAppointments<T extends { status: string; appointment_start: string }>(
  appointments: T[],
  startDate: string,
  endDate: string,
) {
  return appointments.filter((appointment) => {
    if (appointment.status !== 'finalizado') return false
    const appointmentDate = localDateKey(appointment.appointment_start)
    return appointmentDate >= startDate && appointmentDate <= endDate
  }).length
}

export function summarizePayments<T extends PaymentRecord>(appointments: T[], startDate: string, endDate: string) {
  const byMethod: Record<PaymentMethod, PaymentMethodTotal> = {
    dinheiro: { count: 0, cents: 0 },
    cartao: { count: 0, cents: 0 },
    pix: { count: 0, cents: 0 },
  }

  const records = appointments.filter((appointment) => {
    if (
      appointment.status !== 'finalizado' ||
      !appointment.paid_at ||
      appointment.payment_amount === null ||
      !Number.isFinite(appointment.payment_amount) ||
      !isPaymentMethod(appointment.payment_method)
    ) {
      return false
    }
    const paidDate = localDateKey(appointment.paid_at)
    return paidDate >= startDate && paidDate <= endDate
  })

  let totalCents = 0
  for (const record of records) {
    if (!isPaymentMethod(record.payment_method) || record.payment_amount === null) continue
    const method = record.payment_method
    const cents = Math.round(record.payment_amount * 100)
    byMethod[method].count += 1
    byMethod[method].cents += cents
    totalCents += cents
  }

  return { records, byMethod, totalCents, totalCount: records.length }
}
