import { describe, expect, it } from 'vitest'
import { summarizePayments } from './payment-report'

describe('summarizePayments', () => {
  it('counts and totals each payment method for the selected inclusive date range', () => {
    const appointments = [
      { status: 'finalizado', payment_method: 'dinheiro', payment_amount: 100, paid_at: '2026-10-10T15:00:00.000Z' },
      { status: 'finalizado', payment_method: 'pix', payment_amount: 49.9, paid_at: '2026-10-11T15:00:00.000Z' },
      { status: 'finalizado', payment_method: 'cartao', payment_amount: 25.25, paid_at: '2026-10-12T15:00:00.000Z' },
      { status: 'finalizado', payment_method: 'pix', payment_amount: 500, paid_at: '2026-10-13T15:00:00.000Z' },
    ]

    const result = summarizePayments(appointments, '2026-10-11', '2026-10-12')

    expect(result.totalCount).toBe(2)
    expect(result.totalCents).toBe(7515)
    expect(result.byMethod.pix).toEqual({ count: 1, cents: 4990 })
    expect(result.byMethod.cartao).toEqual({ count: 1, cents: 2525 })
    expect(result.byMethod.dinheiro).toEqual({ count: 0, cents: 0 })
  })

  it('ignores canceled or unpaid appointments', () => {
    const appointments = [
      { status: 'cancelado', payment_method: 'pix', payment_amount: 20, paid_at: '2026-10-11T15:00:00.000Z' },
      { status: 'finalizado', payment_method: null, payment_amount: null, paid_at: null },
    ]

    const result = summarizePayments(appointments, '2026-10-11', '2026-10-11')

    expect(result.totalCount).toBe(0)
    expect(result.totalCents).toBe(0)
  })
})
