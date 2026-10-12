# Odonto — agendamento

MVP responsivo de agendamento odontológico usando React, Vite, TailwindCSS e Supabase.

## Requisitos

- Node.js 20.19+ (ou 22.12+) e npm
- Projeto Supabase
- Supabase CLI para executar migrations localmente (opcional se aplicar a migration pelo SQL Editor)

## Desenvolvimento local

1. Instale as dependências:

   ```sh
   npm install
   ```

2. Copie `.env.example` para `.env.local` e informe a URL do projeto Supabase e a chave publicável/anon:

   ```dotenv
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-publishable-or-anon-key
   ```

   A chave privilegiada `service_role` não deve ser usada no frontend nem adicionada a variáveis `VITE_*`.

3. Este projeto guarda suas tabelas e funções no schema PostgreSQL `odonto`, separado das tabelas `public` dos outros aplicativos. No painel Supabase, adicione `odonto` à lista **Settings → API → Exposed schemas** (mantenha os schemas já usados pelos outros apps). Depois, aplique as migrations **nesta ordem** pelo SQL Editor:

   - `supabase/migrations/202610110001_initial_schema.sql`
   - `supabase/migrations/202610110002_whatsapp_confirmations.sql`
   - `supabase/migrations/202610110003_clinic_patient_profile_updates.sql`
   - `supabase/migrations/202610110004_private_guest_appointments.sql`
   - `supabase/migrations/202610110005_clinic_client_registration.sql`
   - `supabase/migrations/202610110006_finish_guest_appointments.sql`
   - `supabase/migrations/202610110007_appointment_payments_and_reports.sql`
   - `supabase/migrations/202610110008_reschedule_guest_appointments.sql`
   - `supabase/migrations/202610110009_cancel_guest_appointments.sql`
   - `supabase/migrations/202610120001_restrict_clinic_client_updates.sql`
   - `supabase/migrations/202610120002_clinic_client_address.sql`

   Também é possível aplicar as migrations pelo CLI:

   ```sh
   npx supabase link --project-ref SEU_PROJECT_REF
   npx supabase db push
   ```

   O schema separa os objetos do banco, mas projetos no mesmo Supabase compartilham o serviço de autenticação e a lista `auth.users`. As políticas RLS limitam os registros do Odonto; conceda acesso de equipe apenas a contas autorizadas e não use o schema `odonto` nos outros aplicativos.

4. Desative o cadastro público de usuários em **Authentication → Settings → User Signups** no projeto Supabase. Clientes não criam contas; a equipe entra com contas provisionadas no Supabase e autorizadas na tabela `odonto.clinic_staff`. O cadastro por e-mail também fica desativado na configuração local (`supabase/config.toml`).
5. A chave `VITE_SUPABASE_ANON_KEY`/publishable é pública e aparece no navegador; ela não concede acesso administrativo. Mantenha as políticas RLS e permissões das migrations aplicadas. Nunca coloque `service_role`, `SUPABASE_SERVICE_ROLE_KEY`, tokens da Meta ou senhas em variáveis `VITE_*`, no repositório ou no frontend. Arquivos `.env` locais são ignorados pelo Git.
6. Inicie a aplicação:

   ```sh
   npm run dev
   ```

Se as variáveis Supabase ainda não estiverem configuradas, a aplicação mostra a tela de configuração em vez de simular um login ou agendamento.

## Provisionar o acesso da clínica

1. No painel, crie o usuário da equipe em **Authentication → Users** (ou use um usuário existente) e copie seu UUID.
2. No SQL Editor, autorize a conta na equipe:

   ```sql
   insert into odonto.clinic_staff (user_id)
   values ('UUID_DO_USUARIO_AUTORIZADO');
   ```

Somente um administrador de confiança deve executar esse comando. A tabela de equipe não permite autoinscrição pelo navegador. Contas que não estiverem nessa lista não podem acessar a área administrativa.

## Agendar e compartilhar o atendimento

