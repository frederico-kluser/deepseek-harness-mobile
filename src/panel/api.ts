/**
 * `GET /__guard/`, `GET /__guard/api/state` e `POST /__guard/api/login`.
 *
 * DONO: T3.4 -> T5.3.
 *
 * ------------------------------------------------------------------------
 * PORQUE O ENVELOPE DE RESPOSTA VIVE AQUI
 * ------------------------------------------------------------------------
 * `PanelResponse` e as respostas constantes (404, 403, 413, 500) sao usadas por
 * `magic.ts`, por `secret.ts` e pelo despachante de `routes.ts`. Se vivessem em
 * `routes.ts` -- que e quem as escreve no socket -- o grafo de modulos ficava
 * CICLICO (`routes -> secret -> routes`), e um ciclo com valores (nao apenas
 * tipos) e uma zona morta temporal a espera de acontecer. Vivendo na folha mais
 * baixa que precisa delas, o grafo e um DAG: `csrf`/`html` -> `api` ->
 * `magic`/`secret` -> `routes`.
 *
 * O 404 SER UMA CONSTANTE PARTILHADA E O CONTROLO, E NAO ARRUMACAO. `PANEL-003`
 * e `PANEL-004` exigem que o 404 de rota inexistente e o 404 de
 * `/__guard/secret` sem `ott` sejam BYTE A BYTE iguais. Com dois literais em
 * dois ficheiros, isso e verdade no dia em que se escreve e mentira na primeira
 * vez que alguem melhora uma das mensagens. Com uma constante, e verdade por
 * construcao.
 *
 * ------------------------------------------------------------------------
 * `GET /api/state` NAO RESPONDE NADA ANTES DO LOGIN
 * ------------------------------------------------------------------------
 * O que ele vazaria e a URL DO TUNEL, que e informacao sensivel de operacao: e
 * o endereco publico da maquina do dono, valido enquanto o tunel viver, e quem
 * varre a internet a procura de quick tunnels precisa exatamente disso. A
 * politica esta na tabela de `routes.ts` (`exige-sessao`) e a projecao aqui
 * REPETE a invariante do contrato: `info` so sai em `READY`. Duas camadas para
 * a mesma promessa, porque uma delas vai ser refatorada um dia.
 *
 * ------------------------------------------------------------------------
 * PORQUE `maskAuditText` E NAO `redact` (revisao adversarial, BAIXA)
 * ------------------------------------------------------------------------
 * `src/logging/redact.ts` DECLARA no proprio cabecalho o que nao cobre: o `mk`
 * do link magico e O URL DO TUNEL. A versao anterior deste ficheiro chamava-lhe
 * "o cinto por cima dos suspensorios" -- e era falso: um `failure.message` com o
 * URL do tunel saia INTACTO por `/__guard/api/state`.
 *
 * `maskAuditText` (`src/audit/format.ts`, T2.4) e `redact()` MAIS as formas que
 * faltavam: `*.trycloudflare.com`, `mk=`, e o segredo em base32. Chamar em vez
 * de copiar, porque uma primitiva de mascaramento duplicada e uma primitiva que
 * diverge.
 *
 * O QUE NENHUMA DAS DUAS COBRE e o CAMINHO ABSOLUTO, que a revisao tambem
 * apanhou. A forma vive aqui, em {@link maskAbsolutePaths}, e e um remendo
 * LOCAL: a casa duravel dela e `SECRET_SHAPES`/`AUDIT_SHAPES`, e nenhum desses
 * dois ficheiros e desta sub-tarefa. Fica REPORTADO em vez de contornado.
 */

import type { IncomingMessage } from 'node:http'

import type { AuditEvent, AuditSink, Identity, SecretStore } from '../contracts/auth.ts'
import type { TunnelSnapshot } from '../contracts/tunnel.ts'
import type { GuardLogger } from '../logging/logger.ts'
import type { FailureTracker } from '../ratelimit/tracker.ts'
import type { RequestOrigin } from '../session/cookie.ts'
import type { GuardSession, GuardSessionStore } from '../session/store.ts'
import type { CsrfGuard } from './csrf.ts'
import { maskAuditText } from '../audit/format.ts'
import { REDACTED } from '../logging/redact.ts'
import { runThrottledAttempt } from '../ratelimit/tracker.ts'
import { assertTrustworthyOrigin, serializeSessionCookie } from '../session/cookie.ts'
import { newNonce, panelHtmlHeaders, renderPanelPage } from './html.ts'

