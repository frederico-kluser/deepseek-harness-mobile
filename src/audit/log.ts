/**
 * Log de auditoria append-only, 0600, FORA do workspace e FORA do Telegram.
 * DONO: T2.4. Implementa `AuditSink` (`../contracts/auth.ts`, congelado).
 *
 * NAO NO TELEGRAM: o bot e canal de NOTIFICACAO -- mensagens apagaveis pelo dono,
 * ordenadas pelo servidor de outra pessoa, e o Telegram e das coisas que este
 * plugin audita quando falha. Um registo que vive dentro do sistema que audita
 * nao e um registo; `./notify.ts` (T5.4) notifica sempre DEPOIS do log. NAO NO
 * WORKSPACE: ele e servido pela Web UI e commitado, e um ficheiro com as
 * tentativas de autenticacao e os IPs la dentro e uma fuga a espera de suceder.
 *
 * APPEND-ONLY A SERIO: `O_WRONLY | O_CREAT | O_APPEND`. Com `O_APPEND` o nucleo
 * posiciona a escrita no FIM DENTRO da propria `write(2)` -- sem "procurar o fim,
 * depois escrever", logo sem janela para outro processo se meter. Ao contrario
 * de um `writeFile`, que abre com `O_TRUNC` e apaga a prova em silencio.
 *
 * DISCO CHEIO: FECHA (fail-closed). Justificacao em {@link AuditWriteError}.
 *
 * SEM ROTACAO, com um numero atras: quem alimenta este ficheiro e o caminho de
 * autenticacao, atras do limitador de T2.3 -- 100 falhas consecutivas ativam o
 * modo restrito e derrubam a exposicao, ~18 KB antes de a torneira fechar. Ter
 * rotacao seria dar a este ficheiro a unica primitiva que ele existe para nao
 * ter: uma que apaga bytes ja escritos. */

import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import type { AuditEvent, AuditSink } from '../contracts/auth.ts'
import { formatAuditLine } from './format.ts'

/** Subdiretorio deste plugin sob a raiz do host. O MESMO que guarda o estado. */
export const AUDIT_DIR_NAME = 'guarded-bot'
/** Nome do ficheiro. Estavel: ha operadores a apontar `tail -F` para ele. */
export const AUDIT_FILE_NAME = 'audit.log'
/** Modos: nem grupo nem outros, nem sequer leitura. */
export const AUDIT_FILE_MODE = 0o600
export const AUDIT_DIR_MODE = 0o700

/**
 * Raiz do host, REPLICADA -- nao importada: o helper de caminhos vive no escopo
 * do harness, e a fronteira com esse escopo e `src/dsh/adapter.ts` e so ela (D1).
 * `src/state/paths.ts` replica o mesmo e tambem nao e importado daqui.
 * VALORES MEDIDOS: `docs/spikes/api-dsh.md` (veredito S9) leu as constantes e o
 * JSDoc do helper do host -- `.dsh`, `DSH_HOME`, precedencia
 * `configurado > $DSH_HOME > ~/.dsh`, com `$DSH_HOME` vazio tratado como ausente.
 * Espelho em `types/dsh-home-paths/index.d.ts`, sha256 no `pnpm test:contract`.
 */
const HOST_HOME_DIR_NAME = '.dsh'
const HOST_HOME_ENV = 'DSH_HOME'

/**
 * Nome do evento sintetico que marca uma LACUNA no registo.
 *
 * >>> PARA T5.4: tem de entrar no vocabulario fechado de `./events.ts`, escrito
 * >>> com sufixo `:<n>` (registos perdidos) -- reconhecido por PREFIXO.
 *
 * Sem ele, disco cheio deixa um salto de tempo e mais nada, e quem ler nao
 * distingue "ninguem tentou" de "nao deu para registar". */
export const EVENTO_LACUNA = 'auditoria_lacuna'

/**
 * Move o ficheiro para outro volume. PORQUE E UM BOTAO: com fail-closed, encher
 * o volume onde vive o log fecha o gate -- e uma decisao dura sem mitigacao
 * operacional e so uma decisao dura. */
export const AUDIT_PATH_ENV = 'DSH_GUARD_AUDIT_LOG'

/**
 * `O_NOFOLLOW`: se `audit.log` for um SYMLINK o `open` falha com `ELOOP` em vez
 * de escrever no alvo. Sem ele, apontar o nome para `~/.ssh/authorized_keys`
 * fazia este modulo acrescentar linhas la -- e o `fstat` nao apanhava nada,
 * porque o modo verificado seria o do ALVO. */
const OPEN_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW

