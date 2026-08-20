/**
 * Token anti-CSRF das rotas POST da superficie de UI nativa do DSH.
 *
 * DONO: T5.5 (esta sub-tarefa). O painel tem o SEU proprio em
 * `src/panel/csrf.ts` (T3.4 -> T5.3); este e o da terceira superficie, com a
 * MESMA doutrina e o MESMO formato, mas independente de proposito:
 *
 *   (a) `src/panel/**` e de OUTRA sub-tarefa desta onda — acoplar a superficie
 *       ao ficheiro de T5.3 seria uma dependencia entre worktrees paralelas;
 *   (b) o vinculo deste guard e o da superficie ('ui-contrib'), nao o de uma
 *       rota do painel.
 *
 * A DOUTRINA (igual a do painel): NIST SP 800-63B-4 5.1.1 — "POST/PUT content
 * SHALL contain a session identifier that the RP SHALL verify" — e a OWASP:
 * `SameSite` sozinho NAO basta. O gate ja exige credencial para SERVIR a
 * pagina onde os botoes vivem (a Web UI do DSH esta atras da barreira), mas o
 * ataque que este token fecha e o do NAVEGADOR DA VITIMA: uma pagina de
 * terceiros a disparar um POST contra a URL do tunel aproveitando a autoridade
 * ambiente do dono. Essa pagina nao consegue LER a nossa resposta (sem CORS),
 * logo nao consegue extrair o token do indice servido.
 *
 * SEM ESTADO (HMAC sobre (vinculo, expiracao), chave por processo), pela
 * MESMA razao do painel: cada `GET /` corre o tap do indice, e um token
 * guardado num mapa transformaria cada pre-carregamento numa escrita.
 *
 * O TOKEN NAO E CREDENCIAL: quem alcanca o servidor pelo lado do servidor
 * consegue emitir um token para si proprio. E a definicao de CSRF — o que o
 * token fecha e a extracao por leitura de resposta, nao a posse do servidor.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Cabecalho que transporta o token (o mesmo nome do painel). */
export const CSRF_HEADER_NAME = 'x-dsh-csrf'

/** Nome do campo equivalente no corpo JSON. */
export const CSRF_FIELD_NAME = 'csrf'

/**
 * 30 minutos — o mesmo prazo do painel. Curto o bastante para que um token
 * colhido de uma pagina esquecida num separador nao valha um dia inteiro;
 * longo o bastante para o dono ler o ecra e tocar no botao.
 */
export const CSRF_TTL_MS = 30 * 60 * 1000

/** 256 bits de chave de assinatura, por processo. Nunca sai deste modulo. */
export const CSRF_KEY_BYTES = 32

/** sha256 => 32 bytes de assinatura, sempre. */
const SIGNATURE_BYTES = 32

/** Teto do que se aceita sequer olhar. `12` base36 + `.` + 43 base64url = 56. */
const MAX_TOKEN_LENGTH = 128

/** So digitos e minusculas: e o alfabeto que `Number#toString(36)` produz. */
const EXPIRY_SHAPE = /^[0-9a-z]{1,12}$/u

/** Relogio injetado, estruturalmente igual ao `Clock` de `test/support/clock.ts`. */
export interface CsrfClock {
  now(): number
}

export interface CsrfDeps {
  readonly clock: CsrfClock
  /** So se muda em teste; o valor de producao e {@link CSRF_TTL_MS}. */
  readonly ttlMs?: number
  /**
   * Chave de assinatura. Omitida = 256 bits novos de CSPRNG por processo.
   *
   * A consequencia de ser por processo e deliberada: reiniciar o plugin
   * invalida todos os tokens em voo. Isso e correto — as sessoes tambem morrem
   * no reinicio (sao em memoria).
   */
  readonly key?: Uint8Array
}

export interface CsrfGuard {
  /**
   * Emite um token para um VINCULO.
   *
   * O vinculo e o que impede um token colhido num sitio de valer noutro: para
   * a superficie, o vinculo e a propria superficie ('ui-contrib') — o mesmo
   * token vale nas quatro rotas POST dela, e so nelas.
   */
  issue(binding: string): string
  /** Verifica em tempo constante. Qualquer duvida devolve `false`. */
  verify(token: unknown, binding: string): boolean
}

/**
 * Assinatura sobre `(vinculo, expiracao)`.
 *
 * O vinculo entra PREFIXADO PELO COMPRIMENTO. Sem isso, `('ab', 'c|1')` e
 * `('ab|c', '1')` produziriam a mesma mensagem e um token de um sitio valeria
 * noutro — exatamente o que o vinculo existe para impedir.
 */
function sign(key: Uint8Array, binding: string, expiresAt: number): Buffer {
  return createHmac('sha256', key).update(`${binding.length}:${binding}|${expiresAt}`, 'utf8').digest()
}

export function createCsrfGuard(deps: CsrfDeps): CsrfGuard {
  const key = deps.key ?? randomBytes(CSRF_KEY_BYTES)
  const ttlMs = deps.ttlMs ?? CSRF_TTL_MS

  // Fail loud no arranque, e nao na primeira verificacao: uma chave curta
  // demais produz tokens que "funcionam" e nao valem nada, e o defeito so
  // apareceria numa auditoria.
  if (key.length < 16) {
    throw new Error(`chave de CSRF da superficie curta demais: ${key.length} bytes (minimo 16)`)
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`ttlMs de CSRF da superficie tem de ser positivo, e nao ${String(ttlMs)}`)
  }

  return {
    issue(binding: string): string {
      const expiresAt = deps.clock.now() + ttlMs
      return `${expiresAt.toString(36)}.${sign(key, binding, expiresAt).toString('base64url')}`
    },

    verify(token: unknown, binding: string): boolean {
      if (typeof token !== 'string') return false
      if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false

      const dot = token.indexOf('.')
      if (dot <= 0) return false

      const rawExpiry = token.slice(0, dot)
      if (!EXPIRY_SHAPE.test(rawExpiry)) return false

      const expiresAt = Number.parseInt(rawExpiry, 36)
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return false
      if (deps.clock.now() >= expiresAt) return false

      // `Buffer.from(..., 'base64url')` nao lanca: descarta o que nao pertence
      // ao alfabeto. Logo a barreira contra lixo e o COMPRIMENTO do resultado.
      const presented = Buffer.from(token.slice(dot + 1), 'base64url')
      if (presented.length !== SIGNATURE_BYTES) return false

      // A expiracao entra na mensagem assinada, portanto adiantar o relogio do
      // token muda a assinatura esperada e a comparacao falha. Nao ha aqui um
      // ramo "confia na expiracao que o cliente declarou".
      return timingSafeEqual(presented, sign(key, binding, expiresAt))
    },
  }
}
