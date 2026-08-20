/**
 * =============================================================================
 * O UNICO writer do `state.json` em todo o repositorio.
 * =============================================================================
 *
 * DONO: T2.5. Implementa `StateStore` de `src/contracts/state.ts` (CONGELADO no
 * COMMIT PREP 2). A invariante congelada com o contrato: T2.1 (`secretDigest`),
 * T2.3 (modo restrito), T3.1 (`tunnel.pid` para a varredura de orfao) e T5.1
 * (`desiredState`) passam TODAS por aqui. Verificavel por comando:
 * `grep -rn 'state.json' src worker bin` so pode mostrar `src/state/**`.
 *
 * -----------------------------------------------------------------------------
 * AS TRES GARANTIAS, e porque cada uma e escrita assim e nao de outra forma
 * -----------------------------------------------------------------------------
 *
 * 1. ESCRITA ATOMICA DE VERDADE.
 *    O temporario nasce em `paths.dir` — o MESMO diretorio do destino. Nao e
 *    detalhe: `rename(2)` so e atomico DENTRO do mesmo sistema de ficheiros, e
 *    um temporario em `os.tmpdir()` esta, na maquina tipica, noutro
 *    (`/tmp` em tmpfs, `$HOME` no disco). Ali, `rename` falha com `EXDEV` ou o
 *    runtime degrada para copiar-e-apagar, que e precisamente a escrita
 *    NAO-atomica que isto existe para evitar.
 *    A ordem e: escrever tudo -> `fchmod` 0600 -> `fsync` -> `close` ->
 *    `rename` -> `fsync` do DIRETORIO. O `fsync` ANTES do `rename` e o que faz
 *    com que a entrada nova nunca aponte para bytes que ainda estao em cache; o
 *    `fsync` do diretorio e o que torna o proprio `rename` duravel. Um leitor
 *    concorrente ve sempre o ficheiro velho INTEIRO ou o novo INTEIRO.
 *
 * 2. RECUSA CARREGAR COM MODO FROUXO (`02-SEGURANCA.md` 8.2 item 7).
 *    O modo e lido por `fstat` sobre o MESMO descritor de onde se le o conteudo
 *    — nao por um `stat` do caminho antes de abrir. Assim nao ha janela entre
 *    verificar e usar: o que foi verificado e o que foi lido. E abre-se com
 *    `O_NOFOLLOW`, para que um `state.json` substituido por um link simbolico
 *    de e para outro sitio de com `ELOOP` em vez de ser seguido em silencio.
 *    Recusa-se em vez de "corrigir com `chmod`": um ficheiro que esteve legivel
 *    por outros e um segredo que PODE ja ter sido lido, e apagar o vestigio com
 *    um chmod nosso tiraria ao dono a unica pista de que tem de rodar o segredo.
 *
 * 3. CORROMPIDO PARA, NUNCA "COMECA DO ZERO".
 *    A distincao e entre AUSENCIA e CORRUPCAO, e so ela: `ENOENT` (ficheiro
 *    nao existe) e primeiro arranque legitimo e devolve `emptyState()`; um
 *    ficheiro que EXISTE e nao le como estado valido — inclusive vazio — lanca
 *    `STATE_CORRUPT` com a mensagem acionavel de `schema.ts`. Recomecar do zero
 *    apagaria `secretDigest` e `pairing`: trocaria a senha e o dono do bot sem
 *    que ninguem tivesse pedido.
 *
 * -----------------------------------------------------------------------------
 * LIMITE CONHECIDO, escrito de proposito: um so PROCESSO.
 * -----------------------------------------------------------------------------
 * `update()` e read-modify-write. E atomico face a LEITORES (nunca ha ficheiro
 * meio escrito) e serializado dentro deste processo (o `update` reentrante
 * lanca). NAO ha lock entre processos: dois processos a chamar `update()` em
 * simultaneo podem perder a escrita do primeiro. A arquitetura nao tem esse
 * caso — o worker do Telegram fala com o plugin por IPC (`src/telegram/ipc.ts`)
 * e nao toca no disco — e um lockfile traria caducidade de lock obsoleto, que
 * e um modo de falha novo por um problema que nao existe. Se algum dia existir,
 * o sitio e aqui, e este paragrafo e o aviso.
 */

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

import type { PersistedState, StateStore } from '../contracts/state.ts'
import {
  EXPOSURE_MASK,
  STATE_FILE_MODE,
  assertOwnedByUs,
  ensureStateDir,
  resolveStatePaths,
  type ResolveStatePathsOptions,
  type StatePaths,
} from './paths.ts'
import {
  StateError,
  corruptStateError,
  emptyState,
  parsePersistedState,
  parseStateDocument,
  serializeStateDocument,
} from './schema.ts'

/**
 * Prefixo do temporario. Comeca por ponto para nao aparecer num `ls` distraido,
 * e traz o pid para que um temporario abandonado por um processo morto seja
 * identificavel sem adivinhacao.
 */
const TMP_PREFIX = '.state.json.tmp-'

