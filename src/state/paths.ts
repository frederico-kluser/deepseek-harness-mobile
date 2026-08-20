/**
 * =============================================================================
 * Onde vive o `state.json`, e com que modos ele nasce.
 * =============================================================================
 *
 * DONO: T2.5. Camada mais baixa do modulo: nao le nem escreve conteudo, so
 * decide CAMINHO e MODO. `schema.ts` decide FORMA; `store.ts` faz o IO.
 *
 * -----------------------------------------------------------------------------
 * DECISAO REGISTADA — `<$DSH_HOME|~/.dsh>/guarded-bot/state.json`,
 * e NAO `$XDG_STATE_HOME/dsh-guarded-bot/`.
 * -----------------------------------------------------------------------------
 * `03-ONDAS.md` 7 mandava o default XDG, dizendo que era "escolha nossa, nao
 * contrato do host". A Onda 0 REFUTOU essa premissa: o spike S9
 * (`docs/spikes/api-dsh.md`, VEREDITO S9 = CONFIRMADO) mediu que
 * o pacote `dsh-home-paths@0.1.0-rc.7` do escopo do harness — DEPENDENCIA
 * DIRETA DECLARADA do proprio `dsh@0.1.0-rc.7` — publica um contrato de
 * caminhos (espelho byte-a-byte em `types/dsh-home-paths/index.d.ts`):
 *
 *     DSH_HOME_DIR_NAME = '.dsh'        DSH_HOME_ENV = 'DSH_HOME'
 *     resolveDshHome(configured?, env?) // configurado > $DSH_HOME > ~/.dsh
 *     dshHomePath(...segments)          // junta segmentos a essa raiz
 *
 * e que `dsh-base@0.1.0-rc.7` de facto o usa no seu `cordis.patch.yml`
 * (`root: !!js dshHomePath('sessions')`). NAO existe diretorio por plugin nem
 * namespacing automatico: a raiz e do host, o segmento e do chamador.
 *
 * ESCOLHA: alinhar com o host. O estado deste plugin e dados de utilizador do
 * harness; parti-lo para uma segunda raiz XDG significaria que desinstalar o
 * DSH, mover `$DSH_HOME` para um disco cifrado ou fazer backup da "casa" do
 * harness deixaria para tras — invisivel — um ficheiro com o `secretDigest` e o
 * emparelhamento do dono. Uma raiz, um backup, um lugar para procurar.
 *
 * PORQUE E REPLICA E NAO IMPORT — duas razoes, ambas verificaveis por comando:
 *
 *   1. `src/dsh/adapter.ts` e o UNICO ficheiro do repositorio que pode importar
 *      um pacote do escopo do host (D1; o aceite da Onda 1 e um `grep -rl` por
 *      esse escopo sobre `src/`, que tem de devolver so ele — e a regra R2 do
 *      `eslint.config.js` transforma isso em erro de lint). Por isso nem o
 *      NOME do escopo se escreve aqui: o criterio de aceite e um grep literal,
 *      e um comentario tambem casa. T2.5 nao e dona do adaptador.
 *   2. `dsh-home-paths` esta em `devDependencies` — esta ali para
 *      espelhar `.d.ts`, nao para correr. Importa-lo em `src/**` obrigaria a
 *      promove-lo a `dependencies`, que e EXATAMENTE a dependencia de runtime
 *      nova que o aceite da Onda 2 proibe (`diff <(pnpm ls --prod --depth 0)
 *      docs/spikes/deps-baseline.txt`) — e `package.json` desta onda nao tem
 *      dono. Duas paredes independentes; nenhuma delas se contorna aqui.
 *
 * Logo: replica-se a PRECEDENCIA, em ~10 linhas puras, citando a fonte. O que
 * se replica esta abaixo, com as divergencias DELIBERADAS nomeadas uma a uma.
 * No dia em que o adaptador reexportar `dshHomePath`, este ficheiro troca a
 * replica pela chamada e os testes nao mudam.
 *
 * `$XDG_STATE_HOME` NAO entra na cadeia — e a divergencia face ao texto
 * original do plano. Se entrasse (mesmo abaixo de `$DSH_HOME`), numa maquina
 * Linux tipica com `XDG_STATE_HOME` definido pela sessao o estado cairia FORA
 * da casa do harness sem ninguem escolher isso, que e precisamente o que S9
 * mandou evitar. Uma variavel, uma raiz, sem ambiguidade.
 */

import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { StateError } from './schema.ts'

/* ========================================================================== */
/* Constantes replicadas do contrato do host                                  */
/* ========================================================================== */