/* ========================================================================== */
/* 1. Envelope                                                                */
/* ========================================================================== */

export interface PanelResponse {
  readonly status: number
  /** Nomes em minusculas. A ORDEM importa: e ela que torna dois 404 iguais. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  /** Uma linha `Set-Cookie`, quando a resposta entrega sessao. */
  readonly setCookie?: string
}

/** Tudo o que um tratador de rota do painel ve do pedido. */
export interface PanelExchange {
  readonly req: IncomingMessage
  readonly method: string
  /** Caminho ja canonicalizado por `canonicalRequestPath`. */
  readonly path: string
  /** `req.url` cru -- o unico sitio onde a query string ainda existe. */
  readonly rawUrl: string
  readonly origin: RequestOrigin
  readonly identity: Identity
  /** Sessao valida, ou `null`. Nas rotas publicas e quase sempre `null`. */
  readonly session: GuardSession | null
  /** Id APRESENTADO no cookie, valido ou nao. Serve o anti-fixation. */
  readonly presentedSessionId: string | null
  /** Corpo ja lido e decomposto pelo despachante. Vazio nos `GET`. */
  readonly fields: ReadonlyMap<string, string>
  readonly csrf: CsrfGuard
}

export type PanelHandler = (exchange: PanelExchange) => Promise<PanelResponse>

const TEXT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
})

const JSON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
})

/**
 * O 404. UM literal, para o repositorio inteiro.
 *
 * O corpo e deliberadamente anodino: sem nome de plugin, sem versao, sem
 * hostname, sem caminho de ficheiro (PANEL-010). Enumerar versao e o primeiro
 * passo de quem procura CVE, e esta e a unica superficie que um scanner anonimo
 * ve com o tunel de pe.
 */
export const NOT_FOUND_RESPONSE: PanelResponse = Object.freeze({
  status: 404,
  headers: TEXT_HEADERS,
  body: 'Not Found\n',
})

/** CSRF em falta ou invalido. Nao e um oraculo de credencial: nao ha credencial. */
export const FORBIDDEN_RESPONSE: PanelResponse = Object.freeze({
  status: 403,
  headers: TEXT_HEADERS,
  body: 'Pedido recusado.\n',
})

export const PAYLOAD_TOO_LARGE_RESPONSE: PanelResponse = Object.freeze({
  status: 413,
  headers: TEXT_HEADERS,
  body: 'Pedido grande demais.\n',
})

/**
 * Qualquer excecao nao prevista desagua aqui.
 *
 * O corpo e fixo porque a mensagem do erro pode conter QUALQUER coisa -- e o
 * caminho de login manipula o segredo. Nenhum detalhe de erro atravessa o fio;
 * ele vai para o log, ja redigido.
 */
export const INTERNAL_ERROR_RESPONSE: PanelResponse = Object.freeze({
  status: 500,
  headers: TEXT_HEADERS,
  body: 'Erro interno.\n',
})

/**
 * A UNICA resposta que uma credencial recusada produz -- no `login` E no `magic`.
 *
 * `02-SEGURANCA.md` 6.1: segredo errado, segredo certo sem conta provisionada,
 * corpo malformado e campo ausente TEM de ser indistinguiveis. Uma constante
 * unica torna isso verdade por construcao -- nao ha um segundo literal onde
 * introduzir a diferenca. Sem `Retry-After`, sem `429`, sem contagem: qualquer
 * um deles diria ao atacante quanto do orcamento ja gastou.
 *
 * PARTILHADA COM `magic.ts` DE PROPOSITO: `mk` expirado, `mk` ja gasto e `mk`
 * malformado tambem sao a mesma resposta, e tambem sao a mesma resposta que um
 * segredo errado. Tres razoes distintas, uma unica saida observavel.
 */
