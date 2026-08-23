/**
 * =============================================================================
 * A FORMA do `state.json` (`version: 1`), a migracao, e a familia de erros.
 * =============================================================================
 *
 * DONO: T2.5. Implementa `PersistedState` de `src/contracts/state.ts`
 * (CONGELADO no COMMIT PREP 2 — leitura livre, escrita proibida).
 *
 * PORQUE A VALIDACAO E ESTRITA, CAMPO A CAMPO, E NAO UM `as PersistedState`.
 * Este ficheiro guarda o `secretDigest` (a senha do dono, em hash) e o
 * `pairing` (quem manda no bot). Um `JSON.parse(...) as PersistedState` daria
 * ao compilador uma certeza que o disco nao tem: qualquer edicao a mao, qualquer
 * escrita parcial de uma versao anterior, qualquer ficheiro trocado entrava
 * como se fosse valido e so rebentava — ou pior, NAO rebentava — tres camadas
 * a frente. Aqui, o que nao casa exatamente com a forma, LANCA.
 *
 * PORQUE CHAVE DESCONHECIDA E ERRO, e nao "ignora-se". `store.update()` reescreve
 * o ficheiro INTEIRO a partir do que este modulo devolve. Se uma chave que nao
 * conhecemos fosse silenciosamente descartada na leitura, a primeira escrita a
 * seguir APAGAVA-A do disco. E para isso que serve o `version`: a mudanca de
 * forma passa por uma migracao escrita, nao por tolerancia silenciosa.
 *
 * PORQUE UMA CLASSE DE ERRO PROPRIA e nao um codigo novo em `src/errors.ts`:
 * `GuardErrorCode` e a uniao dos codigos da BARREIRA e `src/errors.ts` nao e
 * ficheiro desta sub-tarefa (`03-ONDAS.md` 7: T2.5 possui `src/state/**`).
 * `StateError` vive na camada mais baixa do modulo para que `paths.ts` e
 * `store.ts` a possam lancar sem ciclo de import.
 *
 * Strip-only mode (`node --test` corre estes `.ts` sem os compilar): sem `enum`,
 * sem `namespace`, sem parameter properties. O `code` e campo atribuido a mao.
 */

import type { PersistedState } from '../contracts/state.ts'
import { BrandError, toSecretDigest } from '../brand.ts'
import { PLUGIN_NAME } from '../errors.ts'

/* ========================================================================== */
/* Erros                                                                      */
/* ========================================================================== */

/** Codigos estaveis. O operador distingue a causa sem ler prosa. */
export type StateErrorCode =
  /** Caminho de estado inutilizavel (relativo, por exemplo). */
  | 'STATE_PATH_INVALID'
  /** O diretorio de estado nao e um diretorio real nosso (link, ficheiro). */
  | 'STATE_DIR_UNSAFE'
  /** O `state.json` esta legivel por grupo/outros: recusa-se a carregar. */
  | 'STATE_MODE_TOO_OPEN'
  /** O caminho de estado pertence a outro utilizador. */
  | 'STATE_NOT_OWNED'
  /** O conteudo existe e nao e um estado valido. NUNCA se recomeca do zero. */
  | 'STATE_CORRUPT'
  /** Escrito por uma versao do plugin que este binario nao sabe ler. */
  | 'STATE_VERSION_UNSUPPORTED'
  /** A escrita atomica falhou; o ficheiro de destino nao foi tocado. */
  | 'STATE_WRITE_FAILED'
  /** O ficheiro existe e nao foi possivel abri-lo (EACCES, EIO, ...). */
  | 'STATE_READ_FAILED'
  /** Uso depois do disposer sincrono (Q-2). */
  | 'STATE_STORE_DISPOSED'
  /** `update()` chamado de dentro do proprio callback de `update()`. */
  | 'STATE_REENTRANT_UPDATE'

export class StateError extends Error {
  override readonly name = 'StateError'
  readonly code: StateErrorCode

  constructor(code: StateErrorCode, detail: string) {
    super(`[${PLUGIN_NAME}] ${code}: ${detail}`)
    this.code = code
  }
}

