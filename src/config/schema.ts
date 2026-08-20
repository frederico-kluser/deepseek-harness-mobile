/**
 * `interface Config` -- contrato congelado da entrada `config` do
 * `cordis.patch.yml` (id `guarded-bot-orchestrator`).
 *
 * COMO O MOTOR DE PATCHES RESOLVE ISTO (corrigido: a versao anterior deste
 * comentario dizia *whole-entry replace*, e esta errado). O `replace` do
 * `dsh-app-boot` e um SHALLOW MERGE das chaves de topo da entrada
 * (`lib/index.js:100-103`); so o objeto `config`, QUANDO fornecido, e substituido
 * inteiro. Consequencia pratica para este ficheiro, que nao muda: se a entrada
 * trouxer `config`, cada chave obrigatoria abaixo tem de existir literalmente
 * nesse objeto -- uma chave omitida DENTRO de `config` e uma chave apagada, nao
 * herdada.
 *
 * DUAS CHAVES DEIXARAM DE SER OBRIGATORIAS NESTA ONDA, e a razao e do manifesto,
 * nao de preferencia (medicao de T1.3 contra um `$DSH_HOME` limpo com
 * `dsh@0.1.0-rc.7`): o `cordis.patch.yml` passou a ser CAMADA 1 / BUNDLE, isto e,
 * viaja dentro do pacote npm e e aplicado em qualquer instalacao.
 *
 *   - `worker.cwd`: um caminho absoluto fixo num ficheiro empacotado quebra
 *     TODA a instalacao por npm -- o caminho da maquina de quem publicou nao
 *     existe na de quem instala. Passa a ser opcional, com default resolvido a
 *     partir do proprio pacote ({@link resolveWorkerCwd}).
 *   - `encodedAuthString`: uma credencial NAO pode existir num ficheiro
 *     versionavel (D19). Passa a ser opcional; a Onda 2 gera-a por CSPRNG e
 *     persiste apenas o digest. Enquanto for ausente, NINGUEM se autentica --
 *     ver a nota fail-closed em `src/http/auth-basic.ts`.
 *
 * ACRESCENTAR uma chave obriga a acrescentar a mesma chave ao `cordis.patch.yml`
 * na MESMA onda -- as duas coisas casam ou o plugin recusa arrancar.
 */

import { fileURLToPath } from 'node:url'

