import { describe, expect, it } from 'vitest'
import { buildAppointmentLink, createAppointmentLinkSecret, hashAppointmentLinkSecret } from './appointment-link'

describe('appointment link secrets', () => {
  it('creates an unguessable token and stores only its SHA-256 hash', async () => {
    const { token, tokenHash } = await createAppointmentLinkSecret()

    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenHash).not.toBe(token)
    await expect(hashAppointmentLinkSecret(token)).resolves.toBe(tokenHash)
  })

  it('rejects malformed access tokens', async () => {
    await expect(hashAppointmentLinkSecret('short')).rejects.toThrow(/link da consulta é inválido/i)
  })

  it('puts the secret in the URL fragment, not in the request path', () => {
    expect(buildAppointmentLink('abc123', 'https://odonto.example', '/')).toBe(
      'https://odonto.example/#consulta=abc123',
    )
  })
})