/**
 * A mensagem ACIONAVEL do estado corrompido.
 *
 * `02-SEGURANCA.md` 9 e explicito sobre o anti-padrao: "recriar em silencio:
 * geraria segredo novo sem o dono saber". Recomecar do zero apagaria o
 * `secretDigest` e o `pairing` — na pratica, trocaria a senha do dono e o dono
 * do bot sem que ninguem tenha pedido. Logo: para-se, diz-se ONDE, PORQUE e
 * QUAL e o passo seguinte, e o apagar e um ato DELIBERADO de um humano.
 *
 * O conteudo do ficheiro NUNCA entra na mensagem (Q-4): ela vai para o log do
 * host, ao lado do de outros plugins.
 */
export function corruptStateError(source: string, reason: string): StateError {
  return new StateError(
    'STATE_CORRUPT',
    `${source} existe mas nao e um estado valido: ${reason}. ` +
      'O arranque PARA aqui de proposito — recomecar do zero apagaria o ' +
      '`secretDigest` e o `pairing`, ou seja, trocaria a senha e o dono do bot ' +
      'sem ninguem pedir. Inspeccione o ficheiro, guarde uma copia, e so entao ' +
      `apague-o deliberadamente (\`rm ${source}\`) e volte a correr o ` +
      'onboarding para gerar um segredo novo.',
  )
}

/* ========================================================================== */
/* A forma                                                                    */
/* ========================================================================== */

/** A unica versao que este binario escreve. */
export const CURRENT_STATE_VERSION = 1

/** Chaves de topo conhecidas. Qualquer outra e erro (ver o cabecalho). */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'version',
  'secretDigest',
  'desiredState',
  'restricted',
  'tunnel',
  'pairing',
  'provider',
])

/**
 * O estado de um primeiro arranque.
 *
 * `desiredState: 'STOPPED'` e fail-closed: um plugin instalado de fresco NAO
 * abre exposicao nenhuma antes de alguem mandar. `READY` por omissao seria
 * subir tunel a primeira vez que o harness arrancasse.
 */
export function emptyState(): PersistedState {
  return { version: CURRENT_STATE_VERSION, desiredState: 'STOPPED' }
}

/* -------------------------------------------------------------------------- */
/* Assertores primitivos                                                      */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown, source: string, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw corruptStateError(source, `${path} tinha de ser um objeto`)
  }
  return value as Record<string, unknown>
}

function asInteger(value: unknown, source: string, path: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw corruptStateError(source, `${path} tinha de ser um inteiro >= ${min}`)
  }
  return value
}

function asLiteral<T extends string>(
  value: unknown,
  allowed: readonly T[],
  source: string,
  path: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw corruptStateError(source, `${path} tinha de ser um de ${allowed.map((v) => `'${v}'`).join(' | ')}`)
  }
  return value as T
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  known: ReadonlySet<string>,
  source: string,
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw corruptStateError(
        source,
        `${path} tem a chave desconhecida ${JSON.stringify(key)} — a proxima ` +
          'escrita apaga-la-ia, portanto o arranque para em vez de a descartar',
      )
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Sub-objetos                                                                */
/* -------------------------------------------------------------------------- */

const RESTRICTED_KEYS: ReadonlySet<string> = new Set(['since', 'reason'])
const TUNNEL_KEYS: ReadonlySet<string> = new Set(['pid', 'startedAt', 'mode'])
const PAIRING_KEYS: ReadonlySet<string> = new Set(['ownerUserId', 'ownerChatId', 'pairedAt'])

function parseRestricted(value: unknown, source: string): PersistedState['restricted'] {
  const record = asRecord(value, source, 'restricted')
  rejectUnknownKeys(record, RESTRICTED_KEYS, source, 'restricted')
  return {
    since: asInteger(record['since'], source, 'restricted.since', 0),
    reason: asLiteral(record['reason'], ['brute-force-ceiling'], source, 'restricted.reason'),
  }
}

function parseTunnel(value: unknown, source: string): PersistedState['tunnel'] {
  const record = asRecord(value, source, 'tunnel')
  rejectUnknownKeys(record, TUNNEL_KEYS, source, 'tunnel')
  return {
    // pid >= 1: `0` designaria o GRUPO do proprio processo e `-1` TODOS os
    // processos. A varredura de orfao de `02-SEGURANCA.md` 9 mata este pid.
    pid: asInteger(record['pid'], source, 'tunnel.pid', 1),
    startedAt: asInteger(record['startedAt'], source, 'tunnel.startedAt', 0),
    mode: asLiteral(record['mode'], ['quick', 'named'], source, 'tunnel.mode'),
  }
}