- Após o login, a clínica vê uma tela de descanso em tela cheia com a imagem em `public/clinic-welcome.png`, ajustada para preencher a janela. Coloque ali a imagem licenciada da clínica para personalizar a tela. Esse arquivo é independente de `public/image.png`, que permanece como favicon da aba do navegador. O botão **Acessar sistema** abre o painel; após um minuto sem interação, a tela retorna.
- Antes de agendar, a equipe cadastra o cliente na aba **Cadastrar cliente**. Nome e WhatsApp são obrigatórios; e-mail e data de nascimento são opcionais. Isso é apenas um registro da clínica: o cliente não recebe usuário ou senha e não entra no painel.
- Na aba **Agendar**, selecione um cliente já cadastrado, o procedimento, dentista e horário. Essa tela é exclusiva para agendamento; a equipe autorizada cria o atendimento e o sistema verifica conflitos.
- O cliente não cria perfil nem entra com senha. Após agendar ou gerar um novo link, a URL fica no bloco do atendimento em Consultas e no histórico do cliente na Visão geral, identificada pelo nome. A ação **Enviar pelo WhatsApp** abre a conversa do número cadastrado com uma mensagem pronta contendo os detalhes e o link privado; a equipe revisa e envia pelo WhatsApp. O link permanece disponível na sessão da clínica neste navegador; se precisar dele em outro navegador, gere um novo link no histórico do cliente (isso invalida o anterior).
- O link abre uma página de somente leitura e mostra apenas o nome, procedimento, dentista e horário daquele atendimento. O cliente não agenda, confirma, altera ou cancela pela página.
- O link contém um segredo aleatório de alta entropia no fragmento da URL. O banco armazena somente seu hash; esse hash não é disponibilizado nas consultas da equipe. **Quem receber ou encaminhar o link poderá ver aqueles detalhes**, então envie-o apenas ao cliente.
- A equipe pode gerar um novo link para o mesmo atendimento. Isso invalida imediatamente o link anterior.
- Na **Visão geral**, a seção de clientes mostra os clientes cadastrados; clique no nome para expandir o histórico com as consultas associadas, incluindo data, procedimento, dentista e situação (agendada, finalizada ou cancelada).
- Na tela de consultas, a equipe pode alterar o dia e horário de qualquer atendimento ainda agendado. O procedimento e o dentista permanecem os mesmos; somente horários futuros sem conflito ou bloqueio são aceitos. O link privado existente continua válido e mostra o novo horário; a clínica deve avisar o cliente pelo canal combinado.
- Se o cliente desistir, a clínica pode usar **Registrar desistência** no atendimento agendado e confirmar a ação. O registro fica como cancelado (não como finalizado), o horário é liberado, não há pagamento registrado e o link privado deixa de funcionar.
- A agenda indica quando o atendimento está **Em atendimento** e, após o horário previsto, mostra **Aguardando registro de realização** para lembrar a equipe de marcar se foi realizado. A equipe registra a realização informando uma única forma de pagamento (dinheiro, cartão ou Pix) e o valor efetivamente recebido. O preço base do procedimento é sugerido, mas pode ser editado; o banco valida o horário e registra realização e pagamento na mesma operação.
- A aba **Relatórios** permite selecionar um dia ou intervalo inclusivo e mostra a quantidade de consultas realizadas pela data do atendimento, além do total recebido, quantidade de pagamentos e subtotais por dinheiro, cartão e Pix pela data do recebimento, no fuso local do navegador da clínica.
- Pagamentos anteriores à migration 007 permanecem sem método/valor e não são incluídos nos relatórios; nenhum valor é inferido retroativamente.
- O WhatsApp informado é um dado de contato para a clínica. O compartilhamento é iniciado manualmente pela equipe no WhatsApp e não envia mensagens automaticamente nem registra consentimento para outras mensagens.
- A tela inicial **Visão geral** tem cartões para clientes cadastrados, próximas consultas, histórico de consultas e dentistas ativos. O cartão **Histórico de consultas** abre atendimentos anteriores, realizados, cancelados ou aguardando registro; o cartão **Próximas consultas** abre os atendimentos futuros. A aba **Agendar** é exclusiva para o formulário de agendamento. A lista e o histórico dos clientes aparecem somente ao clicar em **Clientes cadastrados**; não há uma aba separada de lista. **Cadastrar cliente** é exclusiva para o formulário de novos cadastros. Após cadastrar, o painel retorna à Visão geral.
- A aba **Configurações** reúne dentistas, procedimentos e bloqueios de agenda, necessários para oferecer opções ao agendar. Dentistas podem ser cadastrados um por vez sem um limite definido pelo aplicativo.
- O painel atual não exibe o CRM legado de pacientes com perfil nem ações de confirmação por WhatsApp. As tabelas e funções correspondentes foram mantidas no banco, mas não são necessárias para o fluxo MVP descrito aqui.
- A criação de atendimentos por link e de bloqueios compartilha um advisory lock transacional; conflitos em gravações simultâneas são rejeitados no Supabase.
- Bloqueios podem valer para um dentista ou para toda a clínica.
- Dentistas e procedimentos são desativados em vez de excluídos para preservar o histórico de consultas.
- O formulário recebe data/hora local e envia instantes UTC ao banco.
- A janela de funcionamento, geração de horários sugeridos e cancelamento pelo paciente ainda não fazem parte deste MVP.

