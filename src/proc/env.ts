/**
 * `buildWorkerEnv` -- o ambiente MINIMO que o worker recebe.
 *
 * PORQUE UMA ALLOWLIST E NAO `{ ...process.env }`: o plano de controlo do DSH
 * corre com `ADMIN_USER`/`ADMIN_PASS` no ambiente (e o `cordis.patch.yml` que as
 * le para montar a credencial de Basic Auth). Herdar `process.env` inteiro
 * entregava essas duas variaveis a um binario Python de terceiros que consome
 * input arbitrario da Internet (long-polling do Telegram). Comprometido o bot, o
 * atacante le `ADMIN_PASS` do seu proprio `/proc/self/environ` e autentica-se no
 * plano de controlo -- exatamente o pivo remoto->local que este plugin existe
 * para impedir. O ambiente e portanto CONSTRUIDO, nunca herdado.
 *
 * NOTA SOBRE O ASSENTO: o pacote `dsh-subprocess` ja limpa nomes com forma
 * de credencial e todos os `DSH_*` do ambiente-pai (`scrubbedParentEnv`), e o
 * `env` do spec e mesclado DEPOIS dessa limpeza. Isso e uma segunda camada, nao
 * a nossa: a heuristica dele nao conhece `ADMIN_PASS`, e o `env` explicito que
 * lhe entregamos e precisamente o vector por onde uma entrada deliberada
 * SOBREVIVE a limpeza. A allowlist continua a ser a defesa, nao o assento.
 *
 * O criterio de inclusao e "sem isto um processo Python nao arranca ou nao fala
 * TLS", nao "e comodo ter". Quem precisar de mais (um proxy corporativo, por
 * exemplo) acrescenta aqui explicitamente -- de novo, "explicit > implicit".
 */

const WORKER_ENV_ALLOWLIST: readonly string[] = [
  // Indispensaveis para localizar e executar o interpretador.
  'PATH',
  'HOME',
  'TMPDIR',
  // Localizacao / formatacao (evita UnicodeDecodeError em locales exoticos).
  'LANG',
  'TZ',
  // Interpretador.
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONUNBUFFERED',
  'PYTHONIOENCODING',
  'PYTHONDONTWRITEBYTECODE',
  // Raizes de confianca TLS (sem elas o cliente HTTPS do bot falha a validar).
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  // Windows: sem SystemRoot/ComSpec o proprio arranque do processo falha.
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
]

/** Prefixos aceites em bloco (as `LC_*` do POSIX sao dezenas). */
const WORKER_ENV_PREFIXES: readonly string[] = ['LC_']

/**
 * Marca "este processo foi arrancado pelo plugin, com o canal IPC armado".
 *
 * PARA QUE SERVE, e para que NAO serve. Nao e credencial, nao autoriza nada e o
 * dead-man's switch nao depende dela: o EOF do `stdin` termina o worker haja ou
 * nao marca. O que ela compra e uma MENSAGEM: corrido a mao, o worker tem `fd 0`
 * num terminal ou em `/dev/null`, e no segundo caso via EOF imediato e saia sem
 * dizer porque — indistinguivel de uma avaria. Com a marca ausente ele escreve
 * uma linha em `stderr` a explicar.
 *
 * VALOR DUPLICADO EM `worker/ipc.ts` (`WORKER_IPC_ENV_VAR`) e nao importado: o
 * worker so pode importar `src/contracts/ipc.ts` de `src/`
 * (`05-QUALIDADE-CODIGO.md` 5.5). `test/unit/proc/env.test.ts` assere que as
 * duas constantes sao iguais, para que a divergencia seja um teste vermelho e
 * nao uma mensagem que desaparece.
 *
 * SOBREVIVE AO `scrubbedParentEnv()` do assento — que remove todos os `DSH_*`
 * HERDADOS — porque o `env` explicito do spec e mesclado DEPOIS da limpeza.
 */
export const WORKER_IPC_ENV_MARK = 'DSH_GUARD_IPC'

/**
 * Identificador do provedor de mensageria ATIVO (desacoplamento do bot, D1).
 *
 * FECHADO e paralelo ao enum de `Config.worker.provider` (o `PersistedState`
 * vive no contrato congelado e ainda so admite `telegram` — a ausencia le-se
 * como o default fechado). `'discord'` e uma entrada REGISTRADA neste host
 * desde ja: o adaptador do worker chega na Onda 3, mas o host precisa de estar
 * pronto para rotular o filho com `DSH_GUARD_PROVIDER=discord` e injetar o
 * `DISCORD_BOT_TOKEN` no mesmo dia. Ate la, `provider: 'discord'` na config
 * faz o worker falhar-closed no registry (provedor desconhecido) — o contrario
 * de degradar em silencio para o telegram, que nasceria com o token de outro
 * provedor. Um provedor futuro ACRESCENTA um literal AQUI e a sua linha em
 * {@link PROVIDER_ENV} — nunca reescreve uma variavel existente, para que
 * nenhuma mudanca mude silenciosamente o token de um bot ja emparelhado.
 */
export type ProviderId = 'telegram' | 'discord'

/** O default fechado do provedor (D1): ausente em config/estado = telegram. */
export const DEFAULT_PROVIDER: ProviderId = 'telegram'

