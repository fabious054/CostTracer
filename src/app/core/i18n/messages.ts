/**
 * UI strings, English + Portuguese. Runtime-switchable (see `I18nService`).
 *
 * Scope: webview chrome only. Messages that originate in the Rust core (AWS error text,
 * `RiskFinding.detail`, validation messages) are still shown verbatim in English — translating
 * those needs the core to return keys instead of prose. Tracked as a follow-up.
 *
 * Placeholders use `{name}` and are filled by `I18nService.t(key, { name: value })`.
 */

export type Locale = 'en' | 'pt';

export const LOCALES: readonly Locale[] = ['en', 'pt'];

const EN = {
  // shell
  'brand.tagline': 'read-only · nothing leaves this machine',
  'browser.title': 'Open the CostTracer app window',
  'browser.body':
    'This page is the CostTracer user interface. It only works inside the desktop app, which is where it can talk to the local core.',
  'browser.hint': 'Run npm run tauri:dev and use the window it opens.',

  // transient / busy steps
  'booting.title': 'CostTracer',
  'booting.busy': 'Checking for a saved connection…',
  'detecting.title': 'Connect an AWS account',
  'detecting.busy': 'Looking for AWS configuration on this machine…',
  'validating.title': 'Validating credential',
  'validating.busy': 'Calling sts:GetCallerIdentity and probing minimum read access…',
  'checkingPermissions.title': 'Checking permissions',
  'checkingPermissions.busy': 'Checking whether this credential has more access than CostTracer needs…',
  'persisting.title': 'Saving connection',
  'persisting.busy': "Storing the credential in your operating system's secure vault…",

  // method select
  'method.title': 'Connect an AWS account',
  'method.subtitle': 'Read-only. Your credential stays on this machine.',
  'method.detected.heading': 'Use detected configuration',
  'method.detected.found': 'Found:',
  'method.detected.profile': 'Profile',
  'method.detected.use': 'Use this configuration',
  'method.manual.heading': 'Enter an Access Key',
  'method.manual.desc': 'Paste an Access Key ID and Secret Access Key manually.',
  'method.manual.cta': 'Enter keys manually',
  'method.sso.heading': 'Sign in with IAM Identity Center',
  'method.sso.desc': 'Authorize in your browser via SSO device authorization.',
  'method.sso.cta': 'Continue with SSO',

  // manual entry
  'manual.title': 'Enter an Access Key',
  'manual.subtitle': 'Keys are sent to the local core only, never to a server.',
  'manual.accessKeyId': 'Access Key ID',
  'manual.secret': 'Secret Access Key',
  'manual.show': 'Show',
  'manual.hide': 'Hide',
  'manual.sessionToken': 'Session token',
  'manual.sessionToken.required':
    'Required — an ASIA… key is a temporary credential and needs its session token.',
  'manual.sessionToken.optional': 'Only for temporary credentials (ASIA…).',
  'manual.validate': 'Validate',

  // region field
  'region.label': 'Default region (optional)',
  'region.placeholder': 'e.g. us-east-1',
  'region.ssoLabel': 'Identity Center region',

  // sso start
  'sso.start.title': 'Sign in with IAM Identity Center',
  'sso.start.url': 'Start URL',
  'sso.start.continue': 'Continue',

  // sso device auth
  'sso.device.title': 'Authorize in your browser',
  'sso.device.subtitle': 'CostTracer is waiting for you to approve this device.',
  'sso.device.step1': 'Open this page and sign in',
  'sso.device.open': 'Open in browser',
  'sso.device.opening': 'Opening…',
  'sso.device.copyLink': 'Copy link',
  'sso.device.openFailed': "Couldn't open the browser here — copy the link and open it yourself.",
  'sso.device.step2': 'Confirm this code',
  'sso.device.copyCode': 'Copy code',
  'sso.device.step3': 'Approve access for CostTracer, then come back here',
  'sso.device.waiting': 'Waiting for approval',
  'sso.device.expiresIn': 'expires in {time}',

  // sso select target
  'sso.target.title': 'Choose an account and role',
  'sso.target.subtitle': 'Pick the identity CostTracer should read with.',
  'sso.target.note':
    'CostTracer only reads. Prefer the narrowest role — whatever you pick is checked again on the next screen.',
  'sso.target.badge.readonly': 'Recommended',
  'sso.target.badge.elevated': 'Not ideal',
  'sso.target.badge.broad': 'Discouraged',
  'sso.target.badge.blocked': 'Not allowed',

  // validation failed
  'failed.title.insufficient': 'Not enough permission',
  'failed.title.invalid': 'Credential rejected',
  'failed.strong.insufficient': 'This credential is valid but cannot read what CostTracer needs.',
  'failed.strong.invalid': 'AWS rejected this credential.',
  'failed.hint.insufficient':
    'Attach the policy from docs/iam-policy-minimal.json to this identity, then try again.',
  'failed.hint.invalid': 'The key may be wrong, disabled, or expired. Check it and retry, or switch method.',
  'failed.retry': 'Try again',
  'failed.switch': 'Switch method',
  'failed.method': 'Method: {method}',

  // excessive permissions
  'excessive.title': 'This credential can do more than CostTracer needs',
  'excessive.subtitle': 'CostTracer is read-only. A narrower credential limits your exposure.',
  'excessive.strong': 'Over-privileged credential detected',
  'excessive.checkedVia': 'Checked via {method}.',
  'excessive.kind.simulatedActionAllowed':
    'Simulation says this identity may run these destructive actions ({count}):',
  'excessive.kind.broadManagedPolicy': 'These attached managed policies grant well beyond read-only:',
  'excessive.kind.wildcardActionStatement': 'These policy statements allow every action:',
  'excessive.continue': 'Continue at my own risk',
  'excessive.goBack': 'Go back and switch credential',

  // policy block
  'policy.heading': 'Minimal read-only IAM policy',
  'policy.copy': 'Copy',
  'policy.copied': 'Copied',
  'policy.copyFailed': 'Copy failed',
  'policy.note': 'Copying puts this on your clipboard. CostTracer does not apply it to your account.',

  // account info
  'account.title': 'Connected',
  'account.subtitle': 'Read-only. Credential stored in your OS vault.',
  'account.accountId': 'Account ID',
  'account.region': 'Region',
  'account.regions': 'Regions',
  'account.signedInAs': 'Signed in as',
  'account.via': 'Via',
  'account.disconnect': 'Disconnect',

  // scan (Scope 2)
  'scan.accountBar': 'Account {account}',
  'scan.firstRun.title': 'No scan yet',
  'scan.firstRun.body':
    'Run a scan to inventory this account and flag idle resources. Read-only — nothing is changed in AWS.',
  'scan.run': 'Run scan',
  'scan.runFirst': 'Run the first scan',
  'scan.rescan': 'Rescan',
  'scan.scanning': 'Scanning…',
  'scan.error.title': 'Scan failed',
  'scan.error.retry': 'Try again',
  'scan.meta.lastRun': 'Last scan {when}',
  'scan.meta.partial': 'Partial — some regions failed',
  'scan.detector.ebs-unattached': 'Unattached EBS volumes',
  'scan.detector.elastic-ip-idle': 'Idle Elastic IPs',
  'scan.detector.orphan-snapshot': 'Orphan snapshots',
  'scan.counts': '{alerting} alerting · {total} total',
  'scan.empty': 'None found in this account.',
  'scan.regionError': 'Region {region} failed: {message}',
  'scan.level.observed': 'Observed',
  'scan.level.persisting': 'Persisting',
  'scan.level.probable': 'Probable',
  'scan.level.confirmed': 'Confirmed',
  'scan.explain.ebs': 'Unattached for {days} days of observation. Created {ageDays} days ago.',
  'scan.explain.ebs.noAge': 'Unattached for {days} days of observation.',
  'scan.explain.eip':
    'Unassociated for {days} days of observation. Monitored since {date} — AWS reports no creation date for an Elastic IP, so we count from the first time CostTracer saw it.',
  'scan.explain.snapshot':
    'Source volume gone for {days} days of observation. Snapshots take longer to confirm (30 days) because they are commonly used as intentional retention.',
  'scan.neutralNote.associated-instance-stopped': 'Associated with a stopped instance.',
  'scan.neutralNote.snapshot-source-unknown': "Source volume can't be determined (AWS-created snapshot).",
  'scan.markIntentional': 'Mark as intentional',
  'scan.intentional': 'Ignored — marked as intentional',
  'scan.undo': 'Undo',
  'scan.fact.size': '{n} GiB',
  'scan.fact.monitoredSince': 'monitored since {date}',
  'scan.fact.createdAgo': 'created {days} days ago',

  // shared
  'common.copied': 'Copied',
  'common.back': 'Back',
  'common.cancel': 'Cancel',
  'common.optional': 'optional',

  // credential source labels
  'source.detected': 'detected configuration',
  'source.manual': 'manual Access Key',
  'source.sso': 'IAM Identity Center',
  'source.detected.title': 'Detected configuration',
  'source.manual.title': 'Manual Access Key',
  'source.sso.title': 'IAM Identity Center',

  // audit method labels
  'auditMethod.simulate': 'iam:SimulatePrincipalPolicy',
  'auditMethod.listPolicies': 'iam:ListAttachedUserPolicies (fallback)',
  'auditMethod.inconclusive': 'a partial check',

  // store notices
  'notice.staleSession': 'Your saved session is no longer valid. Reconnect to continue.',
  'notice.ssoExpired': 'The authorization code expired. Start the SSO flow again.',
} as const;

