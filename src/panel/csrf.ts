/**
 * Token anti-CSRF das rotas POST do painel.
 *
 * DONO: T3.4.
 *
 * ------------------------------------------------------------------------
 * PORQUE EXISTE, SE O COOKIE JA E `__Host-` + `SameSite=Strict`
 * ------------------------------------------------------------------------
 * Duas razoes, e a segunda e a que decide.
 *
 * 1. DEFESA EM PROFUNDIDADE. NIST SP 800-63B-4 5.1.1 e normativo e nao admite
 *    a troca: *"POST/PUT content SHALL contain a session identifier that the RP
 *    SHALL verify to protect against CSRF"*. A OWASP e igualmente direta:
 *    `SameSite` sozinho NAO basta. Um `SameSite=Strict` mal aplicado, um
 *    navegador antigo, uma rota que amanha aceite `GET` -- qualquer um destes
 *    reabre o buraco, e nenhum deles e visivel em revisao de codigo.
 *
 * 2. `POST /__guard/magic` ACONTECE ANTES DE HAVER SESSAO. Nao ha cookie para o
 *    `SameSite` proteger, logo o cookie NAO PODE ser a unica defesa dessa rota.
 *    Isto sozinho ja obriga a que o token exista e a que ele NAO dependa da
 *    sessao -- e e por isso que a assinatura e sobre um "vinculo" arbitrario e
 *    nao sobre um id de sessao.
 *
 * ------------------------------------------------------------------------
 * PORQUE O TOKEN E SEM ESTADO (HMAC), E NAO UMA ENTRADA NUM MAPA
 * ------------------------------------------------------------------------
 * `GET /__guard/magic` TEM DE SER INERTE (D3, MAG-001): um pre-carregamento do
 * cliente de Telegram, de um scanner de antiphishing ou do proprio
 * pre-visualizador de links nao pode custar NADA ao servidor. Um token guardado
 * num mapa transformava cada pre-carregamento numa escrita: ou o mapa cresce sem
 * limite (memoria como alvo), ou ele tem teto e o pre-carregamento passa a
 * DESPEJAR o token que o dono ainda vai usar. As duas saidas sao piores do que
 * o problema.
 *
 * Um HMAC sobre `(vinculo, expiracao)` com uma chave por processo emite sem
 * escrever e verifica sem ler. O `GET` continua a ser uma funcao pura do pedido.
 *
 * ------------------------------------------------------------------------
 * O QUE ESTE TOKEN NAO E -- e a honestidade importa aqui
 * ------------------------------------------------------------------------
 * Ele NAO e uma credencial e nao autentica ninguem. Quem alcanca o servidor
 * pelo lado do servidor (um `curl` de outra maquina) consegue emitir um token
 * para si proprio pedindo qualquer pagina publica nossa. Isso nao e uma falha
 * do desenho: e a definicao de CSRF. O ataque que este token fecha e o do
 * NAVEGADOR DA VITIMA -- uma pagina de terceiros que dispara um `POST` para nos
 * aproveitando a autoridade ambiente do dono. Essa pagina NAO consegue ler a
 * nossa resposta (o navegador bloqueia a leitura entre origens, e nos nao
 * emitimos cabecalho CORS nenhum), logo nao consegue extrair o token.
 * Quem se autentica continua a ser o `mk` ou o segredo, nunca isto.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { PLUGIN_NAME } from '../errors.ts'

/**
 * Cabecalho que transporta o token.
 *
 * SEGUNDO CONTROLO DE GRACA: um formulario HTML de outra origem NAO consegue
 * definir um cabecalho proprio -- so `fetch`/`XHR` conseguem, e esses caem no
 * preflight de CORS, que nunca respondemos. O campo de corpo continua aceite
 * porque um `<form>` da NOSSA propria pagina e o caminho que funciona sem
 * JavaScript.
 */
export const CSRF_HEADER_NAME = 'x-dsh-csrf'

/** Nome do campo equivalente no corpo (`form` ou JSON). */
export const CSRF_FIELD_NAME = 'csrf'

/**
 * 30 minutos.
 *
 * Curto o bastante para que um token colhido de uma pagina esquecida num
 * separador nao valha um dia inteiro; longo o bastante para que o dono leia o
 * ecra do link magico, decida, e ainda consiga tocar no botao. O `mk` que ele
 * protege ja morre aos 120 s -- este prazo nunca e o limitante do caso feliz.
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

/**
 * Relogio injetado, estruturalmente igual ao `Clock` de `test/support/clock.ts`.
 * Declarado aqui porque `src/**` nao importa de `test/**`.
 */
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
   * A consequencia de ser por processo e deliberada: reiniciar o plugin invalida
   * todos os tokens em voo. Isso e correto -- as sessoes tambem morrem no
   * reinicio (sao em memoria), e o `mk` tambem.
   */
  readonly key?: Uint8Array
}

export interface CsrfGuard {
  /**
   * Emite um token para um VINCULO.
   *
   * O vinculo e o que impede um token colhido numa rota de valer noutra: nas
   * rotas com sessao e o `idHash` da sessao (nunca o id em claro, que e a
   * credencial portadora); nas rotas publicas e a chave da propria rota.
   */
  issue(binding: string): string
  /** Verifica em tempo constante. Qualquer duvida devolve `false`. */
  verify(token: unknown, binding: string): boolean
}

/**
 * Assinatura sobre `(vinculo, expiracao)`.
 *
 * O vinculo entra PREFIXADO PELO COMPRIMENTO. Sem isso, `('ab', 'c|1')` e
 * `('ab|c', '1')` produziriam a mesma mensagem e um token de uma rota valeria
 * noutra -- exatamente o que o vinculo existe para impedir.
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
    throw new Error(
      `[${PLUGIN_NAME}] chave de CSRF curta demais: ${key.length} bytes (minimo 16)`,
    )
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`[${PLUGIN_NAME}] ttlMs de CSRF tem de ser positivo, e nao ${String(ttlMs)}`)
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
      // ao alfabeto. Logo a barreira contra lixo e o COMPRIMENTO do resultado,
      // e nao um try/catch que nunca dispararia.
      const presented = Buffer.from(token.slice(dot + 1), 'base64url')
      if (presented.length !== SIGNATURE_BYTES) return false

      // A expiracao entra na mensagem assinada, portanto adiantar o relogio do
      // token muda a assinatura esperada e a comparacao falha. Nao ha aqui um
      // ramo "confia na expiracao que o cliente declarou".
      return timingSafeEqual(presented, sign(key, binding, expiresAt))
    },
  }
}
