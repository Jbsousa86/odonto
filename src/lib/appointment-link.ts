export async function createAppointmentLinkSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  const tokenHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return { token, tokenHash }
}

export async function hashAppointmentLinkSecret(token: string) {
  if (!/^[0-9a-f]{64}$/i.test(token)) throw new Error('O link da consulta é inválido.')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function buildAppointmentLink(token: string, origin: string, pathname: string) {
  return `${origin}${pathname}#consulta=${encodeURIComponent(token)}`
}