export const CREDENTIAL_DENIED_RESPONSE: PanelResponse = Object.freeze({
  status: 401,
  headers: JSON_HEADERS,
  body: '{"ok":false}\n',
})

export const OK_JSON_RESPONSE: PanelResponse = Object.freeze({
  status: 200,
  headers: JSON_HEADERS,
  body: '{"ok":true}\n',
})

/* ========================================================================== */
/* 2. Corpo do pedido -- entrada hostil                                       */
/* ========================================================================== */

/**
 * Teto do corpo aceite num `POST` do painel.
 *
 * Os corpos reais sao dois campos curtos (`segredo`+`csrf`, `mk`+`csrf`). 4 KiB
 * e folga generosa e ao mesmo tempo o que impede que um `POST` sem fim consuma
 * memoria do processo que hospeda o DSH inteiro.
 */
export const MAX_BODY_BYTES = 4096

export type ParsedBody =
  | { readonly ok: true; readonly fields: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly reason: 'too-large' | 'malformed' | 'unsupported' }

const EMPTY_FIELDS: ReadonlyMap<string, string> = new Map<string, string>()

/** Devolve o mapa vazio partilhado -- nunca `undefined`, nunca `null`. */
export function emptyFields(): ReadonlyMap<string, string> {
  return EMPTY_FIELDS
}

function contentTypeOf(req: IncomingMessage): string {
  const raw = req.headers['content-type']
  if (typeof raw !== 'string') return ''
  const semicolon = raw.indexOf(';')
  return (semicolon === -1 ? raw : raw.slice(0, semicolon)).trim().toLowerCase()
}

function fieldsFromJson(text: string): ParsedBody {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed' }
  }
  const fields = new Map<string, string>()
  for (const [key, value] of Object.entries(parsed)) {
    // So primitivas. Um objeto aninhado nao tem forma escalar e converte-lo
    // produziria `[object Object]` como se fosse um valor legitimo.
    if (typeof value === 'string') fields.set(key, value)
    else if (typeof value === 'number' || typeof value === 'boolean') fields.set(key, String(value))
  }
  return { ok: true, fields }
}

/**
 * Le e decompoe o corpo, com teto de bytes.
 *
 * O teto e verificado A MEDIDA QUE OS PEDACOS CHEGAM, e nao no fim: verificar
 * no fim significa ter aceitado tudo primeiro, que e precisamente o que o teto
 * existe para impedir.
 */
export async function readRequestBody(
  req: IncomingMessage,
  limitBytes: number = MAX_BODY_BYTES,
): Promise<ParsedBody> {
  const chunks: Buffer[] = []
  let total = 0

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
    total += buffer.length
    if (total > limitBytes) return { ok: false, reason: 'too-large' }
    chunks.push(buffer)
  }

  const text = Buffer.concat(chunks).toString('utf8')
  const contentType = contentTypeOf(req)

  if (contentType === 'application/x-www-form-urlencoded') {
    const fields = new Map<string, string>()
    // `URLSearchParams` aceita chaves repetidas; fica a PRIMEIRA. Ficar com a
    // ultima deixaria um atacante anexar `&csrf=<valido>` a um corpo alheio.
    for (const [key, value] of new URLSearchParams(text)) {
      if (!fields.has(key)) fields.set(key, value)
    }
    return { ok: true, fields }
  }

  if (contentType === 'application/json') return fieldsFromJson(text)

  return { ok: false, reason: 'unsupported' }
}

/* ========================================================================== */
/* 3. Auditoria -- a torneira que a revisao adversarial encontrou aberta      */
/* ========================================================================== */

/**
 * Quanto tempo de SILENCIO fecha uma rajada.
 *
 * Nao e uma janela deslizante: enquanto as recusas continuarem a chegar, a
 * rajada e A MESMA e a contagem nao reinicia. So um intervalo inteiro sem uma
 * unica recusa abre rajada nova. A diferenca decide o limite: com janela
 * deslizante, um atacante ganha `log2(N)` linhas A CADA janela e o ficheiro
 * volta a crescer sem fim; assim, ganha `log2(N)` linhas NO TOTAL.
 */
export const AUDIT_BURST_QUIET_MS = 5 * 60 * 1000

