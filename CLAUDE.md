# CLAUDE.md — CostTracer

Instruções permanentes de projeto para o Claude Code. Este arquivo é lido automaticamente no início
de cada sessão neste repositório e deve ser seguido sem necessidade de repetição manual.

---

## O que é o projeto

CostTracer é uma aplicação desktop de auditoria e visibilidade de custos AWS, local-first
(Tauri v2 + Rust no core, Angular no frontend). Roda inteiramente na máquina do usuário; nenhuma
credencial, dado de conta ou telemetria sai dela. É um projeto de portfólio open-source (licença
MIT), atualmente em fase inicial (Fase 0 do roadmap — ver `README.md`).

Decisões de produto (nome, escopo, fluxo, critérios de aceite) são tomadas em uma conversa separada
de produto, sem acesso a este código. Este arquivo, os ADRs e o código são o que chega até aqui —
trate o que está documentado como decidido, não como sugestão a reavaliar por conta própria.

## Fronteira de escopo — regra mais importante

Cada fase do projeto tem um escopo fechado (ver `cost-tracer/scope-reports/` para o registro vivo
de cada um, se você tiver acesso a essa pasta fora do repositório; caso contrário, peça o critério
de aceite do escopo atual antes de começar). Regras:

- **Não implemente nada fora do critério de aceite do escopo atual**, mesmo que pareça útil ou
  fácil de adicionar. Scope creep — mesmo bem-intencionado — precisa ser sinalizado, não decidido
  sozinho.
- Se durante a implementação você identificar uma necessidade real fora do escopo atual (como
  aconteceu com o trabalho de shell/titlebar/i18n durante o Escopo 1), **implemente se for
  pequeno e não bloquear o escopo, mas registre explicitamente como desvio** no relatório do
  escopo, sinalizando que pode virar um escopo próprio depois. Não decida sozinho que "já que
  estou aqui, vou expandir".
- Nunca implemente ações de escrita/exclusão em recursos AWS enquanto o projeto estiver na Fase 0
  (somente leitura). Isso é regra de segurança do produto, não só de escopo.

## Stack técnica (decisões travadas)

- **Core:** Rust + Tauri v2. Toda chamada à AWS e todo acesso ao cofre de credenciais do SO vivem
  aqui. O webview nunca vê um segredo — segredos ficam em memória no core (ex: `OnboardingSession`)
  até serem persistidos no cofre nativo via `keyring` (crate v3).
- **Frontend:** Angular 20, standalone components, signals nativos, **zoneless** (sem zone.js),
  novo control flow (`@if`/`@switch`). Bundle pequeno é um requisito de produto (alinhado ao pitch
  local-first), não só preferência técnica — pense nisso antes de adicionar uma dependência de
  runtime nova.
- **State management (Angular):** serviço de signals feito à mão + reducer puro exaustivo (ADR
  0001, Opção A). Não trocar por NgRx/XState sem um novo ADR aprovado — a decisão foi consciente e
  documentada, incluindo o critério de quando revisitar (Escopo 2, entidades/coleções/tabelas).
- **AWS SDK:** crates oficiais Rust (`aws-config`, `aws-sdk-{sts,iam,ec2,ssooidc,sso}`, e outros
  conforme novos detectores forem adicionados). Runtime `tokio`.
- **IPC:** única porta de comunicação Angular↔Rust via `invoke()`, tipada por um mapa de comandos.
  DTOs em Rust (`model.rs`) são a fonte da verdade dos tipos; o TypeScript espelha, não inventa
  campos novos sem o Rust ter primeiro.

## Segurança — não negociável

- **Menor permissão sempre.** Qualquer novo detector ou funcionalidade que precise de uma nova
  permissão IAM exige atualizar `docs/iam-policy-minimal.json` no mesmo commit/PR, com a permissão
  nova justificada pela feature nova. Nunca adicione permissão "por via das dúvidas".
- **Nenhum segredo em texto plano**, nunca. Cofre nativo do SO sempre (`keyring`).
- **Nenhuma chamada de rede fora dos domínios da AWS** (`*.amazonaws.com` e equivalentes) sem
  sinalizar isso explicitamente como decisão a ser validada — o pitch de segurança do produto
  depende disso ser verificável.
- A checagem de permissão excessiva (`iam:SimulatePrincipalPolicy` + fallback por nome de policy
  gerenciada) é uma peça central do produto, não um detalhe secundário. Bugs nela são prioridade
  alta — ver histórico de bug reportado no Escopo 1 (`AdministratorAccess` não disparando alerta).

## Autoria de commits