/** Replica de `DSH_HOME_ENV` (`types/dsh-home-paths/index.d.ts`). */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Replica de `DSH_HOME_DIR_NAME` (`types/dsh-home-paths/index.d.ts`). */
export const DSH_HOME_DIR_NAME = '.dsh'

/** O segmento deste plugin sob a raiz do harness: `dshHomePath('guarded-bot')`. */
export const STATE_DIR_SEGMENT = 'guarded-bot'

/** Nome do ficheiro. Bate com `test/support/state-dir.ts` (prep-owned). */
export const STATE_FILE_NAME = 'state.json'

/** Diretorio: so o dono entra. */
export const STATE_DIR_MODE = 0o700

/** Ficheiro: so o dono le e escreve. */
export const STATE_FILE_MODE = 0o600

/**
 * Bits que EXPOEM o ficheiro a grupo e a outros.
 *
 * E esta a mascara do "mais frouxo que 0600" de `02-SEGURANCA.md` 8.2 item 7:
 * o que quebra a confidencialidade e qualquer bit de grupo/outros, nao o bit de
 * execucao do dono (0o100 num ficheiro de dados e esquisito, mas nao e um
 * caminho de leitura para ninguem). `0644 & 0o077 = 0o044` -> recusa;
 * `0600` e `0400` -> passam.
 */
export const EXPOSURE_MASK = 0o077

/* ========================================================================== */
/* Resolucao                                                                  */
/* ========================================================================== */

/** Ambiente injetavel. `process.env` satisfaz esta forma. */
export type StateEnv = Readonly<Record<string, string | undefined>>

/** Os dois caminhos que todo o modulo usa. Resolvidos UMA vez, no arranque. */
export interface StatePaths {
  /** Diretorio 0700 que contem o ficheiro E os temporarios da escrita atomica. */
  readonly dir: string
  /** O `state.json`, 0600. */
  readonly file: string
}

export interface ResolveStatePathsOptions {
  /** Raiz explicita do harness (maior precedencia), se a configuracao trouxer uma. */
  readonly configuredHome?: string | undefined
  /** Ambiente a consultar. Omitido = `process.env`. */
  readonly env?: StateEnv | undefined
}

