/**
 * Store do `mk` do link magico: 128 bits, TTL 120 s, uso unico, SO EM MEMORIA.
 *
 * DONO: T2.2. PURO -- `GET /__guard/magic` (inerte) e `POST /__guard/magic`
 * (consome) sao entrega de T3.4, na Onda 3. Aqui vive so o token.
 *
 * ------------------------------------------------------------------------
 * O QUE O `mk` E
 * ------------------------------------------------------------------------
 * D3 fecha o conflito das quatro versoes do link magico: a SENHA nunca viaja
 * pelo Telegram; o que viaja e um portador de uso unico com 120 s de vida, que
 * troca por uma sessao. Ele nao substitui a senha, nao a revela e nao dura.
 *
 * ------------------------------------------------------------------------
 * NUNCA PERSISTIDO -- E ISSO E UMA PROPRIEDADE, NAO UM ESQUECIMENTO
 * ------------------------------------------------------------------------
 * Este ficheiro nao importa `node:fs` e nao conhece o `StateStore` de T2.5. O
 * `mk` morre com o processo, de proposito: um token de 120 s que sobrevivesse a
 * um reinicio seria um token cuja janela real e "ate alguem ler o disco". O
 * teste MAG-005 cobra exatamente isto -- store novo, token antigo nao entra.
 *
 * Q-4 (segredo nunca em argv, log, mensagem ou disco em claro) aplica-se ao
 * `mk` por inteiro. Tres consequencias no codigo abaixo:
 *   1. o mapa e indexado por `sha256(mk)`; o token em claro existe uma vez, no
 *      retorno de `issue()`, e a partir dai so quem recebeu o link o tem;
 *   2. o token e o store redigem-se em DOIS caminhos, porque fechar um so
 *      deixava o outro aberto e a fuga passava pelo que ficou:
 *        `JSON.stringify(token)` -> fechado por `toJSON()`   (log estruturado,
 *                                   quadro de IPC para o worker do Telegram);
 *        `util.inspect(token)`   -> fechado por `[inspect.custom]`, que e o
 *                                   caminho de `console.log(token)` e do
 *                                   formatador de qualquer logger que receba o
 *                                   OBJETO em vez da string. Este segundo e o
 *                                   habito mais comum de todos;
 *   3. nenhuma mensagem de erro deste ficheiro inclui o valor apresentado.
 *
 * ------------------------------------------------------------------------
 * PORQUE INDEXAR PELO DIGEST TAMBEM MATA O ORACULO DE TEMPO
 * ------------------------------------------------------------------------
 * Uma tabela indexada pelo token em claro compara strings byte a byte e, em
 * principio, da a quem adivinha um sinal de "acertei o prefixo". Indexado pelo
 * digest, o atacante teria de acertar o `sha256` inteiro para chegar sequer a
 * uma comparacao -- e o digest de um palpite nao tem relacao nenhuma com o
 * digest do token certo. Nao ha byte a recuperar de cada vez, e por isso nao ha
 * necessidade de varrer a tabela em tempo constante (varrer seria, essa sim,
 * uma alavanca de DoS).
 */

import { createHash, randomBytes as csprngBytes } from 'node:crypto'
import { inspect } from 'node:util'

import type { Clock } from './store.ts'
import { PLUGIN_NAME } from '../errors.ts'

/** 16 bytes = 128 bits (ASVS 5.0 11.5.1 para valor nao-adivinhavel). */
export const MAGIC_TOKEN_BYTES = 16

/** TTL de 120 s. Curto de proposito: o link e para ser tocado agora. */
export const MAGIC_TTL_MS = 120_000

/**
 * Teto de tokens vivos.
 *
 * So o DONO emite link magico (pelo bot, apos a allowlist e a confirmacao de
 * duas etapas), logo isto nao e o controlo primario contra exaustao -- e o
 * limite que impede um ciclo de `/acessar` de acumular estado durante horas.
 * Ao encher, sai o token que expira primeiro.
 */
export const MAGIC_MAX_LIVE = 8

const PRESENTED_MK = /^[A-Za-z0-9_-]{22,256}$/u

/** A forma redigida de um token: tudo menos o portador. */
export interface RedactedMagicToken {
  readonly mk: string
  readonly expiraEm: number
}