/** Forma exata da entrada `config` do `cordis.patch.yml`. */
export interface Config {
  /**
   * Par `utilizador:senha` ja codificado em base64 (o que segue `Basic `).
   *
   * OPCIONAL: ver o cabecalho deste ficheiro. Ausente = nenhuma credencial
   * estatica configurada = nenhuma requisicao passa a barreira.
   */
  encodedAuthString?: string
  /** Texto do desafio devolvido em `WWW-Authenticate` nas respostas 401. */
  realm: string
  /** Interfaces de bind aceites para `ctx.webServer.host` (allowlist do BIND). */
  allowedHosts: string[]
  /** Origens remotas confiadas (`req.socket.remoteAddress`). Vazio = nega tudo. */
  trustedRemotes: string[]
  /**
   * Prefixos que declaram a superficie de PLANO DE CONTROLO (ex.: `/api`).
   *
   * MUDANCA DE PAPEL NESTA ONDA, declarada em voz alta: enquanto a barreira era
   * (na intencao) um envelope por ROTA, esta lista decidia quais registos eram
   * embrulhados. A barreira real e dona do DESPACHO do `node:http.Server` e, no
   * ponto de despacho, nao existe identidade de rota -- so o `req`. A barreira
   * passa portanto a guardar a superficie INTEIRA, que e um SUPERCONJUNTO
   * estrito do que esta lista produzia (o assento de fallback ja era guardado
   * incondicionalmente e apanha tudo o que nenhuma rota nomeada reclama).
   *
   * A lista continua a ser o INVENTARIO DECLARADO do plano de controlo, e e
   * consumida por `src/http/path.ts` (`isGuardedPath`,
   * `routeMayServeGuardedPath`) -- que a Onda 3 usa para a politica por rota do
   * painel `/__guard` (D5). Continua validada no arranque.
   */
  guardedPrefixes: string[]
  /** Niveis de permissao recusados mesmo a pedidos autenticados. */
  deniedPermissions: string[]
  /** Worker de long-polling executado fora do event loop central. */
  worker: {
    /**
     * Executavel que corre o worker. O manifesto de Camada 1 usa
     * `process.execPath` -- o MESMO runtime Node que ja corre o host, sem
     * depender de haver um `node` no `PATH`.
     */
    command: string
    /**
     * Argumentos EXTRA, depois do entrypoint. NAO e a linha de comando.
     *
     * O entrypoint do worker NUNCA vem daqui, e nao pode vir: um caminho
     * relativo no manifesto resolveria contra o `cwd` do HOST, e o caminho
     * absoluto so e conhecido em runtime (muda entre a arvore de fonte e a
     * instalacao por npm). E `src/proc/supervisor.ts` que o antepoe, resolvido
     * de `import.meta.url` -- ver {@link resolveWorkerEntrypoint}. O valor
     * normal desta chave e `[]`.
     */
    args: string[]
    /**
     * Diretorio de trabalho do worker.
     *
     * OPCIONAL: ausente = o `worker/` empacotado ({@link resolveWorkerCwd}).
     */
    cwd?: string
    token: string
    /**
     * Janela de cortesia, em milissegundos, da escalada
     * `SIGTERM -> graceMs -> SIGKILL` do assento de subprocessos, e do dreno dos
     * canais ainda abertos depois da saida do processo.
     *
     * OBRIGATORIA em `SubprocessSpawnSpec`: o assento nao aplica defaults
     * ("this seam applies no defaults"). O valor de referencia do ecossistema e
     * 3000 ms -- `disposeGraceMs: z.number().default(3e3)` em
     * `dsh-terminal-bash@0.1.0-rc.7`. (Os nomes de pacote aparecem sem o escopo
     * npm em todo o `src/**` excepto `src/dsh/adapter.ts`: o especificador
     * completo e a marca de quem toca a API do host, e so um ficheiro a toca.)
     */
    graceMs: number
    backoff: {
      initialDelayMs: number
      maxDelayMs: number
      maxAttempts: number
      resetAfterMs: number
    }
  }
}

/** Atalho para o sub-objeto de recuo exponencial. */
export type BackoffConfig = Config['worker']['backoff']

/**
 * Resolve o diretorio `worker/` EMPACOTADO a partir da localizacao DESTE MODULO
 * -- nunca do `process.cwd()`.
 *
 * `09-DECISOES-CANONICAS.md:200`, `06-REPO-E-CI.md:283` e `01-ARQUITETURA.md:522`
 * dizem a mesma frase: *"O `argv` do spawn resolve `dist/worker/telegram-bot.js`
 * relativo a `import.meta.url`, nunca por `cwd`."* O `cwd` do processo hospedeiro
 * e o workspace do utilizador; nao tem relacao nenhuma com onde o pacote foi
 * instalado.
 *
 * UMA SO EXPRESSAO NAO SERVE OS DOIS LAYOUTS. A versao anterior deste comentario
 * afirmava que "os dois caminhos sobem exatamente dois niveis" -- a aritmetica
 * estava certa e a conclusao errada, porque o `worker/` esta FORA da arvore de
 * fonte e DENTRO da arvore emitida:
 *
 *   carregado de | import.meta.url                | worker/ efetivo
 *   -------------|--------------------------------|------------------------
 *   fonte (dev)  | <repo>/src/config/schema.ts    | <repo>/worker/      (../../)
 *   tarball      | <pkg>/dist/config/schema.js    | <pkg>/dist/worker/  (../)
 *
 * Medido: com `../../worker/` a partir do tarball instalado o caminho resolvia
 * para `<pkg>/worker/`, que NAO EXISTE (`dist/worker/` existe). Com o `cwd`
 * absoluto fora do manifesto (entrega de T1.3), esse default deixou de estar
 * mascarado e TODA a instalacao por npm arrancava com `assertExistingDirectory`
 * a lancar.
 *
 * PORQUE PUBLICAR `worker/**` EM VEZ DISTO NAO ERA CORRECCAO: o Node RECUSA
 * tirar tipos a `.ts` dentro de `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, medido em v24.15.0). Enviar o
 * fonte do worker no tarball so trocaria uma falha ruidosa no arranque por uma
 * falha de spawn mais tarde. E `dist/worker/` que tem de existir, e e ele que
 * este caminho tem de apontar.
 *
 * @param moduleUrl `import.meta.url` do modulo que resolve (parametrizado para
 * que os DOIS layouts sejam verificaveis sem publicar nada).
 */