/**
 * O porteiro do `AuditSink`. DUAS responsabilidades, ambas nascidas da revisao
 * adversarial, e ambas com o mesmo dono para nao haver caminho por fora.
 *
 * ------------------------------------------------------------------------
 * (A) `append` NUNCA PROPAGA -- e isto foi pedido por escrito
 * ------------------------------------------------------------------------
 * `src/audit/log.ts` deixou a costura enderecada a esta onda, literalmente:
 *
 *   ">>> COSTURA PARA O PREP DA ONDA 3: [...] D9 exige `401` de corpo identico
 *   >>> em toda falha de autenticacao; propagar isto em cru daria um `500` com
 *   >>> texto proprio -- oraculo, e com topologia de disco dentro."
 *
 * `AuditLog.append` LANCA `AuditWriteError` quando o disco enche -- fail-closed
 * deliberado daquele modulo. Sem este porteiro, essa excecao subia ao `catch` do
 * despachante e convertia o 404 do segredo num 500 (que ANUNCIA que a rota
 * existe, e o que ela devolve destrancada e a senha permanente) e o 401 do login
 * num 500 (que mata D9). Medido pela revisao, nao imaginado.
 *
 * A resposta HTTP continua a ser a MESMA CONSTANTE; o erro vai para o log do
 * operador. E vai sem `AuditWriteError.path`, que o proprio modulo marca como
 * NAO APRESENTAVEL -- o log do host tambem nao e sitio para topologia de disco.
 *
 * ------------------------------------------------------------------------
 * (B) RECUSA ANONIMA E AGREGADA, PORQUE O FICHEIRO NAO TEM ROTACAO
 * ------------------------------------------------------------------------
 * `src/audit/log.ts` justifica a AUSENCIA de rotacao com a existencia do
 * limitador:
 *
 *   "SEM ROTACAO, com um numero atras: quem alimenta este ficheiro e o caminho
 *   de autenticacao, ATRAS DO LIMITADOR DE T2.3 -- [...] ~18 KB antes de a
 *   torneira fechar."
 *
 * A versao anterior desta sub-tarefa abriu duas torneiras que NAO estao atras
 * do limitador -- o `ott` invalido e a recusa de CSRF -- e a revisao mediu
 * 1405 e 1845 KiB/s de crescimento a partir de um cliente anonimo, num ficheiro
 * `0600` que por desenho nao pode ser rodado nem truncado. Isso e o disco do
 * dono cheio a partir da internet, e as linhas de seguranca reais afogadas em
 * ruido cujo volume o atacante escolhe.
 *
 * A REGRA, e ela e curta: uma recusa a quem NAO apresentou credencial valida e
 * agregada; tudo o que envolve uma identidade estabelecida, ou que passa pelo
 * limitador, e escrito em cheio.
 *
 * O login e o `magic` FICAM em cheio de proposito -- eles estao atras do
 * limitador, que e exatamente a condicao que o modulo de auditoria invoca, e
 * "registar TODA tentativa de autenticacao" e a entrega daquele ficheiro. O
 * atraso da escada (ate 30 s por tentativa, com jitter) e o que lhes limita o
 * caudal.
 *
 * A ESCADA DE ESCRITA e por LIMIAR EXPONENCIAL: escreve-se na 1a, 2a, 4a, 8a...
 * recusa da rajada. Consequencias, todas desejadas:
 *   - uma sonda isolada continua a produzir a sua linha, na hora;
 *   - N recusas custam `O(log N)` linhas -- mil milhoes de pedidos cabem em ~30;
 *   - a MAGNITUDE fica no registo (o nome leva `_xN`), portanto o operador ve
 *     "houve uma rajada e chegou a 2^k", que e a informacao que interessa.
 *
 * A contagem vai no NOME do evento e nao num campo novo: `AuditEvent` e
 * contrato CONGELADO (`src/contracts/auth.ts`) e `evento` e uma string livre que
 * `format.ts` mascara e limita a 200 caracteres. Acrescentar um campo era
 * contornar o contrato para poupar seis caracteres.
 */