function parsePairing(value: unknown, source: string): PersistedState['pairing'] {
  const record = asRecord(value, source, 'pairing')
  rejectUnknownKeys(record, PAIRING_KEYS, source, 'pairing')
  return {
    ownerUserId: asInteger(record['ownerUserId'], source, 'pairing.ownerUserId', 1),
    // NAO ha piso: um `chat_id` de grupo/supergrupo do Telegram e NEGATIVO
    // (`-100...`). Exigir > 0 aqui recusaria um emparelhamento legitimo.
    ownerChatId: asInteger(record['ownerChatId'], source, 'pairing.ownerChatId', Number.MIN_SAFE_INTEGER),
    pairedAt: asInteger(record['pairedAt'], source, 'pairing.pairedAt', 0),
  }
}

/**
 * Le o `provider` persistido como o enum FECHADO do contrato (D3).
 *
 * AUSENTE NAO E ERRO: o campo e ADITIVO (`PersistedState.provider` opcional) e
 * ausente significa `telegram` — um `state.json` v1 sem o campo continua valido
 * e le no default fechado (D3). PRESENTE tem de ser um dos literais fechados,
 * sob pena de corrupcao; hoje so `telegram`, e um provedor futuro acrescenta um
 * literal AQUI em sintonia com o enum do contrato — nunca em silencio.
 */
export const PROVIDER_LITERALS: readonly string[] = ['telegram']

function parseProvider(value: unknown, source: string): PersistedState['provider'] {
  if (value === undefined || value === null) return undefined
  return asLiteral<Exclude<PersistedState['provider'], undefined>>(
    value,
    PROVIDER_LITERALS as readonly Exclude<PersistedState['provider'], undefined>[],
    source,
    'provider',
  )
}

function parseSecretDigest(value: unknown, source: string): string {
  if (typeof value !== 'string') {
    throw corruptStateError(source, 'secretDigest tinha de ser uma string')
  }
  try {
    // Reutiliza o construtor validador CONGELADO (`src/brand.ts`): hex
    // minusculo de 64 caracteres. Uma segunda definicao do mesmo formato aqui
    // divergiria da de T2.1 sem o compilador dizer uma palavra.
    return toSecretDigest(value)
  } catch (error) {
    if (error instanceof BrandError) throw corruptStateError(source, `secretDigest invalido (${error.message})`)
    throw error
  }
}

/* ========================================================================== */
/* Migracao + validacao                                                       */
/* ========================================================================== */

/**
 * Le um valor cru (ja desserializado) como `PersistedState` da versao corrente.
 *
 * Hoje ha uma versao so, e por isso a "migracao" e um despacho com um ramo. A
 * forma importa mais do que o conteudo: quando existir `version: 2`, o ramo
 * `case 1` passa a converter em vez de validar, e o ficheiro v1 no disco de
 * alguem continua a arrancar. Sem o despacho, a alternativa historica e sempre
 * a mesma: "nao percebi, comeco do zero".
 */
export function migrateState(raw: unknown, source: string): PersistedState {
  const record = asRecord(raw, source, 'o documento')
  rejectUnknownKeys(record, KNOWN_KEYS, source, 'o documento')

  const version = record['version']
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw corruptStateError(
      source,
      'falta o campo `version` (inteiro >= 1) — sem ele nao se sabe que forma o ficheiro tem',
    )
  }
  if (version > CURRENT_STATE_VERSION) {
    throw new StateError(
      'STATE_VERSION_UNSUPPORTED',
      `${source} declara \`version: ${version}\` e este plugin so sabe ler ate ` +
        `${CURRENT_STATE_VERSION}. Foi escrito por uma versao mais recente: ` +
        'nao se degrada o ficheiro por adivinhacao. Actualize o plugin, ou ' +
        'guarde uma copia e recomece o onboarding de forma deliberada.',
    )
  }

  // Depois dos dois guardas, `version` so pode ser a corrente. Quando existir
  // uma v2, e AQUI que entra o despacho (`version === 1` converte, `=== 2`
  // valida). Hoje um `switch` de um ramo so acrescentaria um ramo morto que
  // nenhum teste consegue exercer — e ramo que nenhum teste exerce e ramo que
  // ninguem sabe se esta escrito ao contrario.
  return parsePersistedState(record, source)
}

/**
 * Valida um `PersistedState` ja na versao corrente e devolve uma COPIA normalizada.
 *
 * Usado nos DOIS sentidos: ao ler o disco e ao aceitar o valor devolvido pelo
 * callback de `store.update()`. O store e o unico writer do repositorio; se ele
 * nao validar a saida, o unico writer passa a ser tambem o unico ponto por onde
 * lixo entra no ficheiro sem ninguem ver.
 */