/**
 * Token emitido. Serializar isto NAO revela o `mk`, por nenhum dos dois
 * caminhos -- nem `JSON.stringify`, nem `util.inspect`/`console.log`.
 */
export interface MagicToken {
  /** O portador em claro. Vai no FRAGMENTO da URL, nunca em query (D3). */
  readonly mk: string
  /** Instante, no relogio injetado, em que deixa de valer. */
  readonly expiraEm: number
  toJSON(): RedactedMagicToken
  [inspect.custom](): RedactedMagicToken
}

export interface MagicStoreDeps {
  readonly clock: Clock
  readonly randomBytes?: (size: number) => Uint8Array
}

export interface MagicStore {
  /** Emite um `mk` novo. Nao invalida os que ja foram emitidos. */
  issue(): MagicToken
  /** Queima o token: `true` na PRIMEIRA vez, `false` em todas as seguintes. */
  consume(mk: string): boolean
  /** Invalida todos (modo restrito, queda do tunel, despareamento). */
  revokeAll(): void
  /** Disposer SINCRONO (Q-2). Idempotente. */
  dispose(): void
  readonly live: number
  toJSON(): string
  [inspect.custom](): string
}

function digestOf(mk: string): string {
  return createHash('sha256').update(mk, 'utf8').digest('hex')
}

export function createMagicStore(deps: MagicStoreDeps): MagicStore {
  const clock = deps.clock
  const randomBytes = deps.randomBytes ?? csprngBytes
  /** digest hex -> instante de expiracao. O `mk` em claro nao entra aqui. */
  const vivos = new Map<string, number>()
  let disposto = false

  function varrer(agora: number): void {
    for (const [chave, limite] of vivos) {
      if (agora >= limite) vivos.delete(chave)
    }
  }

  function abrirEspaco(): void {
    while (vivos.size >= MAGIC_MAX_LIVE) {
      let primeiro: string | undefined
      let limite = Number.POSITIVE_INFINITY
      for (const [chave, quando] of vivos) {
        if (quando < limite) {
          limite = quando
          primeiro = chave
        }
      }
      if (primeiro === undefined) return
      vivos.delete(primeiro)
    }
  }

  return {
    issue(): MagicToken {
      if (disposto) {
        throw new Error(
          `[${PLUGIN_NAME}] MagicStore ja foi disposto: o link emitido agora nunca seria consumivel`,
        )
      }
      const agora = clock.now()
      varrer(agora)
      abrirEspaco()

      const mk = Buffer.from(randomBytes(MAGIC_TOKEN_BYTES)).toString('base64url')
      const expiraEm = agora + MAGIC_TTL_MS
      vivos.set(digestOf(mk), expiraEm)

      // A redacao vive no proprio objeto porque o ponto de fuga nao e quem sabe
      // que isto e segredo -- e quem nao sabe e serializa por habito. As DUAS
      // entradas sao precisas: `console.log(token)` nao passa por `toJSON()`.
      const redigido = (): RedactedMagicToken => ({ mk: '[REDACTED]', expiraEm })

      return {
        mk,
        expiraEm,
        toJSON: redigido,
        [inspect.custom]: redigido,
      }
    },

    consume(mk: string): boolean {
      // Apos `dispose()`, consumir e sempre `false`: fecha-se em silencio, como
      // o `validate()` da sessao, porque um pedido em voo durante a desmontagem
      // tem de levar recusa, nao derrubar o hospedeiro.
      if (disposto) return false
      if (typeof mk !== 'string' || !PRESENTED_MK.test(mk)) return false

      const agora = clock.now()
      const chave = digestOf(mk)
      const limite = vivos.get(chave)
      if (limite === undefined) return false

      // Apaga SEMPRE, mesmo quando ja expirou: o token e de uso unico, e um
      // apagar so no caminho feliz deixaria lixo vivo ate a varredura seguinte.
      vivos.delete(chave)
      return agora < limite
    },

    revokeAll(): void {
      vivos.clear()
    },

    dispose(): void {
      disposto = true
      vivos.clear()
    },

    get live(): number {
      return vivos.size
    },

    toJSON: () => '[MagicStore REDACTED]',
    [inspect.custom]: () => '[MagicStore REDACTED]',
  }
}
