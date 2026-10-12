export function normalizeWhatsApp(value: string) {
  const trimmed = value.trim()
  const digits = trimmed.replace(/\D/g, '')
  const internationalDigits =
    trimmed.startsWith('+') || digits.startsWith('00')
      ? digits.startsWith('00') ? digits.slice(2) : digits
      : digits.length === 10 || digits.length === 11 ? `55${digits}` : digits

  if (!/^[1-9]\d{7,14}$/.test(internationalDigits)) {
    throw new Error('Informe um WhatsApp válido com código do país, por exemplo +55 11 99999-9999.')
  }
  return `+${internationalDigits}`
}

export function buildWhatsAppUrl(phone: string, message: string) {
  const phoneDigits = phone.replace(/\D/g, '')
  if (!/^[1-9]\d{7,14}$/.test(phoneDigits)) {
    throw new Error('Informe um WhatsApp válido para compartilhar a consulta.')
  }

  const url = new URL(`https://wa.me/${phoneDigits}`)
  url.searchParams.set('text', message)
  return url.toString()
}
