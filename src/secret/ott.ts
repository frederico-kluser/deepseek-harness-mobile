/**
 * `ott` -- token de uso unico que destranca `GET /__guard/secret`.
 *
 * O PROBLEMA QUE ELE RESOLVE: o segredo e mostrado UMA vez, no terminal onde o
 * plugin arrancou. Quem perde essa tela nao tem como o rever sem rodar o
 * segredo. A rota `/__guard/secret` existe para essa segunda tela -- mas uma
 * rota que devolve o segredo nao pode ser protegida pelo proprio segredo, e sem
 * autenticacao nenhuma seria a porta aberta que o resto da barreira existe para
 * fechar. O `ott` corta o no: 128 bits de CSPRNG impressos NO TERMINAL, que so o
 * dono da maquina ve, validos por 10 minutos e por uma unica utilizacao.
 *
 * FRONTEIRA: aqui vive so o STORE. Quem imprime o token no stdout e quem serve a
 * rota (T3.4), que sem `ott` valido devolve o 404 IDENTICO ao de rota
 * inexistente -- nao um 401, que confirmaria que a rota existe.
 *
 * Q-4, e vale a pena ser explicito: o `ott` sai por `process.stdout`, NUNCA pelo
 * logger. O logger do DSH escreve para ficheiro e para o log do host; um token
 * que abre o segredo nao pode ficar la. `stdout` do terminal de arranque e uma
 * superficie efemera e ja privilegiada -- quem a le, ja esta na maquina.
 *
 * 128 BITS, e nao 256: a ASVS 5.0 11.5.1 pede >= 128 bits de CSPRNG para
 * qualquer valor nao-adivinhavel, e este vive 10 minutos. A vida curta e o
 * segundo controlo -- alinha com o teto de 10 minutos que a propria ASVS impoe a
 * pedidos out-of-band (6.5.5) e com o uso unico de 6.5.1, que citamos como
 * REFERENCIA de ordem de grandeza, nao como autorizacao (o capitulo e de MFA).
 *
 * SEM TEMPORIZADOR: a expiracao e verificada na leitura. Um `setTimeout` de 10
 * minutos por token seria um handle a segurar o event loop (ou um `unref` a
 * mais para nao segurar) e um disposer a mais para acertar, para o mesmo
 * resultado observavel. O `dispose()` continua a existir e e SINCRONO (Q-2).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { canonicalizeSecret } from './canonical.ts'
import { encodeBase32 } from './generate.ts'

/** 16 bytes = 128 bits. */
export const OTT_BYTES = 16

/** 10 minutos. */
export const OTT_TTL_MS = 10 * 60 * 1000

/**
 * Relogio injetavel, estruturalmente igual ao `Clock` de `test/support/clock.ts`.
 *
 * Declarado aqui e nao importado de la porque `src/` nao importa de `test/`: o
 * duble e prep-owned e o pacote publicado nao leva a arvore de testes. A
 * compatibilidade estrutural e tudo o que o TypeScript exige, e e o que faz o
 * `FakeClock` entrar neste parametro sem nenhuma declaracao partilhada.
 */
export interface OttClock {
  now(): number
}

export interface OneTimeToken {
  /** O token em claro. Existe so nesta devolucao -- o store guarda o digest. */
  readonly token: string
  /** Instante (ms) a partir do qual `consume()` recusa. */
  readonly expiresAt: number
}

export interface OneTimeTokenStore {
  /** Emite um token novo. O anterior, se existia, deixa de valer nesse instante. */
  issue(): OneTimeToken
  /** Consome. `true` no maximo UMA vez por token emitido. */
  consume(candidate: string): boolean
  /** Descarta o token vivo. Sincrono, sem promessa (Q-2). */
  dispose(): void
}

export interface OneTimeTokenDeps {
  readonly clock: OttClock
  /** Tempo de vida. So se muda em teste; o valor de producao e {@link OTT_TTL_MS}. */
  readonly ttlMs?: number
}

/**
 * Digest do token. Mesma normalizacao do segredo, pela mesma razao: o dono pode
 * copiar o `ott` do terminal com um espaco a mais ou em minusculas.
 */
function digestOf(token: string): Buffer {
  return createHash('sha256').update(canonicalizeSecret(token), 'utf8').digest()
}

export function createOneTimeTokenStore(deps: OneTimeTokenDeps): OneTimeTokenStore {
  const ttlMs = deps.ttlMs ?? OTT_TTL_MS
  // O token em claro NAO e guardado: guarda-se o seu sha256, exatamente como o
  // segredo. Um despejo de memoria do processo nao entrega o token.
  let active: { digest: Buffer; expiresAt: number } | undefined

  return {
    issue: (): OneTimeToken => {
      const bytes = randomBytes(OTT_BYTES)
      const token = encodeBase32(bytes)
      bytes.fill(0)
      const expiresAt = deps.clock.now() + ttlMs
      active = { digest: digestOf(token), expiresAt }
      return { token, expiresAt }
    },

    consume: (candidate: string): boolean => {
      const current = active
      if (current === undefined) return false
      if (deps.clock.now() >= current.expiresAt) {
        // Expirado: apaga-se na leitura, para nao ficar em memoria a espera do
        // disposer. A comparacao nem chega a acontecer.
        active = undefined
        return false
      }
      const matches = timingSafeEqual(digestOf(candidate), current.digest)
      // USO UNICO: so o acerto queima o token. Se um palpite errado o queimasse,
      // qualquer pedido ao acaso apagaria o token que o dono ainda nao usou --
      // negacao de servico de graca. Palpite errado nao tem custo para o dono; o
      // limitador de T2.3 e que trata do volume.
      if (matches) active = undefined
      return matches
    },

    dispose: (): void => {
      active = undefined
    },
  }
}