Todo commit é autorado e assinado só como o usuário — nunca inclua `Co-Authored-By: Claude`,
nem qualquer variação, no rodapé da mensagem de commit. Não use "Claude" como nome ou e-mail de
autor/committer em nenhum commit, mesmo que a ferramenta sugira isso por padrão. O uso de IA no
processo de desenvolvimento não é segredo, mas não deve aparecer como coautoria de código no
histórico do Git nem na lista de Contributors do GitHub — as decisões de produto e arquitetura
são do usuário, e o histórico de commits deve refletir isso.



Comente o **porquê**, nunca o **o quê**. O nome da função/variável já deveria comunicar o que o
código faz — se não comunica, o problema é o nome, não a falta de comentário.

Vale comentar quando:
- A decisão não é óbvia olhando só o código (ex: por que um probe extra depois do
  `GetCallerIdentity`, por que um fallback existe, por que um limite específico foi escolhido).
- Existe um trade-off consciente que alguém poderia "corrigir" por engano sem esse contexto.
- Há uma restrição externa não visível no código (ex: limite de bytes de uma API do SO, um
  comportamento inesperado de uma lib de terceiro).

Não vale comentar quando:
- O comentário só repete o que o código já diz (`// incrementa i` acima de `i += 1`).
- A explicação cabe melhor como nome de função/variável mais claro.
- É uma decisão arquitetural grande — essa vai para um ADR em `docs/adr/`, não pro código. O código
  pode ter uma linha curta apontando pro ADR relevante, não repetir o raciocínio inteiro.

Comentário desatualizado é pior que nenhum comentário — se o código mudar de um jeito que invalida
um comentário próximo, atualize ou remova o comentário no mesmo commit.

## ADRs

Decisões de arquitetura com mais de uma opção razoável (ex: state management, escolha de crate para
algo sensível, estrutura de dados de um novo domínio) viram um ADR em `docs/adr/`, seguindo o
formato já usado em `0001-angular-state-management.md`: contexto, drivers de decisão, opções
comparadas, recomendação, consequências, perguntas em aberto para quem decide. Não decida sozinho
uma escolha arquitetural não-trivial — apresente opções e pergunte, como já foi feito.

## Testes

- Todo reducer/máquina de estados precisa de testes cobrindo os caminhos negativos do critério de
  aceite, não só o caminho feliz (ex: `validationFailed` não pode voltar sozinho para seleção de
  método — isso é testado, não só implementado).
- Fluxos ponta a ponta relevantes (ex: conexão via SSO, via manual) testados com IPC fake no
  frontend.
- Rust: `cargo check` limpo, sem warnings, antes de considerar qualquer trecho pronto. `cargo test`
  para lógica sensível (ex: round-trip de fragmentação do cofre).
- Não é necessário (nem esperado) testar chamadas reais à AWS de forma automatizada — isso é
  validado manualmente pelo usuário, conforme o roteiro de validação de cada escopo.

## Idioma

- Código, nomes de variável/função, comentários, commits, ADRs: **inglês**.
- `README.md` (fonte oficial) em inglês; `README.pt-BR.md` como tradução mantida em paralelo.
- UI do produto: bilíngue (pt/en) via `core/i18n/`, runtime, sem dependência externa — ver
  `messages.ts` e `i18n.service.ts`. Novas strings de UI entram nos dois idiomas no mesmo commit.
  Mensagens que se originam no core Rust (erros da AWS, textos de validação) ainda não passam pelo
  i18n — isso é dívida técnica conhecida, não um padrão a seguir para código novo se puder ser
  evitado.
- Relatórios de escopo (`cost-tracer/scope-reports/`, fora deste repositório): português — não é
  responsabilidade de toda sessão, só quando explicitamente solicitado.

## Relatório de fechamento de escopo

Ao final de cada escopo (ou quando solicitado), gere/atualize o relatório correspondente seguindo o
template de duas partes (log de progresso cronológico + relatório de fechamento de 7 seções fixas)
já em uso em `cost-tracer/scope-reports/`. Esse arquivo vive fora deste repositório — se você não
tiver acesso a essa pasta na sessão atual, gere o conteúdo e entregue para o usuário copiar
manualmente.

## O que fazer quando uma decisão não está coberta aqui

Se a tarefa exigir uma decisão de **produto** (nome de feature, prioridade, critério de negócio,
UX) que não está em nenhum documento do repo — não decida sozinho. Sinalize a dúvida de forma
objetiva (como já foi feito com o ADR 0001) para o usuário levar à conversa de produto.

Se for uma decisão puramente **técnica** sem impacto de produto (nome interno de variável,
organização de arquivo dentro de uma pasta já definida) — decida e siga, sem precisar de aprovação.