function workerTreeLayout(moduleUrl: string): { readonly dir: string; readonly extension: string } {
  // O discriminador e a EXTENSAO deste proprio modulo: a arvore de fonte e
  // `.ts`, a arvore emitida e `.js` (o `rewriteRelativeImportExtensions` do
  // build garante-o). NAO se sonda o sistema de ficheiros a procura de qual dos
  // dois existe: escolher o que existir seria adivinhar, e esconderia um layout
  // errado em vez de o expor no arranque -- o oposto de "fail loud at load".
  //
  // O ENTRYPOINT muda de extensao com o layout exatamente como o diretorio muda
  // de profundidade: `worker/telegram-bot.ts` em dev, `dist/worker/telegram-bot.js`
  // publicado. Um so discriminador decide as duas coisas.
  const isEmittedTree = /\.[cm]?js$/u.test(new URL(moduleUrl).pathname)

  return {
    dir: isEmittedTree ? '../worker/' : '../../worker/',
    extension: isEmittedTree ? '.js' : '.ts',
  }
}

export function resolvePackagedWorkerDir(moduleUrl: string): string {
  return fileURLToPath(new URL(workerTreeLayout(moduleUrl).dir, moduleUrl))
}

/** Nome do modulo de entrada do worker, sem extensao (`worker/telegram-bot`). */
const WORKER_ENTRY_BASENAME = 'telegram-bot'

/**
 * Resolve o ENTRYPOINT do worker -- o ficheiro que vai para o `argv` do spawn.
 *
 * Mesma disciplina, mesma razao canonica (`09-DECISOES-CANONICAS.md:200`,
 * `01-ARQUITETURA.md:522`, `06-REPO-E-CI.md:283`):
 * *"O `argv` do spawn resolve `dist/worker/telegram-bot.js` relativo a
 * `import.meta.url`, nunca por `cwd`."*
 *
 *   carregado de | import.meta.url             | entrypoint
 *   -------------|-----------------------------|--------------------------------------
 *   fonte (dev)  | <repo>/src/config/schema.ts | <repo>/worker/telegram-bot.ts
 *   tarball      | <pkg>/dist/config/schema.js | <pkg>/dist/worker/telegram-bot.js
 *
 * @param moduleUrl `import.meta.url` do modulo que resolve (parametrizado para
 * que os DOIS layouts sejam verificaveis sem publicar nada).
 */
export function resolveWorkerEntrypoint(moduleUrl: string): string {
  const { dir, extension } = workerTreeLayout(moduleUrl)

  return fileURLToPath(new URL(`${dir}${WORKER_ENTRY_BASENAME}${extension}`, moduleUrl))
}

/** Diretorio `worker/` empacotado desta instalacao. */
export const PACKAGED_WORKER_DIR = resolvePackagedWorkerDir(import.meta.url)

/** Entrypoint do worker desta instalacao, para o `argv` do spawn. */
export const PACKAGED_WORKER_ENTRYPOINT = resolveWorkerEntrypoint(import.meta.url)

/**
 * Resolve o diretorio de trabalho efetivo do worker.
 *
 * NAO e um `?? valor_padrao` proibido por Q-3: `worker.cwd` nao participa de
 * autenticacao, bind, allowlist, TTL nem rate limit -- e a localizacao de um
 * ficheiro dentro do proprio pacote. A ausencia e benigna E VERIFICADA: o
 * caminho resolvido passa por `assertExistingDirectory` no arranque, tal como o
 * caminho explicito passava.
 */
export function resolveWorkerCwd(config: Config): string {
  const declared = config.worker.cwd
  if (typeof declared === 'string' && declared.trim().length > 0) return declared
  return PACKAGED_WORKER_DIR
}