export function parsePersistedState(value: unknown, source: string): PersistedState {
  const record = asRecord(value, source, 'o documento')
  rejectUnknownKeys(record, KNOWN_KEYS, source, 'o documento')

  const state: PersistedState = {
    version: CURRENT_STATE_VERSION,
    desiredState: asLiteral(record['desiredState'], ['READY', 'STOPPED'], source, 'desiredState'),
  }

  const resultado: PersistedState = {
    ...state,
    secretDigest: record['secretDigest'] === undefined ? undefined : parseSecretDigest(record['secretDigest'], source),
    restricted: record['restricted'] === undefined ? undefined : parseRestricted(record['restricted'], source),
    tunnel: record['tunnel'] === undefined ? undefined : parseTunnel(record['tunnel'], source),
    pairing: record['pairing'] === undefined ? undefined : parsePairing(record['pairing'], source),
  }

  // `provider` e o UNICO campo que e GENUINAMENTE AUSENTE, nao `undefined`
  // (D3): ausente = telegram. Inclui-lo como chave com valor `undefined`
  // quebraria a igualdade de conjuntos da normalizacao e inflaria cada
  // `state.json` v1 reescrito com uma chave que ainda nao tem nada a dizer.
  // So se propaga quando o disco (ou o callback de `update()`) o escreveu.
  const provider = parseProvider(record['provider'], source)
  if (provider !== undefined) resultado['provider'] = provider

  return resultado
}

/* ========================================================================== */
/* Serializacao                                                               */
/* ========================================================================== */

/**
 * Bytes a escrever. Ordem de chaves FIXA e `\n` final.
 *
 * A ordem nao e estetica: `JSON.stringify` emite as chaves pela ordem de
 * insercao do objeto, e um objeto construido de forma diferente a cada escrita
 * produziria ficheiros com bytes diferentes e conteudo igual — o que torna
 * impossivel afirmar "o destino NAO foi tocado" por comparacao de bytes, que e
 * exatamente a prova de atomicidade que os testes fazem.
 *
 * As chaves opcionais AUSENTES nao sao escritas como `null`: `null` e um valor,
 * e a leitura estrita recusa-o. Ausente e ausente.
 */
export function serializeStateDocument(state: PersistedState): string {
  const ordered: Record<string, unknown> = {
    version: state.version,
    desiredState: state.desiredState,
  }
  if (state.secretDigest !== undefined) ordered['secretDigest'] = state.secretDigest
  if (state.restricted !== undefined) {
    ordered['restricted'] = { since: state.restricted.since, reason: state.restricted.reason }
  }
  if (state.tunnel !== undefined) {
    ordered['tunnel'] = {
      pid: state.tunnel.pid,
      startedAt: state.tunnel.startedAt,
      mode: state.tunnel.mode,
    }
  }
  if (state.pairing !== undefined) {
    ordered['pairing'] = {
      ownerUserId: state.pairing.ownerUserId,
      ownerChatId: state.pairing.ownerChatId,
      pairedAt: state.pairing.pairedAt,
    }
  }
  // `provider` so e gravado quando definido — ausente e o default fechado
  // (`telegram`, D3), e manter a ausencia em vez de escrever o default evita
  // inflar todos os `state.json` v1 com uma chave que ainda nao tem nada a
  // acrecentar. Uma escrita explicita de `provider: 'telegram'` preserva-se.
  if (state.provider !== undefined) ordered['provider'] = state.provider
  return `${JSON.stringify(ordered, undefined, 2)}\n`
}

/**
 * Texto do disco -> `PersistedState`.
 *
 * Um ficheiro VAZIO (ou so espacos) e CORRUPCAO, nao "primeiro arranque". A
 * ausencia de estado e a ausencia do FICHEIRO — isso `store.read()` trata. Um
 * ficheiro de zero bytes so aparece se alguem o truncou, e tratar truncagem
 * como "novo" e a porta exata para trocar a senha do dono em silencio.
 */
export function parseStateDocument(text: string, source: string): PersistedState {
  if (text.trim().length === 0) {
    throw corruptStateError(source, 'o ficheiro esta vazio (zero bytes uteis)')
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw corruptStateError(source, `nao e JSON valido (${error instanceof Error ? error.message : 'erro desconhecido'})`)
  }
  return migrateState(raw, source)
}