export interface AuditGate {
  /** Escreve sempre. Nunca lanca. */
  append(event: AuditEvent): void
  /**
   * Recusa a um pedido SEM credencial valida: conta sempre, escreve em
   * `O(log N)`. Nunca lanca.
   */
  recordAnonymousRejection(evento: string): void
}

export interface AuditGateDeps {
  readonly audit: Pick<AuditSink, 'append'>
  readonly log: GuardLogger
  readonly clock: { now(): number }
  /** So se muda em teste; o valor de producao e {@link AUDIT_BURST_QUIET_MS}. */
  readonly quietMs?: number
}

interface Rajada {
  contagem: number
  ultimaEm: number
  proximoLimiar: number
}

export function createAuditGate(deps: AuditGateDeps): AuditGate {
  const quietMs = deps.quietMs ?? AUDIT_BURST_QUIET_MS
  // Estado por TIPO de evento, e nao por identidade: sob tunel toda a gente e
  // `127.0.0.1` e `Identity.ip` vem `undefined` (spike S2), logo contar por
  // identidade dava a quem ataca a chave do balde -- e um mapa sem teto.
  const rajadas = new Map<string, Rajada>()

  const escrever = (event: AuditEvent): void => {
    try {
      deps.audit.append(event)
    } catch (error) {
      // NUNCA PROPAGA. Ver (A) no cabecalho: a alternativa e um 500 que
      // anuncia a rota e quebra D9.
      deps.log.error(
        maskAuditText(
          `[painel] falha ao registar auditoria de ${event.evento}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        ),
      )
    }
  }

  return {
    append: escrever,

    recordAnonymousRejection(evento: string): void {
      const agora = deps.clock.now()
      let rajada = rajadas.get(evento)

      if (rajada === undefined || agora - rajada.ultimaEm >= quietMs) {
        rajada = { contagem: 0, ultimaEm: agora, proximoLimiar: 1 }
        rajadas.set(evento, rajada)
      }

      rajada.contagem += 1
      rajada.ultimaEm = agora

      if (rajada.contagem < rajada.proximoLimiar) return

      // O nome leva a contagem para que a magnitude sobreviva sem um campo novo.
      escrever({ evento: `${evento}_x${rajada.contagem}`, resultado: 'negado' })
      rajada.proximoLimiar = rajada.contagem * 2
    },
  }
}

/* ========================================================================== */
/* 3. Emissao de sessao -- partilhada por `login` e por `magic`               */
/* ========================================================================== */

export interface SessionEmissionInput {
  readonly sessions: Pick<GuardSessionStore, 'regenerate'>
  readonly origin: RequestOrigin
  readonly presentedSessionId: string | null
  readonly log: GuardLogger
}

/**
 * Emite a sessao e a linha `Set-Cookie`, ou falha FECHANDO.
 *
 * A ORIGEM E VERIFICADA ANTES DE A SESSAO NASCER. Se fosse depois, uma origem
 * que nao entrega cookie `Secure` deixava para tras uma sessao valida do lado do
 * servidor que ninguem consegue apresentar -- lixo autenticado a contar para o
 * teto de sessoes vivas.
 *
 * `regenerate` e nao `create`: ele INVALIDA o id que o cliente apresentou antes
 * de emitir o novo. Sem isso, um id plantado no navegador da vitima (por
 * subdominio, por XSS noutra aplicacao, por link) continuaria valido depois de
 * ela autenticar -- que e a definicao de session fixation. O aviso esta escrito
 * no topo de `src/session/store.ts` e e dirigido a esta sub-tarefa.
 */
export function emitSession(
  input: SessionEmissionInput,
): { readonly ok: true; readonly setCookie: string } | { readonly ok: false } {
  try {
    assertTrustworthyOrigin(input.origin)
  } catch (error) {
    // A mensagem e accionavel e foi escrita para o operador (nomeia a origem,
    // que nao e segredo). Ela vai para o LOG e nunca para o fio: quem faz o
    // pedido nao precisa de saber como a instalacao esta alcancavel.
    input.log.error(
      maskAuditText(
        `[painel] recusa emitir sessao: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
    return { ok: false }
  }

  const id = input.sessions.regenerate(input.presentedSessionId ?? undefined)
  return { ok: true, setCookie: serializeSessionCookie(id, input.origin) }
}

/* ========================================================================== */
/* 4. `GET /__guard/` -- o painel                                             */
/* ========================================================================== */

export interface PanelPageDeps {
  readonly log: GuardLogger
}

export function createPanelPageHandler(deps: PanelPageDeps): PanelHandler {
  return async (exchange: PanelExchange): Promise<PanelResponse> => {
    if (exchange.session === null) {
      // Inalcancavel: a tabela de `routes.ts` marca esta rota `exige-sessao` e
      // o despachante ja recusou. Se chegar aqui, a tabela e o despachante
      // desalinharam -- fecha-se, nunca se serve o painel a descoberto.
      deps.log.error('[painel] GET /__guard alcancado sem sessao: politica e despacho divergiram')
      return INTERNAL_ERROR_RESPONSE
    }

    const nonce = newNonce()
    // O vinculo do token e o HASH da sessao, nunca o id: o id e a credencial
    // portadora e ia parar dentro do HTML, ao alcance de qualquer leitura da
    // pagina. O hash correlaciona sem permitir reconstruir.
    const html = renderPanelPage({ nonce, csrfToken: exchange.csrf.issue(exchange.session.idHash) })
    return { status: 200, headers: panelHtmlHeaders(nonce), body: html }
  }
}

/* ========================================================================== */
/* 5. `GET /__guard/api/state`                                                */
/* ========================================================================== */

export interface StateDeps {
  readonly snapshot: () => TunnelSnapshot
}

/**
 * Mascara caminhos absolutos de sistema de ficheiros.
 *
 * REMENDO LOCAL, e esta nota e parte da correcao. `redact()` nao cobre esta
 * forma e `maskAuditText` tambem nao; a casa duravel dela e `SECRET_SHAPES`
 * (`src/logging/redact.ts`) ou `AUDIT_SHAPES` (`src/audit/format.ts`), e
 * NENHUM desses ficheiros e desta sub-tarefa. Escrever aqui e a unica forma de
 * fechar o buraco sem tocar em ficheiro alheio; a promocao fica REPORTADA.
 *
 * PORQUE UM CAMINHO IMPORTA: `TunnelFailure.message` e mostrada ao dono no
 * painel E no Telegram. Um caminho absoluto numa mensagem que viaja para o
 * Telegram e divulgacao do layout do disco do utilizador para um terceiro -- o
 * proprio contrato do tunel ja o proibe, e isto e a fronteira que nao confia na
 * proibicao.
 *
 * Exige DOIS segmentos para casar, e nao um: `/api/state` ou `/__guard` sao
 * caminhos de ROTA e aparecem legitimamente numa mensagem accionavel.
 */
export function maskAbsolutePaths(text: string): string {
  return text.replace(/(?<![\w/])(?:~|\/[\w.-]+)(?:\/[\w.-]+){2,}\/?/gu, REDACTED)
}

/**
 * Projeta o snapshot para o fio.
 *
 * `info` e `expiresAt` SO SAEM EM `READY`, e a verificacao e feita aqui e nao
 * confiada ao produtor. `src/contracts/tunnel.ts` ja diz "presente sse
 * `state === 'READY'`", mas um contrato e uma promessa e isto e uma fronteira:
 * se um dia um supervisor com defeito deixar `info` preenchida em `STARTING`, a
 * URL do tunel sai na resposta. Custa uma linha impedi-lo.
 *
 * O vocabulario que vai no payload e o INGLES de D7. Os rotulos em portugues
 * ficam em `html.ts` e nunca entram aqui.
 */
export function projectSnapshot(snapshot: TunnelSnapshot): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    state: snapshot.state,
    attempts: snapshot.attempts,
  }

  if (snapshot.state === 'READY' && snapshot.info !== undefined) {
    payload['info'] = {
      url: snapshot.info.url,
      startedAt: snapshot.info.startedAt,
      mode: snapshot.info.mode,
    }
    if (typeof snapshot.expiresAt === 'number') payload['expiresAt'] = snapshot.expiresAt
  }

  if (snapshot.failure !== undefined) {
    const failure: Record<string, unknown> = {
      code: snapshot.failure.code,
      // A ASSIMETRIA QUE A REVISAO APANHOU, e agora fechada: `info` era
      // filtrada por desconfianca do produtor e `message` era ACEITE dele. O
      // contrato proibe segredo, caminho e URL la dentro -- e isto e a
      // fronteira, que nao confia na proibicao. `maskAuditText` cobre o URL do
      // tunel, o `mk` e o segredo em base32; o caminho absoluto e o remendo
      // local acima.
      message: maskAbsolutePaths(maskAuditText(snapshot.failure.message)),
      retryable: snapshot.failure.retryable,
    }
    if (snapshot.failure.probe !== undefined) failure['probe'] = snapshot.failure.probe
    payload['failure'] = failure
  }

  return payload
}

export function createStateHandler(deps: StateDeps): PanelHandler {
  return async (): Promise<PanelResponse> => ({
    status: 200,
    headers: JSON_HEADERS,
    body: `${JSON.stringify(projectSnapshot(deps.snapshot()))}\n`,
  })
}

/* ========================================================================== */
/* 6. `POST /__guard/api/login`                                               */
/* ========================================================================== */

/** Nome do campo que transporta o segredo. */
export const LOGIN_FIELD_NAME = 'segredo'

export interface LoginDeps {
  readonly secrets: Pick<SecretStore, 'verify'>
  readonly sessions: Pick<GuardSessionStore, 'regenerate'>
  readonly limiter: FailureTracker
  /** Injetado: em teste nao se espera tempo real (04-TESTES.md 8.1). */
  readonly wait: (ms: number) => Promise<void>
  /**
   * O PORTEIRO, e nao o sink cru. Ver {@link createAuditGate}: `append` do sink
   * LANCA quando o disco enche, e uma excecao aqui virava um 500 no lugar do
   * 401 identico que D9 exige.
   */
  readonly audit: AuditGate
  readonly log: GuardLogger
}

/**
 * A rota que T2.2 NAO entregou de proposito -- a Onda 2 era "primitivas sem
 * fiacao". Esta e a fiacao.
 *
 * TRES PROPRIEDADES QUE O TESTE TEM DE CONSEGUIR FALSIFICAR:
 *
 * 1. NENHUM ORACULO. Todo o caminho que nao termina em sessao devolve
 *    `CREDENTIAL_DENIED_RESPONSE`, a mesma constante, com os mesmos bytes. Campo
 *    ausente vira candidato vazio em vez de um ramo proprio, justamente para
 *    nao existir um ramo proprio.
 * 2. CUSTO CONSTANTE. `runThrottledAttempt` corre a comparacao mesmo quando a
 *    identidade esta banida (`recordVerifiedButDenied`), e o atraso vem da
 *    mesma escada. Responder mais depressa a um banido seria dizer-lhe que
 *    esta banido.
 * 3. ANTI-FIXATION. `emitSession` chama `regenerate` com o id APRESENTADO.
 */
export function createLoginHandler(deps: LoginDeps): PanelHandler {
  return async (exchange: PanelExchange): Promise<PanelResponse> => {
    const candidate = exchange.fields.get(LOGIN_FIELD_NAME) ?? ''

    const outcome = await runThrottledAttempt(
      deps.limiter,
      exchange.identity,
      () => deps.secrets.verify(candidate),
      deps.wait,
    )

    if (!outcome.granted) {
      deps.audit.append({
        evento: 'painel_login',
        resultado: 'negado',
        ...(exchange.identity.ip === undefined ? {} : { ip_normalizado: exchange.identity.ip }),
      })
      return CREDENTIAL_DENIED_RESPONSE
    }

    const emitted = emitSession({
      sessions: deps.sessions,
      origin: exchange.origin,
      presentedSessionId: exchange.presentedSessionId,
      log: deps.log,
    })
    if (!emitted.ok) return INTERNAL_ERROR_RESPONSE

    deps.audit.append({
      evento: 'painel_login',
      resultado: 'permitido',
      ...(exchange.identity.ip === undefined ? {} : { ip_normalizado: exchange.identity.ip }),
    })

    return { ...OK_JSON_RESPONSE, setCookie: emitted.setCookie }
  }
}