export type MessageKey = keyof typeof EN;

const PT: Record<MessageKey, string> = {
  'brand.tagline': 'somente leitura · nada sai desta máquina',
  'browser.title': 'Abra a janela do app CostTracer',
  'browser.body':
    'Esta página é a interface do CostTracer. Ela só funciona dentro do app desktop, que é onde consegue falar com o núcleo local.',
  'browser.hint': 'Rode npm run tauri:dev e use a janela que abrir.',

  'booting.title': 'CostTracer',
  'booting.busy': 'Verificando se há uma conexão salva…',
  'detecting.title': 'Conectar uma conta AWS',
  'detecting.busy': 'Procurando configuração da AWS nesta máquina…',
  'validating.title': 'Validando credencial',
  'validating.busy': 'Chamando sts:GetCallerIdentity e testando o acesso mínimo de leitura…',
  'checkingPermissions.title': 'Checando permissões',
  'checkingPermissions.busy': 'Checando se esta credencial tem mais acesso do que o CostTracer precisa…',
  'persisting.title': 'Salvando conexão',
  'persisting.busy': 'Guardando a credencial no cofre seguro do sistema operacional…',

  'method.title': 'Conectar uma conta AWS',
  'method.subtitle': 'Somente leitura. Sua credencial fica nesta máquina.',
  'method.detected.heading': 'Usar configuração detectada',
  'method.detected.found': 'Encontrado:',
  'method.detected.profile': 'Profile',
  'method.detected.use': 'Usar esta configuração',
  'method.manual.heading': 'Inserir uma Access Key',
  'method.manual.desc': 'Cole um Access Key ID e um Secret Access Key manualmente.',
  'method.manual.cta': 'Inserir chaves manualmente',
  'method.sso.heading': 'Entrar com o IAM Identity Center',
  'method.sso.desc': 'Autorize no navegador via SSO device authorization.',
  'method.sso.cta': 'Continuar com SSO',

  'manual.title': 'Inserir uma Access Key',
  'manual.subtitle': 'As chaves vão só para o núcleo local, nunca para um servidor.',
  'manual.accessKeyId': 'Access Key ID',
  'manual.secret': 'Secret Access Key',
  'manual.show': 'Mostrar',
  'manual.hide': 'Ocultar',
  'manual.sessionToken': 'Session token',
  'manual.sessionToken.required':
    'Obrigatório — uma chave ASIA… é credencial temporária e precisa do session token.',
  'manual.sessionToken.optional': 'Só para credenciais temporárias (ASIA…).',
  'manual.validate': 'Validar',

  'region.label': 'Região padrão (opcional)',
  'region.placeholder': 'ex: us-east-1',
  'region.ssoLabel': 'Região do Identity Center',

  'sso.start.title': 'Entrar com o IAM Identity Center',
  'sso.start.url': 'Start URL',
  'sso.start.continue': 'Continuar',

  'sso.device.title': 'Autorize no seu navegador',
  'sso.device.subtitle': 'O CostTracer está esperando você aprovar este dispositivo.',
  'sso.device.step1': 'Abra esta página e faça login',
  'sso.device.open': 'Abrir no navegador',
  'sso.device.opening': 'Abrindo…',
  'sso.device.copyLink': 'Copiar link',
  'sso.device.openFailed': 'Não deu para abrir o navegador daqui — copie o link e abra você mesmo.',
  'sso.device.step2': 'Confirme este código',
  'sso.device.copyCode': 'Copiar código',
  'sso.device.step3': 'Aprove o acesso para o CostTracer e volte aqui',
  'sso.device.waiting': 'Aguardando aprovação',
  'sso.device.expiresIn': 'expira em {time}',

  'sso.target.title': 'Escolha uma conta e um role',
  'sso.target.subtitle': 'Escolha a identidade com que o CostTracer vai ler.',
  'sso.target.note':
    'O CostTracer só lê. Prefira o role mais restrito — o que você escolher é checado de novo na tela seguinte.',
  'sso.target.badge.readonly': 'Recomendado',
  'sso.target.badge.elevated': 'Não ideal',
  'sso.target.badge.broad': 'Desaconselhado',
  'sso.target.badge.blocked': 'Não permitido',

  'failed.title.insufficient': 'Permissão insuficiente',
  'failed.title.invalid': 'Credencial recusada',
  'failed.strong.insufficient': 'Esta credencial é válida, mas não consegue ler o que o CostTracer precisa.',
  'failed.strong.invalid': 'A AWS recusou esta credencial.',
  'failed.hint.insufficient':
    'Anexe a policy de docs/iam-policy-minimal.json a esta identidade e tente de novo.',
  'failed.hint.invalid':
    'A chave pode estar errada, desativada ou expirada. Confira e tente de novo, ou troque de método.',
  'failed.retry': 'Tentar de novo',
  'failed.switch': 'Trocar método',
  'failed.method': 'Método: {method}',

  'excessive.title': 'Esta credencial pode fazer mais do que o CostTracer precisa',
  'excessive.subtitle': 'O CostTracer é somente leitura. Uma credencial mais restrita reduz sua exposição.',
  'excessive.strong': 'Credencial com permissão excessiva detectada',
  'excessive.checkedVia': 'Verificado via {method}.',
  'excessive.kind.simulatedActionAllowed':
    'A simulação diz que esta identidade pode executar estas ações destrutivas ({count}):',
  'excessive.kind.broadManagedPolicy': 'Estas policies gerenciadas anexadas concedem muito além de leitura:',
  'excessive.kind.wildcardActionStatement': 'Estes statements de policy permitem qualquer ação:',
  'excessive.continue': 'Continuar por minha conta e risco',
  'excessive.goBack': 'Voltar e trocar credencial',

  'policy.heading': 'Policy IAM mínima de leitura',
  'policy.copy': 'Copiar',
  'policy.copied': 'Copiado',
  'policy.copyFailed': 'Falha ao copiar',
  'policy.note': 'Copiar coloca isto na área de transferência. O CostTracer não aplica nada na sua conta.',

  'account.title': 'Conectado',
  'account.subtitle': 'Somente leitura. Credencial guardada no cofre do SO.',
  'account.accountId': 'Account ID',
  'account.region': 'Região',
  'account.regions': 'Regiões',
  'account.signedInAs': 'Conectado como',
  'account.via': 'Via',
  'account.disconnect': 'Desconectar',

  // scan (Escopo 2)
  'scan.accountBar': 'Conta {account}',
  'scan.firstRun.title': 'Nenhum scan ainda',
  'scan.firstRun.body':
    'Rode um scan para inventariar esta conta e sinalizar recursos ociosos. Somente leitura — nada é alterado na AWS.',
  'scan.run': 'Rodar scan',
  'scan.runFirst': 'Rodar o primeiro scan',
  'scan.rescan': 'Escanear de novo',
  'scan.scanning': 'Escaneando…',
  'scan.error.title': 'O scan falhou',
  'scan.error.retry': 'Tentar de novo',
  'scan.meta.lastRun': 'Último scan {when}',
  'scan.meta.partial': 'Parcial — algumas regiões falharam',
  'scan.detector.ebs-unattached': 'Volumes EBS não anexados',
  'scan.detector.elastic-ip-idle': 'Elastic IPs ociosos',
  'scan.detector.orphan-snapshot': 'Snapshots órfãos',
  'scan.counts': '{alerting} em alerta · {total} no total',
  'scan.empty': 'Nenhum encontrado nesta conta.',
  'scan.regionError': 'Região {region} falhou: {message}',
  'scan.level.observed': 'Observado',
  'scan.level.persisting': 'Persistindo',
  'scan.level.probable': 'Provável',
  'scan.level.confirmed': 'Confirmado',
  'scan.explain.ebs': 'Sem uso há {days} dias de observação. Criado há {ageDays} dias.',
  'scan.explain.ebs.noAge': 'Sem uso há {days} dias de observação.',
  'scan.explain.eip':
    'Sem associação há {days} dias de observação. Monitorado desde {date} — a AWS não informa data de criação de um IP elástico, por isso contamos a partir da primeira vez que o CostTracer viu este recurso.',
  'scan.explain.snapshot':
    'Sem volume de origem há {days} dias de observação. Snapshots levam mais tempo para confirmar (30 dias) por serem comumente usados como retenção intencional.',
  'scan.neutralNote.associated-instance-stopped': 'Associado a uma instância parada.',
  'scan.neutralNote.snapshot-source-unknown': 'Volume de origem não identificável (snapshot criado pela AWS).',
  'scan.markIntentional': 'Marcar como intencional',
  'scan.intentional': 'Ignorado — marcado como intencional',
  'scan.undo': 'Desfazer',
  'scan.fact.size': '{n} GiB',
  'scan.fact.monitoredSince': 'monitorado desde {date}',
  'scan.fact.createdAgo': 'criado há {days} dias',

  'common.copied': 'Copiado',
  'common.back': 'Voltar',
  'common.cancel': 'Cancelar',
  'common.optional': 'opcional',

  'source.detected': 'configuração detectada',
  'source.manual': 'Access Key manual',
  'source.sso': 'IAM Identity Center',
  'source.detected.title': 'Configuração detectada',
  'source.manual.title': 'Access Key manual',
  'source.sso.title': 'IAM Identity Center',

  'auditMethod.simulate': 'iam:SimulatePrincipalPolicy',
  'auditMethod.listPolicies': 'iam:ListAttachedUserPolicies (fallback)',
  'auditMethod.inconclusive': 'uma verificação parcial',

  'notice.staleSession': 'Sua sessão salva não é mais válida. Reconecte para continuar.',
  'notice.ssoExpired': 'O código de autorização expirou. Recomece o fluxo de SSO.',
};

export const MESSAGES: Record<Locale, Record<MessageKey, string>> = { en: EN, pt: PT };