/**
 * NOTA sobre o temporario que SOBRA depois de um crash.
 *
 * Se o processo morrer entre o `fsync` e o `rename` (e `test/unit/state/
 * crash.test.ts` mata-o exatamente ali), o temporario fica no disco. Isso e
 * deliberado e nao se varre no arranque: o ficheiro e o VESTIGIO de que houve
 * uma escrita interrompida, traz o pid de quem a comecou, nunca colide com
 * outro nome, e a leitura so alguma vez abre `state.json`. Apaga-lo no boot
 * seguinte destruiria a unica pista, para poupar bytes que ninguem conta.
 */

export interface StateStoreOptions extends ResolveStatePathsOptions {
  /**
   * Caminhos ja resolvidos. E por aqui que o teste injeta `makeTempStateDir()`
   * (`test/support/state-dir.ts`) sem mexer no ambiente do processo.
   */
  readonly paths?: StatePaths | undefined
  /**
   * PONTO DE INJECAO EXCLUSIVO DO TESTE DE CRASH, e nao um `hook` generico.
   *
   * Corre entre o `fsync` e o `rename`. A pergunta falsificavel 1 de
   * `03-ONDAS.md` 7 exige matar o processo NO MEIO da escrita e ler o ficheiro
   * depois — e "no meio" nao e observavel de fora sem um instante nomeado.
   * Em producao ninguem passa isto e a propriedade custa uma chamada opcional.
   */
  readonly beforeRename?: (() => void) | undefined
}

/** Q-2: tudo o que aloca recurso devolve disposer SINCRONO. */
export interface StateStoreHandle {
  readonly store: StateStore
  readonly paths: StatePaths
  /** Fecha o store: temporarios pendentes sao apagados e o uso seguinte lanca. */
  dispose(): void
}

function errnoOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`
}

/**
 * O item 7 de `02-SEGURANCA.md` 8.2, em codigo.
 *
 * A mensagem diz o que fazer E o que a permissao frouxa significa: o `chmod`
 * fecha a porta a partir de agora, nao desfaz uma leitura que ja tenha
 * acontecido. Por isso instrui tambem a rotacao — que e a unica coisa que
 * invalida um segredo possivelmente ja visto.
 */
export function assertNotExposed(mode: number, file: string): void {
  if ((mode & EXPOSURE_MASK) === 0) return
  throw new StateError(
    'STATE_MODE_TOO_OPEN',
    `${file} tem modo ${octal(mode)} e o exigido e ${octal(STATE_FILE_MODE)}: ` +
      'esta legivel por outras contas desta maquina e guarda o `secretDigest` ' +
      'e o emparelhamento do dono. O arranque RECUSA carregar (fail loud). ' +
      `Corrija com \`chmod 600 ${file}\` — e, porque o ficheiro esteve exposto, ` +
      'rode o segredo a seguir: o `chmod` fecha a porta, nao desfaz quem ja ' +
      'tenha entrado.',
  )
}

/**
 * Le, verifica e valida — nesta ordem, sobre um so descritor.
 *
 * `ENOENT` e `ENOTDIR` (o diretorio ainda nao existe) sao a AUSENCIA legitima:
 * primeiro arranque. Tudo o resto e uma falha que tem de ser vista.
 */