/**
 * Tabela provedor -> variavel de ambiente (e demais) que o worker desse
 * provedor espera receber (`TOKEN_ENV_VAR` do lado do worker).
 *
 * Um provedor e apenas uma ENTRADA aqui: o nome do `tokenVar` para onde o
 * `worker.token` vai parar. Telegram usa `TELEGRAM_BOT_TOKEN`; um provedor
 * futuro (ex.: `whatsapp`) acrescentaria a propria linha com o seu `tokenVar`.
 * O nome da variavel esta DUPLICADO do lado do worker
 * (`worker/providers/telegram/token.ts`, `TOKEN_ENV_VAR`) e nao importado por
 * construcao — o worker so pode importar
 * `src/contracts/ipc.ts` de `src/` (`05-QUALIDADE-CODIGO.md` 5.5); a paridade
 * e um teste, nao um import.
 */
export const PROVIDER_ENV: Readonly<Record<ProviderId, { readonly tokenVar: string }>> = {
  telegram: { tokenVar: 'TELEGRAM_BOT_TOKEN' },
  // REGISTRADA (Onda 2 do host): o adaptador discord do worker (Onda 3) le
  // `DISCORD_BOT_TOKEN` como `TOKEN_ENV_VAR` proprio. A paridade e um teste
  // (`test/unit/proc/env.test.ts`), nao um import — o worker so pode importar
  // `src/contracts/ipc.ts` de `src/` (cone de import).
  discord: { tokenVar: 'DISCORD_BOT_TOKEN' },
}

/**
 * Variavel que nomeia o PROVEDOR ATIVO no ambiente do worker.
 *
 * O worker le-a para saber sob que contrato de provider esta a correr, sem ter
 * de adivinhar pelo nome do `tokenVar` (que muda com o provedor). E injetada
 * PELO HOST em `buildWorkerEnv` — por isso e da familia `DSH_*` que o assento
 * raspa do ambiente HERDADO: nunca entra vinda do pai, so e reconstruida na
 * allowlist explicita. Manter o protocolo MODESTO: o worker nao autoriza nada
 * com esta variavel; e so rotulo.
 */
export const WORKER_PROVIDER_ENV_VAR = 'DSH_GUARD_PROVIDER'

/**
 * Monta o ambiente do worker: allowlist + o token do provedor ativo + a marca
 * do canal IPC + o rotulo do provedor.
 *
 * O token entra por ambiente e NUNCA por argv, porque `argv` e legivel por
 * qualquer processo local em `/proc/<pid>/cmdline`.
 *
 * O `provider` e OPCIONAL com default fechado `telegram` (D1): quem chama sem
 * provider e quem corre hoje, e o alvo da variavel e o MESMO —
 * `TELEGRAM_BOT_TOKEN`. O token vai para `PROVIDER_ENV[provider].tokenVar`
 * (`TELEGRAM_BOT_TOKEN` para telegram, `DISCORD_BOT_TOKEN` para discord); a
 * assinatura faz um provedor futuro mudar apenas o `tokenVar` de destino,
 * nunca o parametro `token`.
 *
 * As chaves sao comparadas em maiusculas porque o Windows trata os nomes de
 * variaveis de forma insensivel a caixa (`SystemRoot` == `SYSTEMROOT`).
 */
/**
 * Resolve o PROVEDOR ATIVO a partir do ambiente (fail-closed, D1).
 *
 * Le `DSH_GUARD_PROVIDER` — a MESMA variavel que rotula o worker. O host a
 * injeta no filho via `buildWorkerEnv`; o CLI de onboarding (`dsh-guard-setup`)
 * le-a para saber com que provedor esta a falar (chave do `secrets.env`,
 * rotulos do texto, sonda). Ausente/vazio = default fechado `telegram`.
 *
 * VALOR DESCONHECIDO = ERRO, nao default. Degradar em silencio para o
 * telegram quando alguem pediu discord leria a CHAVE ERRADA do `secrets.env`
 * e mostraria os rotulos errados — a mesma razao do `resolverProvedor`
 * fail-closed do registry do worker (`worker/providers/registry.ts`).
 */
export function resolverProvedorDoAmbiente(
  ambiente: Readonly<Record<string, string | undefined>> = process.env,
): ProviderId {
  const bruto = ambiente[WORKER_PROVIDER_ENV_VAR]?.trim()
  if (bruto === undefined || bruto === '') return DEFAULT_PROVIDER
  if (!(bruto in PROVIDER_ENV)) {
    throw new Error(
      `${WORKER_PROVIDER_ENV_VAR}='${bruto}' nao e um provedor conhecido ` +
        `(${Object.keys(PROVIDER_ENV).join(' | ')}). Corrija a variavel e repita.`,
    )
  }
  return bruto as ProviderId
}

export function buildWorkerEnv(
  source: NodeJS.ProcessEnv,
  token: string,
  provider: ProviderId = DEFAULT_PROVIDER,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue

    const upper = key.toUpperCase()
    const allowed =
      WORKER_ENV_ALLOWLIST.includes(upper) ||
      WORKER_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))

    if (allowed) env[key] = value
  }

  env[PROVIDER_ENV[provider].tokenVar] = token
  env[WORKER_PROVIDER_ENV_VAR] = provider
  env[WORKER_IPC_ENV_MARK] = '1'

  return env
}