/**
 * Falha ao ABRIR o log. Q-3 deste repositorio: *fail loud at load*.
 *
 * Um plugin de seguranca que arranca sem conseguir registar arranca cego. As
 * condicoes -- caminho relativo, dentro do workspace, modo mais frouxo que 0600,
 * symlink, alvo nao regular, diretorio frouxo -- sao de CONFIGURACAO e resolvem-se
 * antes do primeiro pedido: falhar alto custa uma mensagem no arranque, falhar
 * baixo custa descobrir seis meses depois que o log era 0644. A mensagem CONTEM
 * caminhos de proposito -- stderr do operador, nunca um corpo HTTP. */
export class AuditOpenError extends Error {
  override readonly name = 'AuditOpenError'
}

/**
 * Falha ao ESCREVER no log. E a resposta a pergunta do disco cheio.
 *
 * ============================ FAIL-CLOSED ============================
 * `append()` LANCA. Nao engole nem "regista em memoria e continua": quem chama e
 * o caminho de autenticacao, e a excecao e o sinal de que a decisao que ele
 * acabou de tomar NAO ficou registada -- para um gate isso tem de significar
 * negar. `03-ONDAS.md:1632` exige-o literalmente. PORQUE NAO fail-open:
 *
 *   1. ASSIMETRIA. Explorar o fail-closed exige encher o disco da maquina, e
 *      quem escreve no disco ja executa codigo la dentro -- ponto em que este
 *      plugin ja nao e a defesa relevante. O fail-open so exige ESPERAR que o
 *      disco encha e atacar remotamente, sem deixar uma linha: e uma janela de
 *      forca bruta INVISIVEL nascida de uma falha de recurso.
 *   2. E LITERALMENTE A ENTREGA. "Registra TODA tentativa de auth"; um sink que
 *      serve pedidos que nao consegue registar nao esta degradado -- esta a
 *      mentir sobre a sua unica funcao.
 *   3. O CUSTO E RECUPERAVEL, o do fail-open nao. Disco cheio arranja-se na
 *      maquina e o dono TEM a maquina; uma janela de forca bruta sem registo
 *      nao se arranja, porque os bytes nunca existiram.
 *
 * NAO E o lockout permanente que T2.3 rejeita: aquele e disparado por um
 * ATACANTE (auto-DoS remoto), este pelo ESTADO DO HOST, que nenhum pedido remoto
 * controla, e desaparece assim que houver espaco -- {@link AuditLog.append}
 * volta a tentar em cada chamada, sem latch.
 * =====================================================================
 *
 * >>> COSTURA PARA O PREP DA ONDA 3: a `message` e generica e o caminho vive em
 * >>> {@link AuditWriteError.path}, NAO APRESENTAVEL. D9 exige `401` de corpo
 * >>> identico em toda falha de autenticacao; propagar isto em cru daria um
 * >>> `500` com texto proprio -- oraculo, e com topologia de disco dentro.
 */
export class AuditWriteError extends Error {
  override readonly name = 'AuditWriteError'
  /** Registos que ja se perderam nesta janela de falha. */
  readonly perdidos: number
  /** NAO APRESENTAVEL: topologia de disco. Para o log do operador, nunca HTTP. */
  readonly path: string

  // Campos a mao: strip-only mode recusa parameter properties.
  constructor(message: string, perdidos: number, path: string, options?: { cause?: unknown }) {
    super(message, options)
    this.perdidos = perdidos
    this.path = path
  }
}

/** Assinatura da escrita, para o teste simular `ENOSPC` sem encher o disco. */
export type WriteSyscall = (fd: number, data: Uint8Array) => number

export interface AuditLogOptions {
  /** Caminho absoluto do ficheiro. Omitido: {@link resolveAuditLogPath}. */
  readonly path?: string
  /** Relogio injetavel (`04-TESTES.md` 8.1). Omitido: `Date.now`. */
  readonly now?: () => number
  /**
   * FORNECEDOR de literais a mascarar, avaliado a cada escrita: o segredo roda e
   * o URL do tunel muda a cada arranque, logo uma lista capturada na abertura
   * fica obsoleta no instante em que passa a importar. */
  readonly secrets?: () => readonly string[]
  /** Raiz proibida. Omitido: `process.cwd()`. Ver o cabecalho do modulo. */
  readonly workspaceRoot?: string
  /**
   * `fsync` a cada linha. DESLIGADO por omissao: e uma ida ao disco no caminho de
   * autenticacao, e T2.3 exige tempo de resposta INDISTINGUIVEL entre sucesso e
   * falha -- latencia de I/O variavel ali e um oraculo. O que se perde sem ele e
   * a janela do page cache num corte de energia. */
  readonly fsyncEachWrite?: boolean
  /** Costura de teste. Ver {@link WriteSyscall}. */
  readonly write?: WriteSyscall
}