export function readStateFrom(paths: StatePaths): PersistedState {
  let fd: number | undefined
  let text: string
  try {
    // `O_NOFOLLOW`: um `state.json` trocado por link simbolico da `ELOOP` em vez
    // de ser seguido em silencio. As verificacoes correm sobre o descritor JA
    // ABERTO (`fstat`), e nao sobre o caminho — assim o que foi verificado e
    // exatamente o que e lido, sem janela entre uma coisa e a outra.
    fd = openSync(paths.file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      throw new StateError('STATE_DIR_UNSAFE', `${paths.file} existe e nao e um ficheiro regular.`)
    }
    assertOwnedByUs(stat.uid, paths.file)
    assertNotExposed(stat.mode, paths.file)
    text = readFileSync(fd, 'utf8')
  } catch (error) {
    // As nossas recusas ja tem codigo e mensagem: passam intactas.
    if (error instanceof StateError) throw error

    const code = errnoOf(error)
    // A UNICA ausencia legitima: o ficheiro (ou o diretorio) ainda nao existe.
    if (code === 'ENOENT' || code === 'ENOTDIR') return emptyState()
    if (code === 'ELOOP') {
      throw new StateError(
        'STATE_DIR_UNSAFE',
        `${paths.file} e um link simbolico. Um estado por link deixa quem ` +
          'controla o alvo escolher de onde se le o `secretDigest`; recusa-se.',
      )
    }
    throw new StateError('STATE_READ_FAILED', `nao foi possivel ler ${paths.file}: ${messageOf(error)}`)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return parseStateDocument(text, paths.file)
}

/** Apaga um temporario sem transformar a limpeza numa segunda falha. */
function discard(tmp: string): void {
  try {
    unlinkSync(tmp)
  } catch (error) {
    // Ja nao existir e o caso NORMAL (o `rename` consumiu-o). Qualquer outra
    // causa nao pode mascarar o erro real que trouxe o fluxo ate aqui.
    void error
  }
}

/**
 * Torna o proprio `rename` duravel.
 *
 * Sem isto, os bytes do ficheiro estao no disco (garantido pelo `fsync` do
 * ficheiro) mas a ENTRADA DE DIRETORIO que lhes da o nome pode nao estar. Nem
 * todos os sistemas de ficheiros e plataformas suportam `fsync` num descritor
 * de diretorio; onde nao suportam, a falha e informativa e nao muda o
 * resultado ja escrito — por isso e engolida DE PROPOSITO, e so aqui.
 *
 * Exportada para que os dois caminhos engolidos sejam EXERCIDOS por teste: uma
 * excepcao que ninguem consegue provocar num teste e uma excepcao que ninguem
 * sabe se esta escrita ao contrario.
 */
export function syncDirectory(dir: string): void {
  let fd: number
  try {
    fd = openSync(dir, constants.O_RDONLY)
  } catch (error) {
    void error
    return
  }
  try {
    fsyncSync(fd)
  } catch (error) {
    void error
  } finally {
    closeSync(fd)
  }
}

export function createStateStore(options: StateStoreOptions = {}): StateStoreHandle {
  const paths = options.paths ?? resolveStatePaths(options)
  const pending = new Set<string>()
  let disposed = false
  let updating = false

  function assertLive(): void {
    if (disposed) {
      throw new StateError(
        'STATE_STORE_DISPOSED',
        'este StateStore ja foi disposto. Depois do disposer, ler ou escrever ' +
          'estado e um uso-apos-libertacao: obtenha um store novo.',
      )
    }
  }

  function writeAtomic(payload: string): void {
    const tmp = join(paths.dir, `${TMP_PREFIX}${process.pid.toString(36)}-${randomBytes(6).toString('hex')}`)
    pending.add(tmp)
    try {
      const fd = openSync(
        tmp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        STATE_FILE_MODE,
      )
      try {
        const buffer = Buffer.from(payload, 'utf8')
        // `writeSync` pode escrever menos do que se pediu (escrita parcial); o
        // laco e o que impede um ficheiro truncado que passaria despercebido.
        let written = 0
        while (written < buffer.byteLength) {
          written += writeSync(fd, buffer, written, buffer.byteLength - written)
        }
        // O `mode` do `open` passa pelo `umask` do HOST, que so RETIRA bits:
        // com `umask 0177` o ficheiro nasceria 0400 e a escrita SEGUINTE
        // falharia. O `fchmod` nao e mascarado — fixa exatamente 0600, nem
        // mais aberto nem mais fechado — e corre ANTES do `fsync` para que o
        // modo seja tao duravel quanto os bytes.
        fchmodSync(fd, STATE_FILE_MODE)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }

      options.beforeRename?.()

      renameSync(tmp, paths.file)
      pending.delete(tmp)
      syncDirectory(paths.dir)
    } catch (error) {
      discard(tmp)
      pending.delete(tmp)
      if (error instanceof StateError) throw error
      throw new StateError(
        'STATE_WRITE_FAILED',
        `falhou a escrita atomica de ${paths.file}: ${messageOf(error)}. ` +
          'O ficheiro de destino NAO foi alterado — o `rename` so acontece ' +
          'depois de o temporario estar completo e sincronizado.',
      )
    }
  }

  const store: StateStore = {
    read(): PersistedState {
      assertLive()
      return readStateFrom(paths)
    },

    update(fn: (state: PersistedState) => PersistedState): void {
      assertLive()
      if (updating) {
        throw new StateError(
          'STATE_REENTRANT_UPDATE',
          'update() foi chamado de dentro do proprio callback de update(). A ' +
            'escrita de fora sobrepor-se-ia a de dentro e a alteracao interna ' +
            'desaparecia sem erro. Componha as alteracoes num so callback.',
        )
      }
      updating = true
      try {
        ensureStateDir(paths)
        const current = readStateFrom(paths)
        // `unknown`, e nao `PersistedState`: o valor vem de FORA. O tipo do
        // callback e uma promessa do compilador sobre codigo que o compilador
        // ve — e o unico writer do `state.json` nao aposta nisso.
        const next: unknown = fn(current)
        if (next === undefined || next === null) {
          throw corruptStateError(
            paths.file,
            'o callback de update() nao devolveu estado nenhum (esqueceu-se do `return`?)',
          )
        }
        // O unico writer valida tambem a SAIDA: se nao o fizesse, seria o unico
        // ponto por onde lixo entra no ficheiro sem ninguem ver.
        writeAtomic(serializeStateDocument(parsePersistedState(next, `${paths.file} (valor devolvido por update())`)))
      } finally {
        updating = false
      }
    },
  }

  return {
    store,
    paths,
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const tmp of pending) discard(tmp)
      pending.clear()
    },
  }
}
