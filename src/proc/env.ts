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
 * Monta o ambiente do worker: allowlist + o token do bot.
 *
 * O token entra por ambiente e NUNCA por argv, porque `argv` e legivel por
 * qualquer processo local em `/proc/<pid>/cmdline`.
 *
 * As chaves sao comparadas em maiusculas porque o Windows trata os nomes de
 * variaveis de forma insensivel a caixa (`SystemRoot` == `SYSTEMROOT`).
 */
export function buildWorkerEnv(source: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue

    const upper = key.toUpperCase()
    const allowed =
      WORKER_ENV_ALLOWLIST.includes(upper) ||
      WORKER_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))

    if (allowed) env[key] = value
  }

  env['TELEGRAM_BOT_TOKEN'] = token
  env[WORKER_IPC_ENV_MARK] = '1'

  return env
}