export interface AuditLog extends AuditSink {
  /** Caminho efetivo, ja resolvido. */
  readonly path: string
  /** Escreve UMA linha. LANCA {@link AuditWriteError} se nao conseguir. */
  append(event: AuditEvent): void
  /** Registos perdidos desde a ultima escrita bem sucedida. `0` = log intacto. */
  perdidos(): number
  /**
   * Disposer SINCRONO (Q-2), e pode se-lo sem perder nada: `writeSync` e uma
   * chamada ao sistema direta, sem buffer em espaco de utilizador. Idempotente:
   * o segundo `dispose` nao fecha um descritor que ja e de outra pessoa. */
  dispose(): void
}

/** `undefined` quando ausente, vazio ou so espacos -- "em branco e' por definir". */
function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/** `~` e `~/x`, como o helper do host. Nao expande `~outro-utilizador`. */
function expandTilde(value: string, home: string): string {
  if (value === '~') return home
  return value.startsWith(`~${sep}`) ? join(home, value.slice(2)) : value
}

/** Exige absoluto: resolver um relativo contra o `cwd` e como o log ia parar no workspace. */
function requireAbsolute(value: string, origem: string): string {
  if (!isAbsolute(value)) {
    throw new AuditOpenError(`${origem} tem de ser um caminho absoluto, e nao ${value}`)
  }
  return resolve(value)
}

/**
 * `$DSH_GUARD_AUDIT_LOG`, senao `<raiz do host>/guarded-bot/audit.log`, com a
 * raiz na precedencia do host: configurada > `$DSH_HOME` > `~/.dsh`.
 *
 * NOTA DE FRONTEIRA: e DELIBERADAMENTE a mesma raiz e o mesmo subdiretorio que
 * T2.5 usa para o `state.json`, e nao por simetria -- fazer backup da raiz do
 * host, ou move-la para um disco cifrado, tem de levar o log que regista todas
 * as tentativas de autenticacao do dono; noutra arvore ele fica para tras,
 * invisivel, na operacao em que o dono julga levar tudo. Se a raiz mudar, muda
 * nos DOIS ficheiros -- {@link HOST_HOME_DIR_NAME} diz porque nao se importa. */
export function resolveAuditLogPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
  configuredHome?: string,
): string {
  const override = nonBlank(env[AUDIT_PATH_ENV])
  if (override !== undefined) {
    return requireAbsolute(expandTilde(override, home), `$${AUDIT_PATH_ENV}`)
  }

  const configurada = nonBlank(configuredHome)
  const doAmbiente = nonBlank(env[HOST_HOME_ENV])
  let raiz: string
  if (configurada !== undefined) {
    raiz = requireAbsolute(expandTilde(configurada, home), 'a raiz do host configurada')
  } else if (doAmbiente !== undefined) {
    raiz = requireAbsolute(expandTilde(doAmbiente, home), `$${HOST_HOME_ENV}`)
  } else {
    raiz = join(home, HOST_HOME_DIR_NAME)
  }

  return join(raiz, AUDIT_DIR_NAME, AUDIT_FILE_NAME)
}