## Integração legada de confirmação pelo WhatsApp (fora do painel MVP atual)

Esta integração não aparece no painel atual e não precisa ser configurada para cadastrar clientes, agendar pela clínica ou compartilhar links de consulta. As instruções abaixo ficam apenas para referência caso o fluxo de confirmação seja reativado futuramente.

1. No Meta Business, configure a WhatsApp Cloud API e um número de telefone apto a enviar mensagens.
2. Crie e obtenha a aprovação de um template de utilidade em português, por exemplo `confirmacao_consulta`, com quatro variáveis de corpo `{{1}}` a `{{4}}`. A ordem precisa ser: nome, procedimento, dentista e data/hora.

   Sugestão de texto para o corpo do template: `Olá, {{1}}! Sua consulta de {{2}} com {{3}} está confirmada para {{4}}. Em caso de dúvidas, fale com a clínica.`
3. Faça o deploy da Edge Function:

   ```sh
   npx supabase functions deploy send-appointment-confirmation-whatsapp --project-ref SEU_PROJECT_REF
   ```

4. Configure os secrets da função no projeto Supabase. Use a versão Graph API atualmente suportada pelo seu app Meta:

   ```sh
   npx supabase secrets set --project-ref SEU_PROJECT_REF `
     META_GRAPH_API_VERSION=vXX.X `
     WHATSAPP_PHONE_NUMBER_ID=SEU_PHONE_NUMBER_ID `
     WHATSAPP_ACCESS_TOKEN=SEU_TOKEN_DE_ACESSO `
     WHATSAPP_TEMPLATE_NAME=confirmacao_consulta `
     WHATSAPP_TEMPLATE_LANGUAGE=pt_BR `
     CLINIC_TIME_ZONE=America/Sao_Paulo
   ```

   Supabase disponibiliza `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` no ambiente da Edge Function. Não copie esses valores para variáveis `VITE_*` ou para arquivos do frontend.

5. Confirme que `odonto` está incluído em **Settings → API → Exposed Schemas** e que as migrations necessárias foram aplicadas em ordem. Se as migrations 001–005 já estiverem aplicadas, aplique as próximas migrations nesta sequência:
   - `supabase/migrations/202610110006_finish_guest_appointments.sql`
   - `supabase/migrations/202610110007_appointment_payments_and_reports.sql`
   - `supabase/migrations/202610110008_reschedule_guest_appointments.sql`
   - `supabase/migrations/202610110009_cancel_guest_appointments.sql`
6. Confirme que o paciente deu opt-in ao WhatsApp e que o template aprovado corresponde aos quatro parâmetros antes de testar o botão **Confirmar e avisar**.

O WhatsApp Cloud API pode cobrar por conversas/mensagens conforme as regras vigentes da Meta. O consentimento do paciente e os requisitos de privacidade/comunicação da clínica devem ser observados.

## Verificações

```sh
npm test
npm run build
npm run lint
```

## Deploy

1. Importe o repositório no Vercel com o preset Vite.
2. Configure `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` em cada ambiente Vercel.
3. Mantenha o build command `npm run build` e o output directory `dist`.
4. O `vercel.json` inclui o rewrite para rotas do frontend.
5. Adicione a URL de produção do Odonto às Redirect URLs permitidas do Supabase Auth. Como o projeto Supabase é compartilhado, não altere seu `Site URL` global sem avaliar os outros aplicativos. Envie as migrations antes de liberar o deploy.

O deploy pela Netlify também é possível usando `npm run build`, `dist` e uma regra de fallback SPA equivalente.
