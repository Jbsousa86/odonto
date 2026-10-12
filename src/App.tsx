import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import type { Database } from './lib/database.types'
import { buildWhatsAppUrl, normalizeWhatsApp } from './lib/whatsapp'
import { buildAppointmentLink, createAppointmentLinkSecret, hashAppointmentLinkSecret } from './lib/appointment-link'
import { countCompletedAppointments, paymentMethods, summarizePayments, type PaymentMethod } from './lib/payment-report'

type Dentist = Database['odonto']['Tables']['dentistas']['Row']
type Procedure = Database['odonto']['Tables']['procedimentos']['Row']
type GuestAppointment = Database['odonto']['Tables']['guest_appointments']['Row']
type ClinicClient = Database['odonto']['Tables']['clinic_clients']['Row']
type ScheduleBlock = Database['odonto']['Tables']['bloqueios_agenda']['Row']
type GuestAppointmentDetails = Database['odonto']['Functions']['get_guest_appointment']['Returns'][number]

const fieldClass =
  'mt-1 min-w-0 w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-900 outline-none transition focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/15'
const buttonClass =
  'inline-flex min-h-11 items-center justify-center rounded-xl bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-55'

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return 'Ocorreu um erro inesperado. Tente novamente.'
}

function errorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null
}

function localDateTimeToIso(value: string) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) throw new Error('Escolha uma data e um horário válidos.')
  return date.toISOString()
}

function isoToLocalDateTimeInput(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('O horário atual deste atendimento é inválido.')
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function localToday() {
  const today = new Date()
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value)
}

function guestAppointmentLinksStorageKey(userId: string) {
  return `odonto-guest-appointment-links:${userId}`
}

function readGuestAppointmentLinks(userId: string) {
  const storedLinks = window.sessionStorage.getItem(guestAppointmentLinksStorageKey(userId))
  if (!storedLinks) return {}

  const parsed: unknown = JSON.parse(storedLinks)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Os links salvos nesta sessão estão em formato inválido.')
  }

  const links: Record<string, string> = {}
  for (const [appointmentId, link] of Object.entries(parsed)) {
    if (typeof link !== 'string') {
      throw new Error('Um dos links salvos nesta sessão está inválido.')
    }
    const url = new URL(link)
    const token = new URLSearchParams(url.hash.slice(1)).get('consulta')
    if (url.origin !== window.location.origin || !token || !/^[0-9a-f]{64}$/.test(token)) {
      throw new Error('Um dos links salvos nesta sessão está inválido.')
    }
    links[appointmentId] = link
  }
  return links
}