/** `''`, `'   '` e `undefined` sao todos "ausente" — replica do JSDoc do host. */
function present(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function osHome(env: StateEnv): string {
  // `os.homedir()` em POSIX ja devolve `$HOME` quando definido; ler `env.HOME`
  // primeiro e o que torna a funcao PURA face ao ambiente injetado, sem mudar a
  // semantica no caminho real (`env` omitido == `process.env`).
  return present(env['HOME']) ?? homedir()
}

/**
 * Replica de `expandHomePath`.
 *
 * DIVERGENCIA DELIBERADA: o host tambem expande o prefixo `~\` (ele corre em
 * Windows). Este pacote declara `"os": ["linux", "darwin"]`, e em POSIX `~\foo`
 * e um NOME DE FICHEIRO legitimo — expandi-lo corromperia um caminho valido.
 */
export function expandHomePath(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

/**
 * Replica de `resolveDshHome`: configurado > `$DSH_HOME` > `~/.dsh`.
 *
 * DIVERGENCIA DELIBERADA: um caminho relativo e RECUSADO em vez de resolvido
 * contra o `cwd`. O host normaliza para absoluto; aqui isso seria fail-open
 * silencioso — o `cwd` de um plugin e o do processo que o carregou, e um
 * `DSH_HOME=dsh` faria o estado (com o `secretDigest`) aparecer e desaparecer
 * conforme o diretorio de onde o harness arrancou. Q-3: config invalida lanca.
 */
export function resolveDshHome(options: ResolveStatePathsOptions = {}): string {
  const env = options.env ?? process.env
  const home = osHome(env)

  const configured = present(options.configuredHome)
  if (configured !== undefined) return assertAbsolute(expandHomePath(configured, home), 'config.stateHome')

  const fromEnv = present(env[DSH_HOME_ENV])
  if (fromEnv !== undefined) return assertAbsolute(expandHomePath(fromEnv, home), `$${DSH_HOME_ENV}`)

  return assertAbsolute(join(home, DSH_HOME_DIR_NAME), '$HOME')
}

function assertAbsolute(path: string, origin: string): string {
  if (!isAbsolute(path)) {
    throw new StateError(
      'STATE_PATH_INVALID',
      `${origin} = ${JSON.stringify(path)} nao e um caminho absoluto. ` +
        'Um diretorio de estado relativo depende do `cwd` de quem arrancou o ' +
        'harness: o mesmo plugin leria estados diferentes conforme a pasta. ' +
        'Use um caminho absoluto (ou `~/...`).',
    )
  }
  return resolve(path)
}

/** Os caminhos de um diretorio de estado JA escolhido (e o que os testes injetam). */
export function statePathsAt(dir: string): StatePaths {
  const absolute = assertAbsolute(dir, 'diretorio de estado')
  return { dir: absolute, file: join(absolute, STATE_FILE_NAME) }
}

/** O caminho canonico: `<raiz do harness>/guarded-bot/state.json`. */
export function resolveStatePaths(options: ResolveStatePathsOptions = {}): StatePaths {
  return statePathsAt(join(resolveDshHome(options), STATE_DIR_SEGMENT))
}

/* ========================================================================== */
/* Criacao                                                                    */
/* ========================================================================== */

/**
 * Garante o diretorio com modo 0700, sem confiar no `umask`.
 *
 * TRES coisas que um `mkdirSync(dir, { recursive: true, mode: 0o700 })` sozinho
 * NAO faz:
 *
 *   1. `mode` no `mkdir` e mascarado pelo `umask` do processo, que so RETIRA
 *      bits: o efeito e `0700 & ~umask`, e o `umask` e do HOST, nao nosso. Com
 *      um `umask` agressivo (`0377`) o diretorio nasceria sem `x` e ficaria
 *      inutilizavel. O `chmod` a seguir nao e mascarado: e ele que fixa 0700.
 *   2. `mkdir -p` sobre um diretorio que JA existe nao mexe no modo dele. Um
 *      `guarded-bot/` deixado a 0755 por uma versao anterior ficaria aberto
 *      para sempre. Aqui aperta-se sempre.
 *   3. `mkdir -p` sobre um LINK SIMBOLICO que aponta para um diretorio existente
 *      tem sucesso silencioso — e a escrita seguinte iria parar ao alvo do
 *      link. `lstat` recusa esse caso.
 *
 * Apertar o modo do NOSSO diretorio e reparacao, nao degradacao silenciosa; o
 * FICHEIRO, esse, recusa-se a carregar (ver `store.ts`), porque um `state.json`
 * que ja esteve legivel por outros e um segredo que ja pode ter vazado, e isso
 * exige uma decisao humana, nao um `chmod` nosso.
 */
export function ensureStateDir(paths: StatePaths): void {
  // INSPECCIONA ANTES DE CRIAR. Ao contrario, um ficheiro regular no lugar do
  // diretorio saia daqui como `EEXIST` cru do `mkdir` — uma mensagem que nao
  // diz o que esta errado nem o que fazer.
  let stat = lstatSync(paths.dir, { throwIfNoEntry: false })
  if (stat === undefined) {
    // Os ANTECESSORES sao criados com o modo por omissao: `~/.dsh` e a casa do
    // HARNESS, nao nossa, e impor-lhe 0700 seria decidir por outro dono. So a
    // FOLHA (`guarded-bot/`) e nossa, e e essa que se fecha.
    mkdirSync(dirname(paths.dir), { recursive: true })
    mkdirSync(paths.dir, { recursive: true, mode: STATE_DIR_MODE })
    stat = lstatSync(paths.dir)
  }

  if (stat.isSymbolicLink()) {
    throw new StateError(
      'STATE_DIR_UNSAFE',
      `${paths.dir} e um link simbolico. O diretorio de estado tem de ser um ` +
        'diretorio real: por um link, quem controla o alvo controla onde o ' +
        '`secretDigest` e escrito.',
    )
  }
  if (!stat.isDirectory()) {
    throw new StateError('STATE_DIR_UNSAFE', `${paths.dir} existe e nao e um diretorio.`)
  }
  assertOwnedByUs(stat.uid, paths.dir)

  chmodSync(paths.dir, STATE_DIR_MODE)
}

/**
 * Recusa um caminho de estado que pertenca a outro utilizador.
 *
 * Ler estado escrito por outro uid e confiar na configuracao de seguranca de
 * uma conta que nao controlamos. `process.getuid` so existe em POSIX; o pacote
 * declara `"os": ["linux","darwin"]`, e onde a funcao nao existir a verificacao
 * simplesmente nao se aplica.
 */
export function assertOwnedByUs(uid: number, path: string): void {
  const ours = process.getuid?.()
  if (ours !== undefined && uid !== ours) {
    throw new StateError(
      'STATE_NOT_OWNED',
      `${path} pertence ao uid ${uid}, e este processo corre como uid ${ours}. ` +
        'Recusa-se a usar estado de outra conta.',
    )
  }
}