/** Abre (ou cria) o log. LANCA {@link AuditOpenError} -- *fail loud at load*. */
export function openAuditLog(options: AuditLogOptions = {}): AuditLog {
  // NAO se resolve um caminho relativo contra o `cwd`: resolver em silencio e
  // exatamente como o log iria parar DENTRO do workspace sem ninguem o pedir.
  const raw = options.path ?? resolveAuditLogPath()
  const now = options.now ?? Date.now
  const secrets = options.secrets ?? emptySecrets
  const write = options.write ?? defaultWrite
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd())

  const path = requireAbsolute(raw, 'o caminho do log de auditoria')
  assertOutsideWorkspace(path, workspaceRoot)

  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: AUDIT_DIR_MODE })
  assertDirIsOurs(dir)

  let fd: number
  try {
    fd = openSync(path, OPEN_FLAGS, AUDIT_FILE_MODE)
  } catch (cause) {
    const errno = (cause as NodeJS.ErrnoException).code
    const pista = errno === 'ELOOP' ? ' (ha um SYMLINK no lugar do ficheiro)' : ''
    throw new AuditOpenError(`nao foi possivel abrir ${path} para acrescentar${pista}`, { cause })
  }
  try {
    // O modo e verificado no DESCRITOR e nunca no caminho: entre um `stat` e o
    // `open` cabe uma troca de ficheiro, e um `stat` responde sobre um NOME. O
    // `fstat` responde sobre o objeto em que vamos mesmo escrever.
    assertOwnerOnly(fstatSync(fd).mode, path)
  } catch (cause) {
    closeSync(fd)
    throw cause
  }

  let closed = false
  let perdidos = 0

  const emitir = (line: string): void => {
    const buffer = Buffer.from(line, 'utf8')
    let written = 0
    try {
      // UMA linha, UM `write`: e a escrita unica sobre um descritor `O_APPEND`
      // que impede dois processos de intercalar meias linhas. O ciclo so existe
      // para o caso patologico da escrita curta.
      while (written < buffer.length) {
        const n = write(fd, written === 0 ? buffer : buffer.subarray(written))
        if (n <= 0) throw new Error(`escrita curta sem progresso (${String(n)} bytes)`)
        written += n
      }
    } catch (cause) {
      // So repara se ficou MESMO meia linha. Um `ENOSPC` limpo escreve zero
      // bytes -- o caso normal de um FS cheio -- e acrescentar um `\n` ai poria
      // uma linha VAZIA por falha, contra o "uma linha e uma linha".
      if (written > 0) repairTornLine(fd, write)
      throw cause
    }
    if (options.fsyncEachWrite === true) fsyncSync(fd)
  }

  return {
    path,

    append(event: AuditEvent): void {
      if (closed) throw new AuditWriteError('log de auditoria ja fechado', perdidos, path)

      const ts = now()
      try {
        if (perdidos > 0) {
          // A lacuna vem ANTES do registo que a fechou: "faltam N" e so depois
          // "aconteceu isto", que e a ordem em que um humano precisa de a ler.
          const lacuna = perdidos
          const evento = `${EVENTO_LACUNA}:${String(lacuna)}`
          emitir(formatAuditLine({ evento, resultado: 'negado' }, ts, secrets()))
          perdidos = 0
        }
        emitir(formatAuditLine(event, ts, secrets()))
      } catch (cause) {
        perdidos += 1
        throw new AuditWriteError(
          `nao foi possivel registar a auditoria — o gate TEM de negar (fail-closed). ` +
            `Registos perdidos nesta janela: ${String(perdidos)}.`,
          perdidos,
          path,
          { cause },
        )
      }
    },

    perdidos: (): number => perdidos,

    dispose(): void {
      if (closed) return
      closed = true
      closeSync(fd)
    },
  }
}

/** Fornecedor vazio, isolado para nao alocar um array novo por escrita. */
const NO_SECRETS: readonly string[] = []
function emptySecrets(): readonly string[] {
  return NO_SECRETS
}

function defaultWrite(fd: number, data: Uint8Array): number {
  return writeSync(fd, data)
}

/** Fecha com `\n` a meia linha, para o registo seguinte nao se colar ao fragmento. */
function repairTornLine(fd: number, write: WriteSyscall): void {
  try {
    write(fd, Buffer.from('\n', 'utf8'))
  } catch (falhaDaReparacao) {
    // Sem accao deliberadamente: quem chama ja vai receber o `AuditWriteError`
    // com a causa real, e encadear uma segunda excecao esconderia a primeira.
    void falhaDaReparacao
  }
}

function assertOutsideWorkspace(path: string, workspaceRoot: string): void {
  if (path === workspaceRoot || path.startsWith(workspaceRoot + sep)) {
    throw new AuditOpenError(
      `o log de auditoria nao pode ficar dentro do workspace (${workspaceRoot}): ${path}. ` +
        `O workspace e servido pela Web UI e versionado em git. ` +
        `Defina ${AUDIT_PATH_ENV} ou ${HOST_HOME_ENV} para fora dele.`,
    )
  }
}

/**
 * O diretorio deste plugin tem de ser so nosso: um bit para grupo ou outros
 * deixa qualquer processo RENOMEAR o `audit.log` e por outro no lugar, e o modo
 * 0600 do ficheiro nao defende disso -- quem manda no nome e o diretorio.
 * Verifica-se ESTE subdiretorio, nunca a raiz do host, que e casa alheia. */
function assertDirIsOurs(dir: string): void {
  const st = lstatSync(dir)
  if (st.isSymbolicLink()) {
    throw new AuditOpenError(`${dir} e um symlink — recuso guardar o log atras de um redirecionamento`)
  }
  if ((st.mode & 0o077) !== 0) {
    throw new AuditOpenError(
      `o diretorio ${dir} esta aberto a grupo/outros (${(st.mode & 0o777).toString(8)}). ` +
        `Corrija com: chmod 700 ${dir}`,
    )
  }
}

/**
 * Recusa bits fora de `rw` do dono (`02-SEGURANCA.md` 8.2 item 7): um log
 * legivel por todos entrega IPs e hashes de sessao a toda a maquina. */
function assertOwnerOnly(mode: number, path: string): void {
  const bits = mode & 0o777
  if ((bits & 0o177) !== 0) {
    throw new AuditOpenError(
      `modo ${bits.toString(8).padStart(4, '0')} e mais frouxo que 0600 em ${path}. ` +
        `Corrija com: chmod 600 ${path}`,
    )
  }
}
