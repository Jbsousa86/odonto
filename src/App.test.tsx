import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ClinicWelcomeScreen, SupabaseSetupNotice } from './App'
import { searchPatients } from './lib/crm'
import { buildWhatsAppUrl, normalizeWhatsApp } from './lib/whatsapp'

describe('App', () => {
  it('explains how to connect Supabase when environment variables are missing', () => {
    render(<SupabaseSetupNotice />)
    expect(screen.getByRole('heading', { name: /conecte o supabase/i })).toBeInTheDocument()
    expect(screen.getByText(/VITE_SUPABASE_URL/)).toBeInTheDocument()
  })

  it('shows the clinic image and enters the system from the welcome screen', () => {
    const onEnter = vi.fn()
    render(<ClinicWelcomeScreen onEnter={onEnter} />)

    const clinicImage = screen.getByRole('img', { name: 'Imagem da clínica' })
    expect(clinicImage).toHaveAttribute('src', '/clinic-welcome.png')
    expect(clinicImage).toHaveClass('h-full', 'w-full', 'object-cover')
    fireEvent.click(screen.getByRole('button', { name: 'Acessar sistema' }))
    expect(onEnter).toHaveBeenCalledOnce()
  })

  it('normalizes Brazilian WhatsApp numbers to international format', () => {
    expect(normalizeWhatsApp('(11) 99999-9999')).toBe('+5511999999999')
    expect(normalizeWhatsApp('+55 11 99999-9999')).toBe('+5511999999999')
  })

  it('rejects phone numbers that cannot be sent through WhatsApp', () => {
    expect(() => normalizeWhatsApp('123')).toThrow(/WhatsApp válido/)
  })

  it('builds a WhatsApp share link with the recipient and encoded message', () => {
    const url = new URL(buildWhatsAppUrl('+55 (11) 99999-9999', 'Sua consulta: https://example.com/consulta?a=1&b=2'))

    expect(url.origin + url.pathname).toBe('https://wa.me/5511999999999')
    expect(url.searchParams.get('text')).toBe('Sua consulta: https://example.com/consulta?a=1&b=2')
  })

  it('rejects invalid recipients when building a WhatsApp share link', () => {
    expect(() => buildWhatsAppUrl('123', 'Consulta')).toThrow(/WhatsApp válido/)
  })

  it('filters CRM patients by name, email, or WhatsApp without case sensitivity', () => {
    const patients = [
      { id: '1', nome_completo: 'João da Silva', email: 'joao@example.com', whatsapp: '+5511999999999' },
      { id: '2', nome_completo: 'Maria Souza', email: 'maria@example.com', whatsapp: '+5521988888888' },
    ]

    expect(searchPatients(patients, 'JOÃO').map(({ id }) => id)).toEqual(['1'])
    expect(searchPatients(patients, 'MARIA@EXAMPLE.COM').map(({ id }) => id)).toEqual(['2'])
    expect(searchPatients(patients, '988888888').map(({ id }) => id)).toEqual(['2'])
    expect(searchPatients(patients, '   ')).toEqual(patients)
  })
})