function AuthenticatedApp() {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [authLoading, setAuthLoading] = useState(Boolean(supabase))
  const [now, setNow] = useState(() => Date.now())
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [isStaff, setIsStaff] = useState(false)
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null)
  const [workspaceLoadFailed, setWorkspaceLoadFailed] = useState(false)
  const [activeTab, setActiveTab] = useState<'visao-geral' | 'agendar' | 'consultas' | 'clientes' | 'relatorios' | 'configuracoes'>('visao-geral')
  const [showClinicWelcome, setShowClinicWelcome] = useState(true)
  const [showClinicClientsList, setShowClinicClientsList] = useState(false)
  const [appointmentListMode, setAppointmentListMode] = useState<'upcoming' | 'history'>('upcoming')
  const [dentists, setDentists] = useState<Dentist[]>([])
  const [procedures, setProcedures] = useState<Procedure[]>([])
  const [guestAppointments, setGuestAppointments] = useState<GuestAppointment[]>([])
  const [clinicClients, setClinicClients] = useState<ClinicClient[]>([])
  const [guestAppointmentLinks, setGuestAppointmentLinks] = useState<Record<string, string>>({})
  const [newGuestAppointment, setNewGuestAppointment] = useState({
    clinicClientId: '',
    dentistId: '',
    procedureId: '',
    appointmentStart: '',
  })
  const [newClinicClient, setNewClinicClient] = useState({
    nomeCompleto: '',
    whatsapp: '',
    email: '',
    dataNascimento: '',
    rua: '',
    bairro: '',
    cidade: '',
  })
  const [editingClinicClientId, setEditingClinicClientId] = useState<string | null>(null)
  const [clinicClientEdit, setClinicClientEdit] = useState({
    nomeCompleto: '',
    whatsapp: '',
    email: '',
    dataNascimento: '',
    rua: '',
    bairro: '',
    cidade: '',
  })
  const [paymentForm, setPaymentForm] = useState<{
    appointmentId: string
    method: PaymentMethod | ''
    amount: string
  } | null>(null)
  const [rescheduleForm, setRescheduleForm] = useState<{
    appointmentId: string
    appointmentStart: string
  } | null>(null)
  const [cancelAppointmentId, setCancelAppointmentId] = useState<string | null>(null)
  const [cancelConfirmed, setCancelConfirmed] = useState(false)
  const [expandedClientId, setExpandedClientId] = useState<string | null>(null)
  const [reportStartDate, setReportStartDate] = useState(localToday)
  const [reportEndDate, setReportEndDate] = useState(localToday)
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([])
  const [newDentist, setNewDentist] = useState({ nome: '', cro: '', especialidade: '' })
  const [newProcedure, setNewProcedure] = useState({ nome: '', duracao: '30', preco: '0' })
  const [newBlock, setNewBlock] = useState({
    dentistaId: '',
    inicio: '',
    fim: '',
    motivo: '',
  })

  function restoreGuestAppointmentLinks(nextUser: User | null) {
    if (!nextUser) {
      setGuestAppointmentLinks({})
      return
    }

    try {
      setGuestAppointmentLinks(readGuestAppointmentLinks(nextUser.id))
    } catch (storageError) {
      setGuestAppointmentLinks({})
      setError(`Não foi possível recuperar o link privado desta sessão: ${errorMessage(storageError)}`)
    }
  }

  function saveGuestAppointmentLink(appointmentId: string, link: string) {
    const updatedLinks = { ...guestAppointmentLinks, [appointmentId]: link }
    setGuestAppointmentLinks(updatedLinks)
    if (!user) return

    try {
      window.sessionStorage.setItem(
        guestAppointmentLinksStorageKey(user.id),
        JSON.stringify(updatedLinks),
      )
    } catch (storageError) {
      setError(`Link gerado e visível nesta tela, mas não foi possível mantê-lo após atualizar a página: ${errorMessage(storageError)}`)
    }
  }

  function removeGuestAppointmentLink(appointmentId: string) {
    const updatedLinks = { ...guestAppointmentLinks }
    delete updatedLinks[appointmentId]
    setGuestAppointmentLinks(updatedLinks)
    if (!user) return

    try {
      window.sessionStorage.setItem(
        guestAppointmentLinksStorageKey(user.id),
        JSON.stringify(updatedLinks),
      )
    } catch (storageError) {
      setError(`Consulta cancelada, mas não foi possível atualizar os links desta sessão: ${errorMessage(storageError)}`)
    }
  }

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    if (!isStaff || loadedUserId !== user?.id || showClinicWelcome) return

    const activityEvents: Array<keyof WindowEventMap> = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel']
    let idleTimeout = window.setTimeout(() => setShowClinicWelcome(true), 60_000)
    const resetIdleTimeout = () => {
      window.clearTimeout(idleTimeout)
      idleTimeout = window.setTimeout(() => setShowClinicWelcome(true), 60_000)
    }

    activityEvents.forEach((eventName) => window.addEventListener(eventName, resetIdleTimeout, { passive: true }))
    return () => {
      window.clearTimeout(idleTimeout)
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, resetIdleTimeout))
    }
  }, [isStaff, loadedUserId, showClinicWelcome, user?.id])

  useEffect(() => {
    if (!supabase) {
      return
    }
    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (sessionError) setError(sessionError.message)
      setSession(data.session)
      setUser(data.session?.user ?? null)
      restoreGuestAppointmentLinks(data.session?.user ?? null)
      setShowClinicWelcome(true)
      setActiveTab('visao-geral')
      setShowClinicClientsList(false)
      setAuthLoading(false)
    })
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setUser(nextSession?.user ?? null)
      setError('')
      setNotice('')
      setShowClinicWelcome(true)
      setActiveTab('visao-geral')
      setShowClinicClientsList(false)
      restoreGuestAppointmentLinks(nextSession?.user ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  const loadWorkspace = useCallback(async (isCurrent: () => boolean = () => true) => {
    if (!supabase || !user) return
    try {
      const [staffResult, dentistResult, procedureResult] = await Promise.all([
        supabase.from('clinic_staff').select('user_id').eq('user_id', user.id).maybeSingle(),
        supabase.from('dentistas').select('*').order('nome'),
        supabase.from('procedimentos').select('*').order('nome'),
      ])
      if (staffResult.error) throw new Error(`Acesso da equipe: ${errorMessage(staffResult.error)}`)
      if (dentistResult.error) throw new Error(`Lista de dentistas: ${errorMessage(dentistResult.error)}`)
      if (procedureResult.error) throw new Error(`Lista de procedimentos: ${errorMessage(procedureResult.error)}`)

      if (!isCurrent()) return
      setIsStaff(Boolean(staffResult.data))
      setDentists(dentistResult.data ?? [])
      setProcedures(procedureResult.data ?? [])

      if (staffResult.data) {
        const [blockResult, guestAppointmentResult, clinicClientResult] = await Promise.all([
          supabase.from('bloqueios_agenda').select('*').order('data_hora_inicio', { ascending: true }),
          supabase
            .from('guest_appointments')
            .select('id,clinic_client_id,patient_name,patient_whatsapp,dentist_id,procedure_id,appointment_start,appointment_end,status,payment_method,payment_amount,paid_at,created_by,created_at')
            .order('appointment_start', { ascending: true }),
          supabase.from('clinic_clients').select('*').order('nome_completo'),
        ])
        if (blockResult.error) throw new Error(`Bloqueios de agenda: ${errorMessage(blockResult.error)}`)
        if (guestAppointmentResult.error) {
          throw new Error(`Atendimentos por link: ${errorMessage(guestAppointmentResult.error)}`)
        }
        if (clinicClientResult.error) throw new Error(`Cadastro de clientes: ${errorMessage(clinicClientResult.error)}`)
        if (!isCurrent()) return
        setBlocks(blockResult.data ?? [])
        setGuestAppointments(guestAppointmentResult.data ?? [])
        setClinicClients(clinicClientResult.data ?? [])
      } else {
        setBlocks([])
        setGuestAppointments([])
        setClinicClients([])
      }
      if (!isCurrent()) return
      setError('')
      setWorkspaceLoadFailed(false)
      setLoadedUserId(user.id)
    } catch (loadError) {
      if (!isCurrent()) return
      setIsStaff(false)
      setBlocks([])
      setGuestAppointments([])
      setClinicClients([])
      setWorkspaceLoadFailed(true)
      setLoadedUserId(user.id)
      setError(`Não foi possível carregar os dados: ${errorMessage(loadError)}`)
    }
  }, [user])

  useEffect(() => {
    let isCurrent = true
    if (user) {
      void Promise.resolve().then(() => {
        if (isCurrent) return loadWorkspace(() => isCurrent)
      })
    }
    return () => {
      isCurrent = false
    }
  }, [loadWorkspace, user])

  const activeDentists = useMemo(() => dentists.filter((dentist) => dentist.ativo), [dentists])
  const activeProcedures = useMemo(() => procedures.filter((procedure) => procedure.ativo), [procedures])
  const procedureById = useMemo(
    () => new Map(procedures.map((procedure) => [procedure.id, procedure])),
    [procedures],
  )
  const dentistById = useMemo(
    () => new Map(dentists.map((dentist) => [dentist.id, dentist])),
    [dentists],
  )
  const upcomingAppointments = guestAppointments
    .filter((appointment) => appointment.status === 'agendado' && new Date(appointment.appointment_start).getTime() >= now)
    .sort((left, right) => left.appointment_start.localeCompare(right.appointment_start))
  const unfinishedAppointments = guestAppointments
    .filter((appointment) => appointment.status === 'agendado')
    .sort((left, right) => left.appointment_start.localeCompare(right.appointment_start))
  const historicalAppointments = guestAppointments
    .filter((appointment) => appointment.status !== 'agendado' || new Date(appointment.appointment_end).getTime() <= now)
    .sort((left, right) => right.appointment_start.localeCompare(left.appointment_start))
  const displayedAppointments = appointmentListMode === 'upcoming' ? upcomingAppointments : historicalAppointments
  const orderedClients = [...clinicClients]
    .sort((left, right) => right.criado_em.localeCompare(left.criado_em))
  const reportRangeValid = reportStartDate <= reportEndDate
  const paymentReport = useMemo(
    () => reportRangeValid ? summarizePayments(guestAppointments, reportStartDate, reportEndDate) : null,
    [guestAppointments, reportEndDate, reportRangeValid, reportStartDate],
  )
  const completedAppointmentCount = useMemo(
    () => reportRangeValid ? countCompletedAppointments(guestAppointments, reportStartDate, reportEndDate) : null,
    [guestAppointments, reportEndDate, reportRangeValid, reportStartDate],
  )

  async function submitPasswordAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { error: signinError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })
      if (signinError) throw signinError
      setNotice('Acesso confirmado.')
    } catch (authError) {
      setError(`Não foi possível entrar: ${errorMessage(authError)}`)
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    if (!supabase) return
    const { error: signOutError } = await supabase.auth.signOut()
    if (signOutError) setError(`Não foi possível sair: ${signOutError.message}`)
  }

  async function createGuestAppointment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    const procedure = procedureById.get(newGuestAppointment.procedureId)
    if (!newGuestAppointment.clinicClientId || !procedure || !newGuestAppointment.dentistId) {
      setError('Selecione um cliente cadastrado, um dentista e um procedimento.')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { token, tokenHash } = await createAppointmentLinkSecret()
      const { data: appointmentId, error: createError } = await supabase.rpc('create_guest_appointment', {
        p_clinic_client_id: newGuestAppointment.clinicClientId,
        p_dentist_id: newGuestAppointment.dentistId,
        p_procedure_id: procedure.id,
        p_appointment_start: localDateTimeToIso(newGuestAppointment.appointmentStart),
        p_access_token_hash: tokenHash,
      })
      if (createError) throw createError
      if (!appointmentId) throw new Error('O atendimento foi criado, mas o identificador não foi retornado.')
      saveGuestAppointmentLink(
        appointmentId,
        buildAppointmentLink(token, window.location.origin, window.location.pathname),
      )
      setNotice('Atendimento cadastrado. Copie o link privado e envie ao cliente pelo canal combinado.')
      setNewGuestAppointment({
        clinicClientId: '',
        dentistId: '',
        procedureId: '',
        appointmentStart: '',
      })
      await loadWorkspace()
      setAppointmentListMode('upcoming')
      setActiveTab('consultas')
      setNotice('Atendimento cadastrado. Confira os dados e use “Enviar pelo WhatsApp” para compartilhar o link com o cliente.')
    } catch (createError) {
      setError(`Não foi possível criar o atendimento com link: ${errorMessage(createError)}`)
    } finally {
      setBusy(false)
    }
  }

  async function registerClinicClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || !user) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { data, error: insertError } = await supabase
        .from('clinic_clients')
        .insert({
          nome_completo: newClinicClient.nomeCompleto.trim(),
          whatsapp: normalizeWhatsApp(newClinicClient.whatsapp),
          email: newClinicClient.email.trim() || null,
          data_nascimento: newClinicClient.dataNascimento || null,
          rua: newClinicClient.rua.trim() || null,
          bairro: newClinicClient.bairro.trim() || null,
          cidade: newClinicClient.cidade.trim() || null,
          criado_por: user.id,
        })
        .select('id')
        .single()
      if (insertError) throw insertError
      setNewGuestAppointment((current) => ({ ...current, clinicClientId: data.id }))
      setNewClinicClient({ nomeCompleto: '', whatsapp: '', email: '', dataNascimento: '', rua: '', bairro: '', cidade: '' })
      setShowClinicClientsList(false)
      setActiveTab('visao-geral')
      setNotice('Cliente cadastrado. Ele já está disponível na Visão geral e na agenda para agendamento.')
      await loadWorkspace()
    } catch (insertError) {
      setError(`Não foi possível cadastrar o cliente: ${errorMessage(insertError)}`)
    } finally {
      setBusy(false)
    }
  }

  async function updateClinicClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase || !editingClinicClientId) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { data, error: updateError } = await supabase
        .from('clinic_clients')
        .update({
          nome_completo: clinicClientEdit.nomeCompleto.trim(),
          whatsapp: normalizeWhatsApp(clinicClientEdit.whatsapp),
          email: clinicClientEdit.email.trim() || null,
          data_nascimento: clinicClientEdit.dataNascimento || null,
          rua: clinicClientEdit.rua.trim() || null,
          bairro: clinicClientEdit.bairro.trim() || null,
          cidade: clinicClientEdit.cidade.trim() || null,
        })
        .eq('id', editingClinicClientId)
        .select('*')
        .single()
      if (updateError) throw updateError
      setClinicClients((current) => current.map((client) => client.id === data.id ? data : client))
      setEditingClinicClientId(null)
      setNotice('Dados do cliente atualizados.')
    } catch (updateError) {
      setError(`Não foi possível atualizar os dados do cliente: ${errorMessage(updateError)}`)
    } finally {
      setBusy(false)
    }
  }

  async function renewGuestAppointmentLink(appointmentId: string) {
    if (!supabase) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { token, tokenHash } = await createAppointmentLinkSecret()
      const { error: rotateError } = await supabase.rpc('rotate_guest_appointment_link', {
        p_guest_appointment_id: appointmentId,
        p_access_token_hash: tokenHash,
      })
      if (rotateError) throw rotateError
      saveGuestAppointmentLink(
        appointmentId,
        buildAppointmentLink(token, window.location.origin, window.location.pathname),
      )
      setNotice('Novo link gerado. O link anterior foi invalidado; copie e envie este ao cliente.')
    } catch (rotateError) {
      setError(`Não foi possível gerar outro link: ${errorMessage(rotateError)}`)
    } finally {
      setBusy(false)
    }
  }

  async function finishGuestAppointment(appointmentId: string) {
    if (!supabase || !paymentForm || paymentForm.appointmentId !== appointmentId) return
    const amount = Number(paymentForm.amount)
    if (!paymentForm.method || !Number.isFinite(amount) || amount < 0 || amount > 9999999999.99 || Math.round(amount * 100) !== amount * 100) {
      setError('Selecione a forma de pagamento e informe um valor válido.')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { error: finishError } = await supabase.rpc('finish_guest_appointment', {
        p_guest_appointment_id: appointmentId,
        p_payment_method: paymentForm.method,
        p_payment_amount: amount,
      })
      if (finishError) throw finishError
      setNotice('Atendimento marcado como finalizado.')
      setPaymentForm(null)
      await loadWorkspace()
    } catch (finishError) {
      setError(
        errorCode(finishError) === 'PGRST202'
          ? 'A finalização com forma de pagamento ainda não foi ativada no Supabase. Aplique as migrations 006 e 007, nessa ordem, e recarregue o painel.'
          : `Não foi possível finalizar o atendimento e registrar o pagamento: ${errorMessage(finishError)}`,
      )
    } finally {
      setBusy(false)
    }
  }

  async function rescheduleGuestAppointment(event: FormEvent<HTMLFormElement>, appointmentId: string) {
    event.preventDefault()
    if (!supabase || !rescheduleForm || rescheduleForm.appointmentId !== appointmentId) return

    let appointmentStart: string
    try {
      appointmentStart = localDateTimeToIso(rescheduleForm.appointmentStart)
      if (new Date(appointmentStart).getTime() <= Date.now()) {
        throw new Error('Escolha uma data e um horário futuros.')
      }
    } catch (validationError) {
      setError(errorMessage(validationError))
      return
    }

    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { error: rescheduleError } = await supabase.rpc('reschedule_guest_appointment', {
        p_guest_appointment_id: appointmentId,
        p_appointment_start: appointmentStart,
      })
      if (rescheduleError) throw rescheduleError
      setRescheduleForm(null)
      setNotice('Atendimento remarcado. O link privado continua válido; avise o cliente sobre o novo horário.')
      await loadWorkspace()
    } catch (rescheduleError) {
      setError(`Não foi possível remarcar o atendimento: ${errorMessage(rescheduleError)}`)
    } finally {
      setBusy(false)
    }
  }

  async function cancelGuestAppointment(appointmentId: string) {
    if (!supabase || cancelAppointmentId !== appointmentId) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { error: cancelError } = await supabase.rpc('cancel_guest_appointment', {
        p_guest_appointment_id: appointmentId,
      })
      if (cancelError) throw cancelError
      removeGuestAppointmentLink(appointmentId)
      setCancelAppointmentId(null)
      setCancelConfirmed(false)
      setNotice('Desistência registrada. A consulta foi cancelada, o horário liberado e o link do cliente invalidado.')
      await loadWorkspace()
    } catch (cancelError) {
      setError(`Não foi possível registrar a desistência: ${errorMessage(cancelError)}`)
    } finally {
      setBusy(false)
    }
  }

  async function copyGuestAppointmentLink(appointmentId: string) {
    const link = guestAppointmentLinks[appointmentId]
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setNotice('Link privado copiado. Envie-o ao cliente pelo canal combinado.')
    } catch (copyError) {
      setError(`Não foi possível copiar o link: ${errorMessage(copyError)}`)
    }
  }

  function whatsAppAppointmentUrl(appointment: GuestAppointment) {
    const link = guestAppointmentLinks[appointment.id]
    if (!link) return null
    const procedureName = procedureById.get(appointment.procedure_id)?.nome ?? 'atendimento'
    const message = `Olá, ${appointment.patient_name}! Sua consulta de ${procedureName} está agendada para ${formatDateTime(appointment.appointment_start)}. Consulte os detalhes pelo link privado: ${link}`
    return buildWhatsAppUrl(appointment.patient_whatsapp, message)
  }

  async function addDentist(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    setBusy(true)
    setError('')
    try {
      const { error: insertError } = await supabase.from('dentistas').insert({
        nome: newDentist.nome.trim(),
        cro: newDentist.cro.trim(),
        especialidade: newDentist.especialidade.trim(),
      })
      if (insertError) throw insertError
      setNewDentist({ nome: '', cro: '', especialidade: '' })
      setNotice('Dentista cadastrado.')
      await loadWorkspace()
    } catch (insertError) {
      setError(`Não foi possível cadastrar o dentista: ${errorMessage(insertError)}`)
    } finally {
      setBusy(false)
    }
  }

  async function updateDentist(event: FormEvent<HTMLFormElement>, dentistId: string) {
    event.preventDefault()
    if (!supabase) return
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      const { error: updateError } = await supabase
        .from('dentistas')
        .update({
          nome: String(form.get('nome')).trim(),
          cro: String(form.get('cro')).trim(),
          especialidade: String(form.get('especialidade')).trim(),
        })
        .eq('id', dentistId)
      if (updateError) throw updateError
      setNotice('Dados do dentista atualizados.')
      await loadWorkspace()
    } catch (updateError) {
      setError(`Não foi possível atualizar os dados do dentista: ${errorMessage(updateError)}`)
    } finally {
      setBusy(false)
    }
  }

  async function toggleDentist(dentist: Dentist) {
    if (!supabase) return
    setBusy(true)
    setError('')
    try {
      const { error: updateError } = await supabase
        .from('dentistas')
        .update({ ativo: !dentist.ativo })
        .eq('id', dentist.id)
      if (updateError) throw updateError
      await loadWorkspace()
    } catch (updateError) {
      setError(`Não foi possível atualizar o dentista: ${errorMessage(updateError)}`)
    } finally {
      setBusy(false)
    }
  }

  async function addProcedure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    setBusy(true)
    setError('')
    try {
      const { error: insertError } = await supabase.from('procedimentos').insert({
        nome: newProcedure.nome.trim(),
        duracao_minutos: Number(newProcedure.duracao),
        preco_base: Number(newProcedure.preco),
      })
      if (insertError) throw insertError
      setNewProcedure({ nome: '', duracao: '30', preco: '0' })
      setNotice('Procedimento cadastrado.')
      await loadWorkspace()
    } catch (insertError) {
      setError(`Não foi possível cadastrar o procedimento: ${errorMessage(insertError)}`)
    } finally {
      setBusy(false)
    }
  }

  async function updateProcedure(event: FormEvent<HTMLFormElement>, procedureId: string) {
    event.preventDefault()
    if (!supabase) return
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      const { error: updateError } = await supabase
        .from('procedimentos')
        .update({
          nome: String(form.get('nome')).trim(),
          duracao_minutos: Number(form.get('duracao')),
          preco_base: Number(form.get('preco')),
        })
        .eq('id', procedureId)
      if (updateError) throw updateError
      setNotice('Dados do procedimento atualizados.')
      await loadWorkspace()
    } catch (updateError) {
      setError(`Não foi possível atualizar o procedimento: ${errorMessage(updateError)}`)
    } finally {
      setBusy(false)
    }
  }

  async function toggleProcedure(procedure: Procedure) {
    if (!supabase) return
    setBusy(true)
    setError('')
    try {
      const { error: updateError } = await supabase
        .from('procedimentos')
        .update({ ativo: !procedure.ativo })
        .eq('id', procedure.id)
      if (updateError) throw updateError
      await loadWorkspace()
    } catch (updateError) {
      setError(`Não foi possível atualizar o procedimento: ${errorMessage(updateError)}`)
    } finally {
      setBusy(false)
    }
  }

  async function addScheduleBlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const start = localDateTimeToIso(newBlock.inicio)
      const end = localDateTimeToIso(newBlock.fim)
      if (new Date(end) <= new Date(start)) throw new Error('O fim precisa ser depois do início.')
      const { error: blockError } = await supabase.rpc('create_schedule_block', {
        p_dentista_id: newBlock.dentistaId || null,
        p_inicio: start,
        p_fim: end,
        p_motivo: newBlock.motivo.trim(),
      })
      if (blockError) throw blockError
      setNewBlock({ dentistaId: '', inicio: '', fim: '', motivo: '' })
      setNotice('Bloqueio de agenda criado.')
      await loadWorkspace()
    } catch (blockError) {
      setError(`Não foi possível criar o bloqueio: ${errorMessage(blockError)}`)
    } finally {
      setBusy(false)
    }
  }

  async function removeScheduleBlock(blockId: string) {
    if (!supabase) return
    setBusy(true)
    setError('')
    try {
      const { error: deleteError } = await supabase.from('bloqueios_agenda').delete().eq('id', blockId)
      if (deleteError) throw deleteError
      setNotice('Bloqueio removido.')
      await loadWorkspace()
    } catch (deleteError) {
      setError(`Não foi possível remover o bloqueio: ${errorMessage(deleteError)}`)
    } finally {
      setBusy(false)
    }
  }

  if (!isSupabaseConfigured) return <SupabaseSetupNotice />

  if (authLoading) return <LoadingScreen label="Verificando seu acesso..." />

  if (!session || !user) {
    return (
      <main className="grid min-h-screen place-items-center px-4 py-10">
        <section className="w-full max-w-md rounded-3xl border border-stone-200 bg-white p-7 shadow-sm sm:p-9">
          <Brand />
          <p className="mt-8 text-sm font-semibold uppercase tracking-[.15em] text-emerald-800">Área restrita</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">Acesso da clínica</h1>
          <p className="mt-3 leading-6 text-stone-600">
            A equipe da clínica entra para gerenciar a agenda. Clientes acessam somente pelo link privado enviado pela clínica.
          </p>
          <form className="mt-6 space-y-4" onSubmit={submitPasswordAuth}>
            <label className="block text-sm font-medium text-stone-700">
              E-mail
              <input
                className={fieldClass}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                aria-label="E-mail"
              />
            </label>
            <label className="block text-sm font-medium text-stone-700">
              Senha
              <input
                className={fieldClass}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={8}
                aria-label="Senha"
              />
            </label>
            <button className={`${buttonClass} w-full`} disabled={busy}>
              {busy ? 'Aguarde...' : 'Entrar'}
            </button>
          </form>
          <Feedback error={error} notice={notice} />
        </section>
      </main>
    )
  }

  if (loadedUserId !== user.id) return <LoadingScreen label="Carregando sua agenda..." />
  if (workspaceLoadFailed) {
    return (
      <main className="grid min-h-screen place-items-center px-4 py-10">
        <section className="w-full max-w-lg rounded-3xl border border-stone-200 bg-white p-7 shadow-sm">
          <Brand />
          <h1 className="mt-8 text-2xl font-semibold text-stone-900">Não foi possível carregar sua agenda</h1>
          <Feedback error={error} notice="" />
          <button className={`${buttonClass} mt-5`} onClick={() => void loadWorkspace()}>Tentar novamente</button>
        </section>
      </main>
    )
  }

  if (!isStaff) {
    return (
      <main className="grid min-h-screen place-items-center px-4 py-10">
        <section className="w-full max-w-lg rounded-3xl border border-stone-200 bg-white p-7 shadow-sm">
          <Brand />
          <h1 className="mt-8 text-2xl font-semibold text-stone-900">Acesso restrito à clínica</h1>
          <p className="mt-3 leading-6 text-stone-600">
            Esta conta não está autorizada para gerenciar a agenda. Para visualizar uma consulta, abra o link privado recebido da clínica.
          </p>
          <button className={`${buttonClass} mt-5`} onClick={signOut}>Sair</button>
        </section>
      </main>
    )
  }

  if (showClinicWelcome) {
    return <ClinicWelcomeScreen onEnter={() => setShowClinicWelcome(false)} />
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
      <div className="mx-auto flex w-[95%] max-w-none items-center justify-between gap-4 py-4">
        <Brand />
        <div className="flex items-center gap-3">
          <span className="hidden max-w-48 truncate text-sm text-stone-600 sm:block">{user.email}</span>
          <button className="rounded-xl border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50" onClick={signOut}>Sair</button>
        </div>
      </div>
      </header>
      <main className="mx-auto min-w-0 w-[95%] max-w-none py-6 sm:py-10">
      <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[.15em] text-emerald-800">Odonto • Agenda</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl">
            {activeTab === 'visao-geral'
              ? 'Visão geral da clínica'
              : activeTab === 'agendar'
                ? 'Agendar consulta'
                : activeTab === 'consultas'
                  ? appointmentListMode === 'upcoming' ? 'Próximas consultas' : 'Histórico de consultas'
                : activeTab === 'clientes'
                  ? 'Cadastrar cliente'
                  : activeTab === 'relatorios' ? 'Relatórios financeiros' : 'Configurações'}
          </h1>
          <p className="mt-2 max-w-2xl text-stone-600">
            {activeTab === 'visao-geral'
              ? 'Acompanhe os clientes cadastrados, as próximas consultas e a equipe da clínica.'
              : activeTab === 'agendar'
                ? 'Cadastre uma consulta e compartilhe o link privado de visualização com o cliente.'
                : activeTab === 'consultas'
                  ? appointmentListMode === 'upcoming' ? 'Consulte os próximos atendimentos agendados.' : 'Consulte atendimentos anteriores, realizados, cancelados ou aguardando registro.'
                : activeTab === 'clientes'
                  ? 'Cadastre um cliente para a clínica. Ele não precisa de usuário ou senha.'
                  : activeTab === 'relatorios'
                    ? 'Consulte os valores efetivamente recebidos por período e por forma de pagamento.'
                    : 'Configure dentistas, procedimentos e horários indisponíveis.'}
          </p>
        </div>
        {isStaff && (
          <nav aria-label="Seções da agenda" className="grid w-full grid-cols-2 gap-1 rounded-xl border border-stone-200 bg-white p-1 lg:flex lg:w-auto">
            <TabButton active={activeTab === 'visao-geral'} onClick={() => { setShowClinicClientsList(false); setActiveTab('visao-geral') }}>Visão geral</TabButton>
            <TabButton active={activeTab === 'agendar'} onClick={() => setActiveTab('agendar')}>Agendar</TabButton>
            <TabButton active={activeTab === 'clientes'} onClick={() => setActiveTab('clientes')}>Cadastrar cliente</TabButton>
            <TabButton active={activeTab === 'relatorios'} onClick={() => setActiveTab('relatorios')}>Relatórios</TabButton>
            <span className="mx-1 hidden h-6 border-l border-stone-200 lg:block" aria-hidden="true" />
            <TabButton className="col-span-2 sm:col-span-1" active={activeTab === 'configuracoes'} onClick={() => setActiveTab('configuracoes')}>Configurações</TabButton>
          </nav>
        )}
      </div>
      <Feedback error={error} notice={notice} />
      {activeTab === 'visao-geral' ? (
        <section className="mt-8 space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard
              label="Clientes cadastrados"
              value={clinicClients.length}
              detail="Clique para abrir a lista de clientes"
              onClick={() => setShowClinicClientsList(true)}
            />
            <SummaryCard
              label="Próximas consultas"
              value={upcomingAppointments.length}
              detail="Clique para ver todas as consultas futuras"
              onClick={() => {
                setAppointmentListMode('upcoming')
                setActiveTab('consultas')
              }}
            />
            <SummaryCard
              label="Histórico de consultas"
              value={historicalAppointments.length}
              detail="Clique para consultar atendimentos anteriores"
              onClick={() => {
                setAppointmentListMode('history')
                setActiveTab('consultas')
              }}
            />
            <SummaryCard label="Dentistas ativos" value={activeDentists.length} detail="Disponíveis para agendamento" />
          </div>
          <div className={showClinicClientsList ? 'space-y-6' : ''}>
            {!showClinicClientsList && (
            <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:p-7">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <SectionHeading eyebrow="Agenda da clínica" title="Consultas não finalizadas" />
                <button className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-700" type="button" onClick={() => setActiveTab('consultas')}>Ver consultas</button>
              </div>
              {unfinishedAppointments.length === 0 ? (
                <EmptyState title="Nenhuma consulta não finalizada" text="As consultas ainda agendadas pela clínica aparecerão aqui." />
              ) : (
                <ul className="mt-4 divide-y divide-stone-100">
                  {unfinishedAppointments.slice(0, 8).map((appointment) => (
                    <li key={appointment.id} className="flex flex-col justify-between gap-3 py-4 first:pt-0 sm:flex-row sm:items-center">
                      <div>
                        <p className="font-semibold text-stone-900">{appointment.patient_name}</p>
                        <p className="mt-1 text-sm text-stone-600">
                          {procedureById.get(appointment.procedure_id)?.nome ?? 'Atendimento'} · {dentistById.get(appointment.dentist_id)?.nome ?? 'Dentista'}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="shrink-0 text-sm font-medium text-stone-700">{formatDateTime(appointment.appointment_start)}</p>
                        <button
                          className="rounded-xl border border-emerald-700 px-3 py-2 text-sm font-semibold text-emerald-900 disabled:cursor-not-allowed disabled:opacity-55"
                          type="button"
                          disabled={busy || new Date(appointment.appointment_end).getTime() > now}
                          onClick={() => {
                            setRescheduleForm(null)
                            setPaymentForm({
                              appointmentId: appointment.id,
                              method: '',
                              amount: (procedureById.get(appointment.procedure_id)?.preco_base ?? 0).toFixed(2),
                            })
                          }}
                        >
                          {new Date(appointment.appointment_end).getTime() <= now ? 'Finalizar' : 'Finalizar após o horário'}
                        </button>
                      </div>
                      {paymentForm?.appointmentId === appointment.id && (
                        <form
                          className="grid w-full gap-3 rounded-2xl bg-emerald-50 p-4 sm:grid-cols-[1fr_1fr_auto]"
                          onSubmit={(event) => {
                            event.preventDefault()
                            void finishGuestAppointment(appointment.id)
                          }}
                        >
                          <label className="block text-sm font-medium text-stone-700">
                            Valor recebido (R$)
                            <input
                              className={fieldClass}
                              type="number"
                              min="0"
                              max="9999999999.99"
                              step="0.01"
                              value={paymentForm.amount}
                              onChange={(event) => setPaymentForm({ ...paymentForm, amount: event.target.value })}
                              required
                            />
                          </label>
                          <label className="block text-sm font-medium text-stone-700">
                            Forma de pagamento
                            <select
                              className={fieldClass}
                              value={paymentForm.method}
                              onChange={(event) => setPaymentForm({ ...paymentForm, method: event.target.value as PaymentMethod | '' })}
                              required
                            >
                              <option value="">Selecione</option>
                              <option value="dinheiro">Dinheiro</option>
                              <option value="cartao">Cartão</option>
                              <option value="pix">Pix</option>
                            </select>
                          </label>
                          <div className="flex items-end gap-2">
                            <button className={buttonClass} disabled={busy}>{busy ? 'Salvando...' : 'Confirmar'}</button>
                            <button className="min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold text-stone-700" type="button" disabled={busy} onClick={() => setPaymentForm(null)}>Cancelar</button>
                          </div>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            )}
            {showClinicClientsList && (
            <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:p-7">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <SectionHeading eyebrow="Clientes da clínica" title={`Clientes cadastrados (${clinicClients.length})`} />
                <button
                  className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-700"
                  type="button"
                  onClick={() => setShowClinicClientsList(false)}
                >
                  Voltar à visão geral
                </button>
              </div>
              {orderedClients.length === 0 ? (
                <EmptyState title="Nenhum cliente cadastrado" text="Cadastre os clientes para agendar consultas." />
              ) : (
                <ul className="mt-4 divide-y divide-stone-100">
                  {orderedClients.map((client) => {
                    const clientAppointments = guestAppointments
                      .filter((appointment) => appointment.clinic_client_id === client.id)
                      .sort((left, right) => right.appointment_start.localeCompare(left.appointment_start))
                    return (
                      <li key={client.id} className="py-4 first:pt-0">
                        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                          <div>
                            <button
                              className="text-left font-semibold text-emerald-900 underline decoration-emerald-300 underline-offset-4 hover:text-emerald-700"
                              type="button"
                              aria-expanded={expandedClientId === client.id}
                              aria-controls={`client-history-${client.id}`}
                              onClick={() => setExpandedClientId((current) => current === client.id ? null : client.id)}
                            >
                              {client.nome_completo}
                            </button>
                            <p className="mt-1 text-sm text-stone-600">{client.whatsapp}{client.email ? ` · ${client.email}` : ''}</p>
                            {(client.rua || client.bairro || client.cidade) && (
                              <p className="mt-1 text-sm text-stone-600">
                                {[client.rua, client.bairro, client.cidade].filter(Boolean).join(', ')}
                              </p>
                            )}
                          </div>
                          <button
                            className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-700"
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setEditingClinicClientId(client.id)
                              setClinicClientEdit({
                                nomeCompleto: client.nome_completo,
                                whatsapp: client.whatsapp,
                                email: client.email ?? '',
                                dataNascimento: client.data_nascimento ?? '',
                                rua: client.rua ?? '',
                                bairro: client.bairro ?? '',
                                cidade: client.cidade ?? '',
                              })
                              setError('')
                              setNotice('')
                            }}
                          >
                            Editar dados
                          </button>
                          <button
                            className={buttonClass}
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setNewGuestAppointment((current) => ({ ...current, clinicClientId: client.id }))
                              setActiveTab('agendar')
                            }}
                          >
                            Agendar para este cliente
                          </button>
                        </div>
                        {editingClinicClientId === client.id && (
                          <form className="mt-4 grid gap-4 rounded-2xl border border-emerald-100 bg-emerald-50/50 p-4 md:grid-cols-2" onSubmit={updateClinicClient}>
                            <label className="block text-sm font-medium text-stone-700">
                              Nome completo
                              <input className={fieldClass} value={clinicClientEdit.nomeCompleto} onChange={(event) => setClinicClientEdit({ ...clinicClientEdit, nomeCompleto: event.target.value })} required maxLength={255} />
                            </label>
                            <label className="block text-sm font-medium text-stone-700">
                              WhatsApp
                              <input className={fieldClass} type="tel" autoComplete="tel" value={clinicClientEdit.whatsapp} onChange={(event) => setClinicClientEdit({ ...clinicClientEdit, whatsapp: event.target.value })} required maxLength={20} placeholder="+55 11 99999-9999" />
                            </label>
                            <label className="block text-sm font-medium text-stone-700">
                              E-mail <span className="font-normal text-stone-500">(opcional)</span>
                              <input className={fieldClass} type="email" autoComplete="email" value={clinicClientEdit.email} onChange={(event) => setClinicClientEdit({ ...clinicClientEdit, email: event.target.value })} maxLength={255} />
                            </label>
                            <label className="block text-sm font-medium text-stone-700">
                              Data de nascimento <span className="font-normal text-stone-500">(opcional)</span>
                              <input className={fieldClass} type="date" value={clinicClientEdit.dataNascimento} onChange={(event) => setClinicClientEdit({ ...clinicClientEdit, dataNascimento: event.target.value })} />
                            </label>
                            <label className="block text-sm font-medium text-stone-700">
                              Rua <span className="font-normal text-stone-500">(opcional)</span>
                              <input className={fieldClass} autoComplete="street-address" value={clinicClientEdit.rua} onChange={(event) => setClinicClientEdit({ ...clinicClientEdit, rua: event.target.value })} maxLength={255} />
                            </label>
                            <label className="block text-sm font-medium text-stone-700">
                              Bairro <span className="font-normal text-stone-500">(opcional)</span>
                              <input className={fieldClass} autoComplete="address-level3" value={clinicClientEdit.bairro} onChange={(event) => setClinicClientEdit({ ...clinicClientEdit, bairro: event.target.value })} maxLength={120} />
                            </label>
                            <label className="block text-sm font-medium text-stone-700">
                              Cidade <span className="font-normal text-stone-500">(opcional)</span>
                              <input className={fieldClass} autoComplete="address-level2" value={clinicClientEdit.cidade} onChange={(event) => setClinicClientEdit({ ...clinicClientEdit, cidade: event.target.value })} maxLength={120} />
                            </label>
                            <div className="flex flex-wrap gap-2 md:col-span-2">
                              <button className={buttonClass} disabled={busy}>{busy ? 'Salvando...' : 'Salvar alterações'}</button>
                              <button className="min-h-11 rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-700" type="button" disabled={busy} onClick={() => setEditingClinicClientId(null)}>Cancelar</button>
                            </div>
                          </form>
                        )}
                        <div
                          id={`client-history-${client.id}`}
                          className="mt-3 rounded-xl bg-stone-50 px-4 py-3"
                          hidden={expandedClientId !== client.id}
                        >
                          <p className="text-sm font-semibold text-emerald-900">
                            Histórico de consultas ({clientAppointments.length})
                          </p>
                          {clientAppointments.length === 0 ? (
                            <p className="mt-3 text-sm text-stone-600">Este cliente ainda não tem consultas registradas.</p>
                          ) : (
                            <ul className="mt-3 divide-y divide-stone-200">
                              {clientAppointments.map((appointment) => (
                                <li key={appointment.id} className="py-3 first:pt-0 last:pb-0">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <p className="font-medium text-stone-900">
                                      {procedureById.get(appointment.procedure_id)?.nome ?? 'Atendimento'} · {dentistById.get(appointment.dentist_id)?.nome ?? 'Dentista'}
                                    </p>
                                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                                      appointment.status === 'cancelado'
                                        ? 'bg-rose-100 text-rose-800'
                                        : appointment.status === 'finalizado'
                                          ? 'bg-stone-100 text-stone-700'
                                          : 'bg-emerald-100 text-emerald-900'
                                    }`}>
                                      {appointment.status === 'cancelado' ? 'Cancelada' : appointment.status === 'finalizado' ? 'Finalizada' : 'Agendada'}
                                    </span>
                                  </div>
                                  <p className="mt-1 text-sm text-stone-600">{formatDateTime(appointment.appointment_start)}</p>
                                  {guestAppointmentLinks[appointment.id] && (
                                    <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                                      <label
                                        className="block text-xs font-semibold text-emerald-950"
                                        htmlFor={`client-appointment-link-${appointment.id}`}
                                      >
                                        Link privado deste atendimento
                                      </label>
                                      <input
                                        id={`client-appointment-link-${appointment.id}`}
                                        className={`${fieldClass} bg-white`}
                                        value={guestAppointmentLinks[appointment.id]}
                                        readOnly
                                        onFocus={(event) => event.currentTarget.select()}
                                      />
                                      <div className="mt-3 flex flex-col items-start gap-3">
                                        <button
                                          className={buttonClass}
                                          type="button"
                                          onClick={() => void copyGuestAppointmentLink(appointment.id)}
                                        >
                                          Copiar link para {client.nome_completo}
                                        </button>
                                        <a
                                          className={buttonClass}
                                          href={whatsAppAppointmentUrl(appointment) ?? undefined}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                        >
                                          Enviar pelo WhatsApp
                                        </a>
                                      </div>
                                    </div>
                                  )}
                                  {appointment.status === 'agendado' && (
                                    <button
                                      className="mt-2 rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-700"
                                      type="button"
                                      disabled={busy}
                                      onClick={() => void renewGuestAppointmentLink(appointment.id)}
                                    >
                                      {guestAppointmentLinks[appointment.id] ? 'Gerar novo link privado' : 'Gerar link privado'}
                                    </button>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
            )}
          </div>
        </section>
      ) : activeTab === 'agendar' || activeTab === 'consultas' ? (
        <section className="mt-8 space-y-6">
          {activeTab === 'agendar' && (
          <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:p-7">
            <SectionHeading eyebrow="Novo atendimento" title="Agendar para o cliente e gerar link privado" />
            {activeDentists.length === 0 || activeProcedures.length === 0 ? (
              <div>
                <EmptyState title="Prepare a agenda da clínica" text="Antes de agendar, cadastre pelo menos um dentista e um procedimento em Configurações." />
                <button className={`${buttonClass} mt-4 w-full sm:w-auto`} type="button" onClick={() => setActiveTab('configuracoes')}>Abrir configurações</button>
              </div>
            ) : (
              <form className="mt-6 grid gap-4 md:grid-cols-2" onSubmit={createGuestAppointment}>
                <label className="block text-sm font-medium text-stone-700">
                  Cliente cadastrado
                  <select className={fieldClass} value={newGuestAppointment.clinicClientId} onChange={(event) => setNewGuestAppointment({ ...newGuestAppointment, clinicClientId: event.target.value })} required>
                    <option value="">Selecione um cliente</option>
                    {clinicClients.map((client) => <option key={client.id} value={client.id}>{client.nome_completo} · {client.whatsapp}</option>)}
                  </select>
                  {clinicClients.length === 0 && (
                    <button
                      className="mt-2 text-sm font-semibold text-emerald-800 underline"
                      type="button"
                      onClick={() => {
                        setActiveTab('clientes')
                      }}
                    >
                      Cadastrar cliente
                    </button>
                  )}
                </label>
                <label className="block text-sm font-medium text-stone-700">
                  Procedimento
                  <select className={fieldClass} value={newGuestAppointment.procedureId} onChange={(event) => setNewGuestAppointment({ ...newGuestAppointment, procedureId: event.target.value })} required>
                    <option value="">Selecione um procedimento</option>
                    {activeProcedures.map((procedure) => (
                      <option key={procedure.id} value={procedure.id}>
                        {procedure.nome} · {procedure.duracao_minutos} min
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-medium text-stone-700">
                  Dentista
                  <select className={fieldClass} value={newGuestAppointment.dentistId} onChange={(event) => setNewGuestAppointment({ ...newGuestAppointment, dentistId: event.target.value })} required>
                    <option value="">Selecione um dentista</option>
                    {activeDentists.map((dentist) => <option key={dentist.id} value={dentist.id}>{dentist.nome} · {dentist.especialidade}</option>)}
                  </select>
                </label>
                <label className="block text-sm font-medium text-stone-700 md:col-span-2">
                  Data e horário
                  <input className={fieldClass} type="datetime-local" value={newGuestAppointment.appointmentStart} onChange={(event) => setNewGuestAppointment({ ...newGuestAppointment, appointmentStart: event.target.value })} required />
                </label>
                <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-950 md:col-span-2">
                  O cliente não precisa criar usuário, senha ou instalar um aplicativo. Depois de agendar, envie o link privado para ele consultar esta consulta.
                </p>
                <button className={`${buttonClass} md:col-span-2`} disabled={busy}>
                  {busy ? 'Agendando...' : 'Agendar e gerar link privado'}
                </button>
              </form>
            )}
          </div>
          )}
          {activeTab === 'consultas' && (
          <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:p-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SectionHeading
                eyebrow="Consultas da clínica"
                title={appointmentListMode === 'upcoming'
                  ? `Próximas consultas (${displayedAppointments.length})`
                  : `Histórico de consultas (${displayedAppointments.length})`}
              />
              <button
                className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-700"
                type="button"
                onClick={() => setActiveTab('visao-geral')}
              >
                Voltar à visão geral
              </button>
            </div>
            {displayedAppointments.length === 0 ? (
              <EmptyState
                title={appointmentListMode === 'upcoming' ? 'Nenhuma consulta futura' : 'Nenhum atendimento no histórico'}
                text={appointmentListMode === 'upcoming' ? 'As próximas consultas aparecerão aqui.' : 'Atendimentos anteriores, realizados ou cancelados aparecerão aqui.'}
              />
            ) : (
              <ul className="mt-5 divide-y divide-stone-100">
                {displayedAppointments.map((guestAppointment) => {
                  const appointmentStarted = new Date(guestAppointment.appointment_start).getTime() <= now
                  const appointmentEnded = new Date(guestAppointment.appointment_end).getTime() <= now
                  return (
                  <li key={guestAppointment.id} className="grid min-w-0 gap-3 py-4 first:pt-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                    <div>
                      <p className="font-semibold text-stone-900">{guestAppointment.patient_name}</p>
                      <p className="mt-1 text-sm text-stone-600">{guestAppointment.patient_whatsapp}</p>
                      <p className="mt-1 text-sm text-stone-600">
                        {procedureById.get(guestAppointment.procedure_id)?.nome ?? 'Atendimento'} · {dentistById.get(guestAppointment.dentist_id)?.nome ?? 'Dentista'}
                      </p>
                      <p className="mt-1 text-sm text-stone-700">{formatDateTime(guestAppointment.appointment_start)}</p>
                      <span className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                        guestAppointment.status === 'finalizado'
                          ? 'bg-stone-100 text-stone-700'
                          : guestAppointment.status === 'cancelado'
                            ? 'bg-rose-100 text-rose-800'
                            : appointmentEnded
                              ? 'bg-amber-100 text-amber-900'
                              : appointmentStarted ? 'bg-sky-100 text-sky-900' : 'bg-emerald-100 text-emerald-900'
                      }`}>
                        {guestAppointment.status === 'finalizado'
                          ? 'Realizado'
                          : guestAppointment.status === 'cancelado'
                            ? 'Cancelado'
                            : appointmentEnded
                              ? 'Aguardando registro de realização'
                              : appointmentStarted ? 'Em atendimento' : 'Agendado'}
                      </span>
                      {guestAppointment.status === 'agendado' && appointmentEnded && (
                        <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium leading-5 text-amber-950">
                          O horário previsto já terminou. Registre se o atendimento foi realizado e informe o pagamento.
                        </p>
                      )}
                      {guestAppointment.status === 'agendado' && appointmentStarted && !appointmentEnded && (
                        <p className="mt-2 text-sm text-sky-800">
                          Atendimento em curso. Após terminar, registre a realização e o pagamento.
                        </p>
                      )}
                      {guestAppointment.status === 'finalizado' && guestAppointment.payment_method && guestAppointment.payment_amount !== null && (
                        <p className="mt-2 text-sm font-medium text-stone-700">
                          Recebido: {formatCurrency(guestAppointment.payment_amount)} · {guestAppointment.payment_method === 'dinheiro' ? 'Dinheiro' : guestAppointment.payment_method === 'cartao' ? 'Cartão' : 'Pix'}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 sm:justify-end">
                      {guestAppointment.status === 'agendado' && (
                        <button
                          className={`rounded-xl border px-4 py-2.5 text-sm font-semibold ${
                            appointmentEnded
                              ? 'border-emerald-700 text-emerald-900'
                              : 'border-stone-300 text-stone-500'
                          }`}
                          type="button"
                          disabled={busy || !appointmentEnded}
                          onClick={() => {
                            setRescheduleForm(null)
                            setPaymentForm({
                              appointmentId: guestAppointment.id,
                              method: '',
                              amount: (procedureById.get(guestAppointment.procedure_id)?.preco_base ?? 0).toFixed(2),
                            })
                          }}
                        >
                          {appointmentEnded
                            ? 'Marcar como realizado e registrar pagamento'
                            : 'Marcar realizado após o horário previsto'}
                        </button>
                      )}
                      {guestAppointment.status === 'agendado' && (
                        <button
                          className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-700"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setPaymentForm(null)
                            setError('')
                            setRescheduleForm({
                              appointmentId: guestAppointment.id,
                              appointmentStart: isoToLocalDateTimeInput(guestAppointment.appointment_start),
                            })
                          }}
                        >
                          Alterar dia e horário
                        </button>
                      )}
                      {guestAppointment.status === 'agendado' && (
                        <button className="rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-700" type="button" disabled={busy} onClick={() => void renewGuestAppointmentLink(guestAppointment.id)}>
                          Gerar novo link
                        </button>
                      )}
                      {guestAppointment.status === 'agendado' && (
                        <button
                          className="rounded-xl border border-rose-300 px-4 py-2.5 text-sm font-semibold text-rose-800"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setPaymentForm(null)
                            setRescheduleForm(null)
                            setCancelAppointmentId((current) => {
                              const nextId = current === guestAppointment.id ? null : guestAppointment.id
                              setCancelConfirmed(false)
                              return nextId
                            })
                          }}
                        >
                          Registrar desistência
                        </button>
                      )}
                    </div>
                    {cancelAppointmentId === guestAppointment.id && (
                      <div className="w-full min-w-0 rounded-2xl border border-rose-200 bg-rose-50 p-4 sm:col-span-full">
                        <p className="text-sm leading-6 text-rose-950">
                          Confirmar que o cliente desistiu? A consulta será cancelada, o horário ficará disponível e o link privado deixará de funcionar.
                        </p>
                        <label className="mt-3 flex items-start gap-3 text-sm leading-5 text-rose-950">
                          <input
                            className="mt-1 size-4 shrink-0 accent-rose-700"
                            type="checkbox"
                            checked={cancelConfirmed}
                            onChange={(event) => setCancelConfirmed(event.target.checked)}
                          />
                          Entendi que esta ação cancela a consulta e libera o horário.
                        </label>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-rose-700 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-55"
                            type="button"
                            disabled={busy || !cancelConfirmed}
                            onClick={() => void cancelGuestAppointment(guestAppointment.id)}
                          >
                            {busy ? 'Registrando...' : 'Confirmar desistência'}
                          </button>
                          <button
                            className="min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold text-stone-700"
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setCancelAppointmentId(null)
                              setCancelConfirmed(false)
                            }}
                          >
                            Voltar
                          </button>
                        </div>
                      </div>
                    )}
                    {guestAppointmentLinks[guestAppointment.id] && (
                      <div className="w-full min-w-0 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 sm:col-span-full">
                        <label className="block text-sm font-semibold text-emerald-950" htmlFor={`guest-appointment-link-${guestAppointment.id}`}>
                          Link privado de {guestAppointment.patient_name}
                        </label>
                        <input
                          id={`guest-appointment-link-${guestAppointment.id}`}
                          className={`${fieldClass} bg-white`}
                          value={guestAppointmentLinks[guestAppointment.id]}
                          readOnly
                          onFocus={(event) => event.currentTarget.select()}
                        />
                        <div className="mt-3 flex flex-col items-start gap-3">
                          <button
                            className={`${buttonClass} w-full sm:w-auto`}
                            type="button"
                            onClick={() => void copyGuestAppointmentLink(guestAppointment.id)}
                          >
                            Copiar link deste atendimento
                          </button>
                          <a
                            className={`${buttonClass} w-full sm:w-auto`}
                            href={whatsAppAppointmentUrl(guestAppointment) ?? undefined}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Enviar pelo WhatsApp
                          </a>
                        </div>
                      </div>
                    )}
                    {rescheduleForm?.appointmentId === guestAppointment.id && (
                      <form
                        className="grid w-full min-w-0 gap-3 rounded-2xl bg-stone-50 p-4 sm:col-span-full sm:grid-cols-[1fr_auto]"
                        onSubmit={(event) => void rescheduleGuestAppointment(event, guestAppointment.id)}
                      >
                        <label className="block text-sm font-medium text-stone-700">
                          Nova data e horário
                          <input
                            className={fieldClass}
                            type="datetime-local"
                            min={isoToLocalDateTimeInput(new Date(now + 60_000).toISOString())}
                            value={rescheduleForm.appointmentStart}
                            onChange={(event) => setRescheduleForm({ ...rescheduleForm, appointmentStart: event.target.value })}
                            required
                          />
                        </label>
                        <div className="flex items-end gap-2">
                          <button className={buttonClass} disabled={busy}>{busy ? 'Remarcando...' : 'Salvar novo horário'}</button>
                          <button className="min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold text-stone-700" type="button" disabled={busy} onClick={() => setRescheduleForm(null)}>Cancelar</button>
                        </div>
                      </form>
                    )}
                    {paymentForm?.appointmentId === guestAppointment.id && (
                      <form
                        className="grid w-full min-w-0 gap-3 rounded-2xl bg-emerald-50 p-4 sm:col-span-full sm:grid-cols-[1fr_1fr_auto]"
                        onSubmit={(event) => {
                          event.preventDefault()
                          void finishGuestAppointment(guestAppointment.id)
                        }}
                      >
                        <label className="block text-sm font-medium text-stone-700">
                          Valor recebido (R$)
                          <input
                            className={fieldClass}
                            type="number"
                            min="0"
                            max="9999999999.99"
                            step="0.01"
                            value={paymentForm.amount}
                            onChange={(event) => setPaymentForm({ ...paymentForm, amount: event.target.value })}
                            required
                          />
                        </label>
                        <label className="block text-sm font-medium text-stone-700">
                          Forma de pagamento
                          <select
                            className={fieldClass}
                            value={paymentForm.method}
                            onChange={(event) => setPaymentForm({ ...paymentForm, method: event.target.value as PaymentMethod | '' })}
                            required
                          >
                            <option value="">Selecione</option>
                            <option value="dinheiro">Dinheiro</option>
                            <option value="cartao">Cartão</option>
                            <option value="pix">Pix</option>
                          </select>
                        </label>
                        <div className="flex items-end gap-2">
                          <button className={buttonClass} disabled={busy}>{busy ? 'Salvando...' : 'Confirmar'}</button>
                          <button className="min-h-11 rounded-xl border border-stone-300 px-4 text-sm font-semibold text-stone-700" type="button" disabled={busy} onClick={() => setPaymentForm(null)}>Cancelar</button>
                        </div>
                      </form>
                    )}
                  </li>
                  )
                })}
              </ul>
            )}
          </div>
          )}
        </section>
      ) : activeTab === 'clientes' ? (
        <section className="mt-8 space-y-6">
          <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:p-7">
            <SectionHeading eyebrow="Cadastro de cliente" title="Cadastrar cliente" />
            <form className="mt-5 grid gap-4 md:grid-cols-2" onSubmit={registerClinicClient}>
              <label className="block text-sm font-medium text-stone-700">
                Nome completo
                <input className={fieldClass} value={newClinicClient.nomeCompleto} onChange={(event) => setNewClinicClient({ ...newClinicClient, nomeCompleto: event.target.value })} required maxLength={255} />
              </label>
              <label className="block text-sm font-medium text-stone-700">
                WhatsApp
                <input className={fieldClass} type="tel" autoComplete="tel" value={newClinicClient.whatsapp} onChange={(event) => setNewClinicClient({ ...newClinicClient, whatsapp: event.target.value })} required maxLength={20} placeholder="+55 11 99999-9999" />
              </label>
              <label className="block text-sm font-medium text-stone-700">
                E-mail <span className="font-normal text-stone-500">(opcional)</span>
                <input className={fieldClass} type="email" autoComplete="email" value={newClinicClient.email} onChange={(event) => setNewClinicClient({ ...newClinicClient, email: event.target.value })} maxLength={255} />
              </label>
              <label className="block text-sm font-medium text-stone-700">
                Data de nascimento <span className="font-normal text-stone-500">(opcional)</span>
                <input className={fieldClass} type="date" value={newClinicClient.dataNascimento} onChange={(event) => setNewClinicClient({ ...newClinicClient, dataNascimento: event.target.value })} />
              </label>
              <label className="block text-sm font-medium text-stone-700">
                Rua <span className="font-normal text-stone-500">(opcional)</span>
                <input className={fieldClass} autoComplete="street-address" value={newClinicClient.rua} onChange={(event) => setNewClinicClient({ ...newClinicClient, rua: event.target.value })} maxLength={255} />
              </label>
              <label className="block text-sm font-medium text-stone-700">
                Bairro <span className="font-normal text-stone-500">(opcional)</span>
                <input className={fieldClass} autoComplete="address-level3" value={newClinicClient.bairro} onChange={(event) => setNewClinicClient({ ...newClinicClient, bairro: event.target.value })} maxLength={120} />
              </label>
              <label className="block text-sm font-medium text-stone-700">
                Cidade <span className="font-normal text-stone-500">(opcional)</span>
                <input className={fieldClass} autoComplete="address-level2" value={newClinicClient.cidade} onChange={(event) => setNewClinicClient({ ...newClinicClient, cidade: event.target.value })} maxLength={120} />
              </label>
              <button className={`${buttonClass} md:col-span-2`} disabled={busy}>{busy ? 'Cadastrando...' : 'Cadastrar cliente'}</button>
            </form>
          </div>
        </section>
      ) : activeTab === 'relatorios' ? (
        <section className="mt-8 space-y-6">
          <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:p-7">
            <SectionHeading eyebrow="Período do relatório" title="Recebimentos da clínica" />
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="block text-sm font-medium text-stone-700">
                Data inicial
                <input className={fieldClass} type="date" value={reportStartDate} max={reportEndDate} onChange={(event) => setReportStartDate(event.target.value)} />
              </label>
              <label className="block text-sm font-medium text-stone-700">
                Data final
                <input className={fieldClass} type="date" value={reportEndDate} min={reportStartDate} onChange={(event) => setReportEndDate(event.target.value)} />
              </label>
            </div>
            <button
              className="mt-4 rounded-xl border border-stone-300 px-4 py-2.5 text-sm font-semibold text-stone-700"
              type="button"
              onClick={() => {
                const today = localToday()
                setReportStartDate(today)
                setReportEndDate(today)
              }}
            >
              Ver somente hoje
            </button>
          </div>
          {!reportRangeValid || !paymentReport ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="alert">
              Informe um intervalo de datas válido. A data inicial deve ser anterior ou igual à data final.
            </p>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
                  <p className="text-sm font-medium text-stone-600">Total recebido</p>
                  <p className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">{formatCurrency(paymentReport.totalCents / 100)}</p>
                  <p className="mt-1 text-sm text-stone-500">{paymentReport.totalCount} {paymentReport.totalCount === 1 ? 'atendimento pago' : 'atendimentos pagos'}</p>
                </div>
                <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
                  <p className="text-sm font-medium text-stone-600">Consultas realizadas</p>
                  <p className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">{completedAppointmentCount ?? 0}</p>
                  <p className="mt-1 text-sm text-stone-500">{completedAppointmentCount === 1 ? 'consulta no período' : 'consultas no período'}</p>
                </div>
                {paymentMethods.map((method) => {
                  const summary = paymentReport.byMethod[method]
                  const label = method === 'dinheiro' ? 'Dinheiro' : method === 'cartao' ? 'Cartão' : 'Pix'
                  return (
                    <div key={method} className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
                      <p className="text-sm font-medium text-stone-600">{label}</p>
                      <p className="mt-2 text-2xl font-semibold tracking-tight text-stone-900">{formatCurrency(summary.cents / 100)}</p>
                      <p className="mt-1 text-sm text-stone-500">{summary.count} {summary.count === 1 ? 'pagamento' : 'pagamentos'}</p>
                    </div>
                  )
                })}
              </div>
              <p className="text-sm leading-6 text-stone-500">
                As consultas são contadas pela data do atendimento; os recebimentos consideram a data do pagamento.
              </p>
              {paymentReport.records.length === 0 ? (
                <EmptyState title="Nenhum recebimento no período" text="Atendimentos finalizados com pagamento registrado aparecerão aqui." />
              ) : (
                <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:p-7">
                  <SectionHeading eyebrow="Detalhamento" title="Atendimentos recebidos" />
                  <ul className="mt-4 divide-y divide-stone-100">
                    {paymentReport.records
                      .slice()
                      .sort((left, right) => (right.paid_at ?? '').localeCompare(left.paid_at ?? ''))
                      .map((appointment) => (
                        <li key={appointment.id} className="flex flex-col justify-between gap-1 py-3 sm:flex-row sm:items-center">
                          <div>
                            <p className="font-medium text-stone-900">{appointment.patient_name}</p>
                            <p className="text-sm text-stone-600">{formatDateTime(appointment.paid_at ?? '')}</p>
                          </div>
                          <p className="font-semibold text-stone-900">
                            {formatCurrency(appointment.payment_amount ?? 0)} · {appointment.payment_method === 'dinheiro' ? 'Dinheiro' : appointment.payment_method === 'cartao' ? 'Cartão' : 'Pix'}
                          </p>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>
      ) : (
        <section className="mt-8 space-y-6">
          <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:p-7">
            <SectionHeading eyebrow="Configuração inicial" title="Equipe e agenda" />
            <p className="mt-2 text-sm leading-6 text-stone-600">
              Cadastre dentistas, procedimentos e bloqueios. Essas informações aparecem nas opções de agendamento.
            </p>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:p-7">
              <SectionHeading eyebrow="Equipe" title="Dentistas" />
              <p className="mt-2 text-sm leading-6 text-stone-600">Cadastre quantos dentistas forem necessários. Cada cadastro é adicionado à lista abaixo, sem limite definido pelo aplicativo.</p>
              <form className="mt-5 grid gap-3 sm:grid-cols-2" onSubmit={addDentist}>
                <input className={fieldClass} aria-label="Nome do dentista" placeholder="Nome completo" value={newDentist.nome} onChange={(event) => setNewDentist({ ...newDentist, nome: event.target.value })} required maxLength={255} />
                <input className={fieldClass} aria-label="CRO" placeholder="CRO" value={newDentist.cro} onChange={(event) => setNewDentist({ ...newDentist, cro: event.target.value })} required maxLength={50} />
                <input className={`${fieldClass} sm:col-span-2`} aria-label="Especialidade" placeholder="Especialidade" value={newDentist.especialidade} onChange={(event) => setNewDentist({ ...newDentist, especialidade: event.target.value })} required maxLength={100} />
                <button className={`${buttonClass} sm:col-span-2`} disabled={busy}>Cadastrar dentista</button>
              </form>
              <ul className="mt-5 divide-y divide-stone-100">
                {dentists.map((dentist) => (
                  <li key={dentist.id} className="py-4">
                    <form className="grid gap-2 sm:grid-cols-3" onSubmit={(event) => void updateDentist(event, dentist.id)}>
                      <input className={fieldClass} aria-label={`Nome de ${dentist.nome}`} name="nome" defaultValue={dentist.nome} required maxLength={255} />
                      <input className={fieldClass} aria-label={`CRO de ${dentist.nome}`} name="cro" defaultValue={dentist.cro} required maxLength={50} />
                      <input className={fieldClass} aria-label={`Especialidade de ${dentist.nome}`} name="especialidade" defaultValue={dentist.especialidade} required maxLength={100} />
                      <div className="flex gap-2 sm:col-span-3">
                        <button className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-700" type="submit" disabled={busy}>Salvar</button>
                        <button className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-700" type="button" disabled={busy} onClick={() => void toggleDentist(dentist)}>{dentist.ativo ? 'Desativar' : 'Ativar'}</button>
                      </div>
                    </form>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:p-7">
              <SectionHeading eyebrow="Atendimentos" title="Procedimentos" />
              <form className="mt-5 space-y-3" onSubmit={addProcedure}>
                <input className={fieldClass} aria-label="Nome do procedimento" placeholder="Nome do procedimento" value={newProcedure.nome} onChange={(event) => setNewProcedure({ ...newProcedure, nome: event.target.value })} required maxLength={100} />
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs font-medium text-stone-600">Duração (min)
                    <input className={fieldClass} type="number" min="1" step="1" value={newProcedure.duracao} onChange={(event) => setNewProcedure({ ...newProcedure, duracao: event.target.value })} required />
                  </label>
                  <label className="text-xs font-medium text-stone-600">Preço base (R$)
                    <input className={fieldClass} type="number" min="0" step="0.01" value={newProcedure.preco} onChange={(event) => setNewProcedure({ ...newProcedure, preco: event.target.value })} required />
                  </label>
                </div>
                <button className={`${buttonClass} w-full`} disabled={busy}>Cadastrar procedimento</button>
              </form>
              <ul className="mt-5 divide-y divide-stone-100">
                {procedures.map((procedure) => (
                  <li key={procedure.id} className="py-4">
                    <form className="grid gap-2 sm:grid-cols-[1fr_120px_140px]" onSubmit={(event) => void updateProcedure(event, procedure.id)}>
                      <input className={fieldClass} aria-label={`Nome de ${procedure.nome}`} name="nome" defaultValue={procedure.nome} required maxLength={100} />
                      <input className={fieldClass} aria-label={`Duração de ${procedure.nome}`} name="duracao" type="number" min="1" step="1" defaultValue={procedure.duracao_minutos} required />
                      <input className={fieldClass} aria-label={`Preço de ${procedure.nome}`} name="preco" type="number" min="0" step="0.01" defaultValue={procedure.preco_base} required />
                      <div className="flex gap-2 sm:col-span-3">
                        <button className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-700" type="submit" disabled={busy}>Salvar</button>
                        <button className="rounded-lg border border-stone-300 px-3 py-2 text-xs font-semibold text-stone-700" type="button" disabled={busy} onClick={() => void toggleProcedure(procedure)}>{procedure.ativo ? 'Desativar' : 'Ativar'}</button>
                      </div>
                    </form>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm sm:p-7">
            <SectionHeading eyebrow="Indisponibilidade" title="Bloqueios de agenda" />
            <form className="mt-5 grid gap-3 md:grid-cols-2" onSubmit={addScheduleBlock}>
              <label className="block text-sm font-medium text-stone-700 md:col-span-2">Aplicar a
                <select className={fieldClass} value={newBlock.dentistaId} onChange={(event) => setNewBlock({ ...newBlock, dentistaId: event.target.value })}>
                  <option value="">Toda a clínica</option>
                  {activeDentists.map((dentist) => <option key={dentist.id} value={dentist.id}>{dentist.nome}</option>)}
                </select>
              </label>
              <label className="block text-sm font-medium text-stone-700">Início
                <input className={fieldClass} type="datetime-local" value={newBlock.inicio} onChange={(event) => setNewBlock({ ...newBlock, inicio: event.target.value })} required />
              </label>
              <label className="block text-sm font-medium text-stone-700">Fim
                <input className={fieldClass} type="datetime-local" value={newBlock.fim} onChange={(event) => setNewBlock({ ...newBlock, fim: event.target.value })} required />
              </label>
              <label className="block text-sm font-medium text-stone-700 md:col-span-2">Motivo
                <input className={fieldClass} value={newBlock.motivo} onChange={(event) => setNewBlock({ ...newBlock, motivo: event.target.value })} required maxLength={255} placeholder="Ex.: feriado, almoço ou manutenção" />
              </label>
              <button className={`${buttonClass} md:col-span-2`} disabled={busy}>Criar bloqueio</button>
            </form>
            {blocks.length === 0 ? <EmptyState title="Nenhum bloqueio cadastrado" text="Os bloqueios ativos aparecerão nesta lista." /> : (
              <ul className="mt-5 divide-y divide-stone-100">
                {blocks.map((block) => (
                  <li key={block.id} className="flex flex-col justify-between gap-3 py-4 sm:flex-row sm:items-center">
                    <div>
                      <p className="font-medium text-stone-900">{block.motivo}</p>
                      <p className="text-sm text-stone-600">{block.dentista_id ? dentistById.get(block.dentista_id)?.nome ?? 'Dentista' : 'Toda a clínica'} · {formatDateTime(block.data_hora_inicio)} – {formatDateTime(block.data_hora_fim)}</p>
                    </div>
                    <button className="rounded-lg border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-700" disabled={busy} onClick={() => void removeScheduleBlock(block.id)}>Remover</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
      <p className="mt-8 text-center text-xs leading-5 text-stone-500">Seus dados são protegidos e utilizados para organizar seu atendimento.</p>
      </main>
    </div>
  )
}

export function SupabaseSetupNotice() {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <section className="w-full max-w-xl rounded-3xl border border-stone-200 bg-white p-7 shadow-sm sm:p-10">
        <Brand />
        <div className="mt-8">
          <p className="text-sm font-semibold uppercase tracking-[.15em] text-emerald-800">Configuração necessária</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">Conecte o Supabase</h1>
          <p className="mt-3 leading-7 text-stone-600">
            Para habilitar o acesso e os agendamentos, configure as variáveis de ambiente da aplicação.
          </p>
          <ol className="mt-5 list-inside list-decimal space-y-2 rounded-2xl bg-stone-50 p-4 text-sm text-stone-700">
            <li>Copie <code>.env.example</code> para <code>.env.local</code>.</li>
            <li>Informe <code>VITE_SUPABASE_URL</code> e <code>VITE_SUPABASE_ANON_KEY</code> do seu projeto.</li>
            <li>Execute as migrations em <code>supabase/migrations/</code>.</li>
            <li>Reinicie o servidor de desenvolvimento.</li>
          </ol>
          <p className="mt-4 text-xs leading-5 text-stone-500">
            Nunca use a chave <code>service_role</code> no navegador. Ela ignora as políticas de segurança do banco.
          </p>
        </div>
      </section>
    </main>
  )
}

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-11 place-items-center rounded-2xl bg-emerald-800 text-lg font-bold text-white" aria-hidden="true">O</span>
      <span><span className="block text-base font-bold tracking-tight text-stone-900">Odonto</span><span className="block text-xs text-stone-500">Agendamento simples</span></span>
    </div>
  )
}

export function ClinicWelcomeScreen({ onEnter }: { onEnter: () => void }) {
  const [imageError, setImageError] = useState(false)

  return (
    <main className="fixed inset-0 grid h-dvh w-screen place-items-center overflow-hidden bg-stone-950">
      {imageError ? (
        <div className="relative z-10 px-6 text-center text-white">
          <p className="text-lg font-semibold" role="alert">Não foi possível carregar a imagem da clínica.</p>
          <p className="mt-2 text-sm text-white/80">Adicione sua imagem licenciada como <code>public/clinic-welcome.png</code>.</p>
        </div>
      ) : (
        <img
          className="absolute inset-0 z-0 h-full w-full object-cover"
          src="/clinic-welcome.png"
          alt="Imagem da clínica"
          onError={() => setImageError(true)}
        />
      )}
      {!imageError && <div className="absolute inset-0 z-0 bg-black/25" aria-hidden="true" />}
      <div className="absolute inset-0 z-10 grid place-items-center px-6 py-8 text-center">
        <div className="w-full max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-[.15em] text-white/90">Área da clínica</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">Bem-vindo à clínica</h1>
          <button
            className="mt-6 inline-flex min-h-12 items-center justify-center rounded-xl bg-white px-6 py-3 text-sm font-semibold text-emerald-950 shadow-lg transition hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-emerald-900"
            type="button"
            onClick={onEnter}
          >
            Acessar sistema
          </button>
        </div>
      </div>
    </main>
  )
}

function LoadingScreen({ label }: { label: string }) {
  return <main className="grid min-h-screen place-items-center text-sm text-stone-600">{label}</main>
}

function Feedback({ error, notice }: { error: string; notice: string }) {
  if (!error && !notice) return null
  return (
    <div className="mt-5 space-y-2" aria-live="polite">
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-900">{error}</p>}
      {notice && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-900">{notice}</p>}
    </div>
  )
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <div><p className="text-xs font-bold uppercase tracking-[.15em] text-emerald-800">{eyebrow}</p><h2 className="mt-1 text-xl font-semibold tracking-tight text-stone-900">{title}</h2></div>
}

function SummaryCard({ label, value, detail, onClick }: { label: string; value: number; detail: string; onClick?: () => void }) {
  const content = (
    <>
      <p className="text-sm font-medium text-stone-600">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">{value}</p>
      <p className="mt-1 text-sm text-stone-500">{detail}</p>
    </>
  )
  const className = 'rounded-3xl border border-stone-200 bg-white p-5 text-left shadow-sm sm:p-6'

  return onClick ? (
    <button className={`${className} w-full transition hover:border-emerald-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700`} type="button" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  )
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="mt-5 rounded-2xl border border-dashed border-stone-300 bg-stone-50 px-4 py-6 text-center"><p className="font-semibold text-stone-800">{title}</p><p className="mt-1 text-sm leading-6 text-stone-600">{text}</p></div>
}

function TabButton({ active, onClick, children, className = '' }: { active: boolean; onClick: () => void; children: string; className?: string }) {
  return <button className={`min-w-0 rounded-lg px-2 py-2 text-center text-xs font-semibold leading-tight transition lg:px-3 lg:text-sm ${active ? 'bg-emerald-800 text-white' : 'text-stone-600 hover:bg-stone-100'} ${className}`} onClick={onClick}>{children}</button>
}

function App() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('consulta')
  return token ? <GuestAppointmentPage token={token} /> : <AuthenticatedApp />
}

function GuestAppointmentPage({ token }: { token: string }) {
  const [appointment, setAppointment] = useState<GuestAppointmentDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let isCurrent = true
    async function loadAppointment() {
      if (!supabase) {
        setError('O acesso à consulta não está configurado. Entre em contato com a clínica.')
        setLoading(false)
        return
      }
      try {
        const tokenHash = await hashAppointmentLinkSecret(token)
        const { data, error: loadError } = await supabase.rpc('get_guest_appointment', {
          p_access_token_hash: tokenHash,
        })
        if (loadError) throw loadError
        if (!data?.[0]) throw new Error('Este link é inválido ou não está mais disponível. Peça um novo link à clínica.')
        if (isCurrent) setAppointment(data[0])
      } catch (loadError) {
        if (isCurrent) {
          setError(
            errorCode(loadError) === 'PGRST202'
              ? 'O acesso por link ainda não foi ativado no Supabase. Peça à clínica para concluir a configuração.'
              : errorMessage(loadError),
          )
        }
      } finally {
        if (isCurrent) setLoading(false)
      }
    }
    void loadAppointment()
    return () => {
      isCurrent = false
    }
  }, [token])

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <section className="w-full max-w-lg rounded-3xl border border-stone-200 bg-white p-6 shadow-sm sm:p-9">
        <Brand />
        {loading ? (
          <p className="mt-8 text-stone-600" role="status">Carregando os detalhes do atendimento...</p>
        ) : error ? (
          <>
            <h1 className="mt-8 text-2xl font-semibold text-stone-900">Não foi possível acessar o atendimento</h1>
            <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-900" role="alert">{error}</p>
            <p className="mt-4 text-sm leading-6 text-stone-600">Peça à clínica para conferir o agendamento ou gerar um novo link privado.</p>
          </>
        ) : appointment ? (
          <>
            <p className="mt-8 text-sm font-semibold uppercase tracking-[.15em] text-emerald-800">Acesso privado</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-stone-900">Detalhes da sua consulta</h1>
            <p className="mt-2 text-stone-600">Olá, {appointment.patient_name}. Confira as informações do atendimento agendado pela clínica.</p>
            <dl className="mt-6 divide-y divide-stone-100 rounded-2xl border border-stone-200 px-4">
              <div className="py-4">
                <dt className="text-xs font-semibold uppercase tracking-wide text-stone-500">Procedimento</dt>
                <dd className="mt-1 font-semibold text-stone-900">{appointment.procedure_name}</dd>
              </div>
              <div className="py-4">
                <dt className="text-xs font-semibold uppercase tracking-wide text-stone-500">Dentista</dt>
                <dd className="mt-1 font-semibold text-stone-900">{appointment.dentist_name}</dd>
              </div>
              <div className="py-4">
                <dt className="text-xs font-semibold uppercase tracking-wide text-stone-500">Data e horário</dt>
                <dd className="mt-1 font-semibold text-stone-900">{formatDateTime(appointment.appointment_start)}</dd>
              </div>
            </dl>
            <p className="mt-5 rounded-xl bg-stone-50 px-4 py-3 text-sm leading-6 text-stone-600">
              Esta página é somente para visualização e mostra apenas este atendimento. Guarde o link com cuidado; quem tiver acesso a ele poderá ver estes detalhes. Para dúvidas ou alterações, fale diretamente com a clínica.
            </p>
          </>
        ) : null}
      </section>
    </main>
  )
}

export default App
