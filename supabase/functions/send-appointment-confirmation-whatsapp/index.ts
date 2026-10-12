import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function requiredSetting(name: string) {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`Missing function secret: ${name}`)
  return value
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { message: 'Method not allowed.' })
  }

  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) {
    return jsonResponse(401, { message: 'Authentication required.' })
  }

  let appointmentId: string
  try {
    const body: unknown = await request.json()
    if (
      typeof body !== 'object' ||
      body === null ||
      !('appointmentId' in body) ||
      typeof body.appointmentId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.appointmentId)
    ) {
      return jsonResponse(400, { message: 'A valid appointmentId is required.' })
    }
    appointmentId = body.appointmentId
  } catch {
    return jsonResponse(400, { message: 'Invalid JSON body.' })
  }

  try {
    const supabaseUrl = requiredSetting('SUPABASE_URL')
    const anonKey = requiredSetting('SUPABASE_ANON_KEY')
    const serviceRoleKey = requiredSetting('SUPABASE_SERVICE_ROLE_KEY')
    const graphVersion = requiredSetting('META_GRAPH_API_VERSION')
    const phoneNumberId = requiredSetting('WHATSAPP_PHONE_NUMBER_ID')
    const accessToken = requiredSetting('WHATSAPP_ACCESS_TOKEN')
    const templateName = requiredSetting('WHATSAPP_TEMPLATE_NAME')
    const templateLanguage = Deno.env.get('WHATSAPP_TEMPLATE_LANGUAGE') ?? 'pt_BR'

    if (!/^v\d+\.\d+$/.test(graphVersion)) {
      return jsonResponse(500, { message: 'Invalid META_GRAPH_API_VERSION function secret.' })
    }

    const token = authorization.slice('Bearer '.length)
    const caller = createClient(supabaseUrl, anonKey, {
      db: { schema: 'odonto' },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: userData, error: userError } = await caller.auth.getUser(token)
    if (userError || !userData.user) {
      return jsonResponse(401, { message: 'Invalid or expired session.' })
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      db: { schema: 'odonto' },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: staff, error: staffError } = await admin
      .from('clinic_staff')
      .select('user_id')
      .eq('user_id', userData.user.id)
      .maybeSingle()
    if (staffError) {
      console.error('Could not verify clinic staff authorization.')
      return jsonResponse(500, { message: 'Could not verify clinic staff authorization.' })
    }
    if (!staff) return jsonResponse(403, { message: 'Clinic staff access required.' })

    const { data: appointment, error: appointmentError } = await admin
      .from('agendamentos')
      .select('status')
      .eq('id', appointmentId)
      .maybeSingle()
    if (appointmentError) {
      console.error('Could not load appointment status.')
      return jsonResponse(500, { message: 'Could not load appointment.' })
    }
    if (!appointment || appointment.status !== 'confirmado') {
      return jsonResponse(409, { message: 'Only confirmed appointments can send WhatsApp notifications.' })
    }

    const { data: existing, error: existingError } = await admin
      .from('appointment_confirmation_outbox')
      .select('status,last_attempt_at')
      .eq('appointment_id', appointmentId)
      .maybeSingle()
    if (existingError) {
      console.error('Could not load WhatsApp delivery status.')
      return jsonResponse(500, { message: 'Could not load WhatsApp delivery status.' })
    }
    if (!existing) return jsonResponse(404, { message: 'No confirmation notification is queued.' })
    if (existing.status === 'sent') return jsonResponse(200, { status: 'sent' })
    if (
      existing.status === 'sending' &&
      existing.last_attempt_at &&
      Date.now() - new Date(existing.last_attempt_at).getTime() < 5 * 60_000
    ) {
      return jsonResponse(202, { status: 'sending' })
    }

    const { data: claimedRows, error: claimError } = await admin.rpc(
      'claim_appointment_confirmation_notification',
      { p_appointment_id: appointmentId },
    )
    if (claimError) {
      console.error('Could not claim the WhatsApp notification.')
      return jsonResponse(500, { message: 'Could not prepare the WhatsApp notification.' })
    }
    const notification = claimedRows[0]
    if (!notification) {
      return jsonResponse(202, { status: 'sending' })
    }

    const appointmentDate = new Intl.DateTimeFormat('pt-BR', {
      timeZone: Deno.env.get('CLINIC_TIME_ZONE') ?? 'America/Sao_Paulo',
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(notification.appointment_start))

    let providerResponse: Response
    try {
      providerResponse = await fetch(
        `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: notification.patient_whatsapp,
            type: 'template',
            template: {
              name: templateName,
              language: { code: templateLanguage },
              components: [
                {
                  type: 'body',
                  parameters: [
                    { type: 'text', text: notification.patient_name },
                    { type: 'text', text: notification.procedure_name },
                    { type: 'text', text: notification.dentist_name },
                    { type: 'text', text: appointmentDate },
                  ],
                },
              ],
            },
          }),
          signal: AbortSignal.timeout(15_000),
        },
      )
    } catch {
      const { error: markError } = await admin.rpc('fail_appointment_confirmation_notification', {
        p_outbox_id: notification.outbox_id,
        p_error: 'Could not connect to the WhatsApp provider.',
      })
      if (markError) console.error('Could not mark the WhatsApp notification as failed.')
      return jsonResponse(502, { message: 'Could not connect to the WhatsApp provider.' })
    }

    if (!providerResponse.ok) {
      const safeError = `WhatsApp provider returned HTTP ${providerResponse.status}.`
      const { error: markError } = await admin.rpc('fail_appointment_confirmation_notification', {
        p_outbox_id: notification.outbox_id,
        p_error: safeError,
      })
      if (markError) console.error('Could not mark the WhatsApp notification as failed.')
      return jsonResponse(502, { message: safeError })
    }

    let providerResult: unknown
    try {
      providerResult = await providerResponse.json()
    } catch {
      const { error: markError } = await admin.rpc('fail_appointment_confirmation_notification', {
        p_outbox_id: notification.outbox_id,
        p_error: 'WhatsApp provider returned invalid JSON.',
      })
      if (markError) console.error('Could not mark the WhatsApp notification as failed.')
      return jsonResponse(502, { message: 'WhatsApp provider returned an invalid response.' })
    }
    const messageId =
      typeof providerResult === 'object' &&
      providerResult !== null &&
      'messages' in providerResult &&
      Array.isArray(providerResult.messages) &&
      typeof providerResult.messages[0]?.id === 'string'
        ? providerResult.messages[0].id
        : null

    if (!messageId) {
      const { error: markError } = await admin.rpc('fail_appointment_confirmation_notification', {
        p_outbox_id: notification.outbox_id,
        p_error: 'WhatsApp provider returned an unexpected response.',
      })
      if (markError) console.error('Could not mark the WhatsApp notification as failed.')
      return jsonResponse(502, { message: 'WhatsApp provider returned an unexpected response.' })
    }

    const { error: completeError } = await admin.rpc('complete_appointment_confirmation_notification', {
      p_outbox_id: notification.outbox_id,
      p_provider_message_id: messageId,
    })
    if (completeError) {
      console.error('The provider accepted the message, but delivery status could not be saved.')
      return jsonResponse(500, { message: 'The provider accepted the message, but its delivery status could not be saved.' })
    }

    return jsonResponse(200, { status: 'sent' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected notification error.'
    if (message.startsWith('Missing function secret:')) {
      console.error(message)
      return jsonResponse(503, { message: 'WhatsApp delivery is not configured in Supabase yet.' })
    }
    console.error('Unexpected WhatsApp notification failure.')
    return jsonResponse(500, { message: 'Unexpected WhatsApp notification failure.' })
  }
})
