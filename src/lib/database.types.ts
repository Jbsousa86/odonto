type Table<Row, Insert, Update = Partial<Insert>> = {
  Row: Row
  Insert: Insert
  Update: Update
  Relationships: []
}

export type Database = {
  odonto: {
    Tables: {
      pacientes: Table<
        {
          id: string
          auth_user_id: string
          nome_completo: string
          whatsapp: string
          email: string
          data_nascimento: string | null
          whatsapp_consentido_em: string | null
          criado_em: string
        },
        {
          id?: string
          auth_user_id: string
          nome_completo: string
          whatsapp: string
          email: string
          data_nascimento?: string | null
          whatsapp_consentido_em?: string | null
        },
        {
          nome_completo?: string
          whatsapp?: string
          data_nascimento?: string | null
          whatsapp_consentido_em?: string | null
        }
      >
      dentistas: Table<
        { id: string; nome: string; cro: string; especialidade: string; ativo: boolean },
        { id?: string; nome: string; cro: string; especialidade: string; ativo?: boolean }
      >
      procedimentos: Table<
        { id: string; nome: string; duracao_minutos: number; preco_base: number; ativo: boolean },
        { id?: string; nome: string; duracao_minutos: number; preco_base: number; ativo?: boolean }
      >
      agendamentos: Table<
        {
          id: string
          paciente_id: string
          dentista_id: string
          procedimento_id: string
          data_hora_inicio: string
          data_hora_fim: string
          status: 'pendente' | 'confirmado' | 'finalizado' | 'cancelado' | 'no-show'
          criado_em: string
        },
        {
          id?: string
          paciente_id: string
          dentista_id: string
          procedimento_id: string
          data_hora_inicio: string
          data_hora_fim: string
          status?: 'pendente' | 'confirmado' | 'finalizado' | 'cancelado' | 'no-show'
        }
      >
      guest_appointments: Table<
        {
          id: string
          clinic_client_id: string | null
          patient_name: string
          patient_whatsapp: string
          dentist_id: string
          procedure_id: string
          appointment_start: string
          appointment_end: string
          status: 'agendado' | 'cancelado' | 'finalizado'
          payment_method: 'dinheiro' | 'cartao' | 'pix' | null
          payment_amount: number | null
          paid_at: string | null
          created_by: string
          created_at: string
        },
        {
          id?: string
          clinic_client_id?: string | null
          patient_name: string
          patient_whatsapp: string
          dentist_id: string
          procedure_id: string
          appointment_start: string
          appointment_end: string
          status?: 'agendado' | 'cancelado'
          payment_method?: 'dinheiro' | 'cartao' | 'pix' | null
          payment_amount?: number | null
          paid_at?: string | null
          created_by: string
          created_at?: string
        }
      >
      clinic_clients: Table<
        {
          id: string
          nome_completo: string
          whatsapp: string
          email: string | null
          data_nascimento: string | null
          rua: string | null
          bairro: string | null
          cidade: string | null
          criado_por: string
          criado_em: string
          atualizado_em: string
        },
        {
          id?: string
          nome_completo: string
          whatsapp: string
          email?: string | null
          data_nascimento?: string | null
          rua?: string | null
          bairro?: string | null
          cidade?: string | null
          criado_por: string
          criado_em?: string
          atualizado_em?: string
        },
        {
          nome_completo?: string
          whatsapp?: string
          email?: string | null
          data_nascimento?: string | null
          rua?: string | null
          bairro?: string | null
          cidade?: string | null
        }
      >
      bloqueios_agenda: Table<
        {
          id: string
          dentista_id: string | null
          data_hora_inicio: string
          data_hora_fim: string
          motivo: string
        },
        {
          id?: string
          dentista_id?: string | null
          data_hora_inicio: string
          data_hora_fim: string
          motivo: string
        }
      >
      clinic_staff: Table<{ user_id: string; criado_em: string }, { user_id: string }>
      appointment_confirmation_outbox: Table<
        {
          id: string
          appointment_id: string
          status: 'pending' | 'sending' | 'sent' | 'failed'
          attempts: number
          last_attempt_at: string | null
          sent_at: string | null
          provider_message_id: string | null
          last_error: string | null
          criado_em: string
        },
        { id?: string; appointment_id: string; status?: 'pending' | 'sending' | 'sent' | 'failed' }
      >
    }
    Views: Record<string, never>
    Functions: {
      check_appointment_availability: {
        Args: { p_dentista_id: string; p_inicio: string; p_fim: string }
        Returns: { disponivel: boolean; motivo: string | null }[]
      }
      create_appointment: {
        Args: { p_dentista_id: string; p_procedimento_id: string; p_inicio: string }
        Returns: string
      }
      create_guest_appointment: {
        Args: {
          p_clinic_client_id: string
          p_dentist_id: string
          p_procedure_id: string
          p_appointment_start: string
          p_access_token_hash: string
        }
        Returns: string
      }
      rotate_guest_appointment_link: {
        Args: { p_guest_appointment_id: string; p_access_token_hash: string }
        Returns: undefined
      }
      finish_guest_appointment: {
        Args: {
          p_guest_appointment_id: string
          p_payment_method: 'dinheiro' | 'cartao' | 'pix'
          p_payment_amount: number
        }
        Returns: undefined
      }
      reschedule_guest_appointment: {
        Args: { p_guest_appointment_id: string; p_appointment_start: string }
        Returns: undefined
      }
      cancel_guest_appointment: {
        Args: { p_guest_appointment_id: string }
        Returns: undefined
      }
      get_guest_appointment: {
        Args: { p_access_token_hash: string }
        Returns: {
          patient_name: string
          procedure_name: string
          dentist_name: string
          appointment_start: string
          appointment_end: string
        }[]
      }
      create_schedule_block: {
        Args: {
          p_dentista_id: string | null
          p_inicio: string
          p_fim: string
          p_motivo: string
        }
        Returns: string
      }
      confirm_appointment: {
        Args: { p_appointment_id: string }
        Returns: string
      }
      claim_appointment_confirmation_notification: {
        Args: { p_appointment_id: string }
        Returns: {
          outbox_id: string
          patient_name: string
          patient_whatsapp: string
          procedure_name: string
          dentist_name: string
          appointment_start: string
        }[]
      }
      complete_appointment_confirmation_notification: {
        Args: { p_outbox_id: string; p_provider_message_id: string }
        Returns: undefined
      }
      fail_appointment_confirmation_notification: {
        Args: { p_outbox_id: string; p_error: string }
        Returns: undefined
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
