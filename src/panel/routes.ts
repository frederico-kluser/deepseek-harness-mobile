/**
 * Registro das rotas `/__guard/*` e a politica por rota da tabela de D5.
 *
 * DONO: T3.4 -> T5.3.
 *
 * ==========================================================================
 * O CONTROLO MAIS IMPORTANTE DESTE FICHEIRO: A ISENCAO E ENUMERADA
 * ==========================================================================
 * `isGuardedPath` guarda `/__guard` INTEIRO. A tabela abaixo e a UNICA fonte de
 * excecao a essa guarda, e cada excecao e UMA LINHA VISIVEL. Nao ha padrao, nao
 * ha prefixo, nao ha "rotas que comecam por" -- ha uma lista.
 *
 * A PROPRIEDADE QUE ISTO COMPRA, e que o teste central de
 * `test/security/panel-exemptions.test.ts` falsifica: uma rota NOVA acrescentada
 * a `panelRoutes()` sem tocar na tabela NASCE GUARDADA. A politica e procurada
 * pela CHAVE `<METODO> <caminho>` e a ausencia responde `'exige-sessao'`. Repare
 * que a politica NAO e um campo do objeto de rota: se fosse, quem escrevesse a
 * rota escreveria tambem a sua propria isencao, e a revisao teria de a apanhar
 * por leitura em vez de por construcao.
 *
 * PORQUE TAO DURO. Esta e a unica superficie do sistema alcancavel da internet
 * SEM credencial. Um furo por omissao aqui anula todas as outras camadas: o
 * gate, o limitador, o segredo, a sessao. E por isso que o teste vive em
 * `test/security/` e nao em `test/unit/`.
 *
 * PORQUE UM `Map` E NAO UM OBJETO. Com um objeto literal, `tabela['constructor']`
 * devolve um valor VERDADEIRO herdado do prototipo -- e uma consulta de politica
 * que devolve lixo verdadeiro em vez de `undefined` e um buraco que nao aparece
 * em revisao nenhuma. `Map` nao tem prototipo a consultar.
 *
 * ==========================================================================
 * SEM BOTOES DE LIGA/DESLIGA
 * ==========================================================================
 * `POST /__guard/api/tunnel/start|stop` sao de T5.3, na Onda 5, e por isso NAO
 * estao nem na tabela nem em `panelRoutes()`. Isso nao e omissao: enquanto nao
 * existirem, um pedido a esses caminhos cai no 404 comum -- que e o
 * comportamento correcto para uma rota que nao existe.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { AuditSink, Identity, SecretStore } from '../contracts/auth.ts'
import type { TunnelSnapshot } from '../contracts/tunnel.ts'
import type { GuardLogger } from '../logging/logger.ts'
import type { FailureTracker } from '../ratelimit/tracker.ts'
import type { OneTimeTokenStore } from '../secret/ott.ts'
import type { RequestOrigin } from '../session/cookie.ts'
import type { MagicStore } from '../session/magic.ts'
import type { GuardSessionStore } from '../session/store.ts'
import type { CsrfGuard } from './csrf.ts'
import type { AuditGate, PanelExchange, PanelHandler, PanelResponse } from './api.ts'

import { canonicalRequestPath, isGuardedPath } from '../http/path.ts'
import { challengeBasicAuth } from '../http/responses.ts'
import { maskAuditText } from '../audit/format.ts'
import { readSessionCookie } from '../session/cookie.ts'
import {
  createAuditGate,
  createLoginHandler,
  createPanelPageHandler,
  createStateHandler,
  emptyFields,
  FORBIDDEN_RESPONSE,
  INTERNAL_ERROR_RESPONSE,
  MAX_BODY_BYTES,
  NOT_FOUND_RESPONSE,
  PAYLOAD_TOO_LARGE_RESPONSE,
  readRequestBody,
} from './api.ts'
import { CSRF_FIELD_NAME, CSRF_HEADER_NAME } from './csrf.ts'
import { createMagicConsumeHandler, createMagicPageHandler } from './magic.ts'
import { createSecretHandler } from './secret.ts'

/* ========================================================================== */
/* 1. Vocabulario de caminhos (D5) e de politica                              */
/* ========================================================================== */

/** Prefixo canonico do plugin. `/__mobile` e `/__gate` estao MORTOS (D5). */
export const PANEL_PREFIX = '/__guard'

export const PANEL_PATH_ROOT = '/__guard'
export const PANEL_PATH_STATE = '/__guard/api/state'
export const PANEL_PATH_LOGIN = '/__guard/api/login'
export const PANEL_PATH_MAGIC = '/__guard/magic'
export const PANEL_PATH_SECRET = '/__guard/secret'

/**
 * `'publica'` = fora do gate, com o controlo que a substitui escrito na tabela.
 * `'exige-sessao'` = sem sessao valida nao passa. E o valor por OMISSAO.
 */
export type PanelPolicy = 'publica' | 'exige-sessao'

/** Metodos que o painel serve. Um pedido com outro metodo nao casa rota nenhuma. */
export type PanelMethod = 'GET' | 'POST'

/**
 * Chave da tabela. Metodo E caminho, porque a politica difere por metodo: o
 * `GET /__guard/magic` e inerte e publico, e o `POST` homonimo consome.
 *
 * O caminho passa por `canonicalRequestPath` dos DOIS lados -- na construcao da
 * chave e na consulta -- para que `/__guard/`, `//__guard`, `/__GUARD` e
 * `/x/../__guard` nao possam designar uma entrada diferente da que a tabela
 * declara.
 */
export function routeKeyOf(method: string, path: string): string {
  return `${method.toUpperCase()} ${canonicalRequestPath(path)}`
}

/**
 * A TABELA. Literal, enumerada, uma linha por rota.
 *
 * As tres isencoes sao as tres de `01-ARQUITETURA.md` 3(e), e cada uma traz o
 * controlo que substitui o gate:
 *
 *   POST /__guard/api/login  -- e ONDE a credencial e apresentada; guarda-la
 *                               atras da credencial era um ciclo. Controlo: o
 *                               limitador de T2.3 e o teto de falhas.
 *   GET  /__guard/magic      -- INERTE. Nao consome, nao emite sessao, nao le
 *                               nada do pedido. Controlo: nao ha nada a proteger.
 *   POST /__guard/magic      -- consome o `mk`. Controlo: o proprio `mk` (128
 *                               bits, TTL 120 s, uso unico) mais o token
 *                               anti-CSRF, que e o sinal de clique.
 *   GET  /__guard/secret     -- travada por posse do TERMINAL (`ott`), e nao por
 *                               "origem loopback", que e inerte sob tunel.
 *                               Sem `ott` valido: 404 identico ao de rota
 *                               inexistente.
 */
const TABELA_DE_POLITICA: ReadonlyArray<readonly [string, PanelPolicy]> = [
  [routeKeyOf('GET', PANEL_PATH_ROOT), 'exige-sessao'],
  [routeKeyOf('GET', PANEL_PATH_STATE), 'exige-sessao'],
  [routeKeyOf('POST', PANEL_PATH_LOGIN), 'publica'],
  [routeKeyOf('GET', PANEL_PATH_MAGIC), 'publica'],
  [routeKeyOf('POST', PANEL_PATH_MAGIC), 'publica'],
  [routeKeyOf('GET', PANEL_PATH_SECRET), 'publica'],
]

export const PANEL_ROUTE_POLICY: ReadonlyMap<string, PanelPolicy> = new Map(TABELA_DE_POLITICA)

/**
 * A politica de uma rota. AUSENTE DA TABELA => `'exige-sessao'`.
 *
 * Este `??` e o desenho inteiro em dois caracteres: o default e FECHADO. Trocar
 * por `'publica'` faria toda rota futura nascer aberta, e nada no compilador
 * acusaria.
 */
export function policyForRouteKey(key: string): PanelPolicy {
  return PANEL_ROUTE_POLICY.get(key) ?? 'exige-sessao'
}

export function policyForRoute(method: string, path: string): PanelPolicy {
  return policyForRouteKey(routeKeyOf(method, path))
}

/** As chaves ISENTAS do gate, para o teste de superficie as comparar por conjunto. */
export function panelPublicRouteKeys(): readonly string[] {
  const keys: string[] = []
  for (const [key, policy] of PANEL_ROUTE_POLICY) {
    if (policy === 'publica') keys.push(key)
  }
  return keys
}

/* ========================================================================== */
/* 2. Rotas e dependencias                                                    */
/* ========================================================================== */

export interface PanelRoute {
  readonly method: PanelMethod
  /** Caminho canonico. Comparado com `canonicalRequestPath(req.url)`. */
  readonly path: string
  readonly handler: PanelHandler
}

/**
 * Evento da recusa de CSRF.
 *
 * UM NOME SO, PARA TODAS AS ROTAS. Antes, `POST /__guard/magic` mapeava a
 * recusa de CSRF para `magic.crawler-suspect` -- e a revisao adversarial
 * mostrou que isso era ruido disfarcado de alarme: um `POST` sem token
 * normalmente nem `mk` traz, ou seja, o evento disparava onde nao havia nada a
 * proteger. O sinal de `crawler-suspect` vive agora em `magic.ts`, com o `mk`
 * em mao e antes de o consumir.
 */
export const CSRF_REJECTION_EVENT = 'painel_csrf_recusado'

export interface PanelDeps {
  readonly log: GuardLogger
  readonly audit: Pick<AuditSink, 'append'>
  /** `realm` do desafio Basic. Vem da `Config` de T3.3; nao e segredo. */
  readonly realm: string
  readonly snapshot: () => TunnelSnapshot
  readonly secrets: Pick<SecretStore, 'verify'>
  readonly sessions: Pick<GuardSessionStore, 'regenerate' | 'validate'>
  readonly magic: Pick<MagicStore, 'consume'>
  readonly ott: Pick<OneTimeTokenStore, 'consume'>
  /** Ver `SecretRevealDeps` em `secret.ts`. `null` = nada para mostrar. */
  readonly reveal: () => string | null
  readonly limiter: FailureTracker
  readonly csrf: CsrfGuard
  /**
   * Relogio do porteiro de auditoria (`04-TESTES.md` 8.1). E o que torna a
   * janela de rajada testavel sem esperar cinco minutos.
   */
  readonly clock: { now(): number }
  /** Espera do limitador. Injetada em teste; nunca se espera tempo real. */
  readonly wait?: (ms: number) => Promise<void>
  /** Ver {@link defaultIdentify}. */
  readonly identify?: (req: IncomingMessage) => Identity
  /**
   * A ORIGEM EFETIVA DO PEDIDO (`{ scheme, host }`), que e o que
   * `serializeSessionCookie` exige para decidir se pode sequer emitir a sessao.
   *
   * >>> OBRIGATORIA, E SEM VALOR POR OMISSAO. <<< Havia aqui um
   * `defaultResolveOrigin` local que decidia "host nao-loopback => acredito no
   * `X-Forwarded-Proto`". A condicao era LARGA DEMAIS e por isso errada: uma
   * instalacao em LAN (`192.168.1.5:3080`, sem tunel nenhum) e nao-loopback e
   * NAO tem borda a frente -- ali o cabecalho e escrito por qualquer maquina do
   * segmento, e a medicao que o legitima (R10, `docs/spikes/cloudflared.md:155`:
   * a borda da Cloudflare SOBRESCREVE `X-Forwarded-Proto`, o cliente enviou
   * `http` e a origem viu `https`) e sobre a BORDA, nao sobre "vir de fora".
   *
   * A implementacao correcta e `createRequestOriginResolver`
   * (`src/http/session-auth.ts`, reexportada por `src/index.ts`): a condicao
   * dela e `exposure.mode === 'tunnel'` **E** o pedido ter chegado pelo nome
   * publico do tunel. Ela precisa da `Config` e do registo da origem do tunel,
   * que o painel nao tem por que conhecer -- dai a injeccao.
   *
   * PORQUE NAO FICA UM DEFAULT "SEGURO" NO LUGAR: um default aqui e uma decisao
   * de seguranca tomada por quem NAO tem a informacao para a tomar, e o campo
   * opcional garantia que um dia alguem compunha o painel sem reparar. Sendo
   * obrigatoria, o `tsc` recusa a composicao que se esqueca dela.
   */
  readonly resolveOrigin: (req: IncomingMessage) => RequestOrigin
}

/**
 * Espera de producao.
 *
 * `unref()` porque um castigo de 30 s NAO pode segurar o event loop do processo
 * que hospeda o DSH inteiro quando ele quer desligar. Um pedido em voo que
 * perde a resposta durante o encerramento e o resultado correcto; um host que
 * nao encerra nao e.
 */
function defaultWait(ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

/**
 * Identidade contra a qual o limitador conta.
 *
 * `{}` -- SEM IP -- e o default, e e o correcto enquanto `trustEdgeHeaders` for
 * `false`. Medido no spike S2: sob `cloudflared` a origem do socket e SEMPRE
 * `127.0.0.1`, `X-Forwarded-For` e ACRESCENTADO ao valor que o cliente enviar
 * (logo forjavel) e `CF-Connecting-IP` pode ser forjado por qualquer processo
 * local que se ligue direto. Um IP escolhido pelo atacante como chave do
 * limitador transforma o limitador num brinquedo. Sem IP, conta-se no balde
 * global -- que, por decisao de `ratelimit/policy.ts`, nunca e banido.
 */
function defaultIdentify(): Identity {
  return {}
}

/**
 * As rotas do painel nesta onda.
 *
 * ESTA LISTA NAO DECIDE POLITICA. Ela diz o que existe; a tabela diz o que e
 * publico. Acrescentar uma entrada aqui e so isso: uma rota nova, guardada.
 */
export function panelRoutes(deps: PanelDeps, audit: AuditGate): readonly PanelRoute[] {
  const wait = deps.wait ?? defaultWait

  return [
    {
      method: 'GET',
      path: PANEL_PATH_ROOT,
      handler: createPanelPageHandler({ log: deps.log }),
    },
    {
      method: 'GET',
      path: PANEL_PATH_STATE,
      handler: createStateHandler({ snapshot: deps.snapshot }),
    },
    {
      method: 'POST',
      path: PANEL_PATH_LOGIN,
      handler: createLoginHandler({
        secrets: deps.secrets,
        sessions: deps.sessions,
        limiter: deps.limiter,
        wait,
        audit,
        log: deps.log,
      }),
    },
    {
      method: 'GET',
      path: PANEL_PATH_MAGIC,
      handler: createMagicPageHandler({
        magicBinding: routeKeyOf('POST', PANEL_PATH_MAGIC),
        loginBinding: routeKeyOf('POST', PANEL_PATH_LOGIN),
      }),
    },
    {
      method: 'POST',
      path: PANEL_PATH_MAGIC,
      handler: createMagicConsumeHandler({
        magic: deps.magic,
        sessions: deps.sessions,
        limiter: deps.limiter,
        wait,
        audit,
        log: deps.log,
      }),
    },
    {
      method: 'GET',
      path: PANEL_PATH_SECRET,
      handler: createSecretHandler({
        ott: deps.ott,
        reveal: deps.reveal,
        audit,
        log: deps.log,
      }),
    },
  ]
}

/* ========================================================================== */
/* 3. Despacho                                                                */
/* ========================================================================== */

/** Escreve o envelope. UNICO sitio que toca no `ServerResponse` deste modulo. */
export function writePanelResponse(res: ServerResponse, response: PanelResponse): void {
  if (res.writableEnded || res.headersSent) return
  const headers: Record<string, string | string[]> = { ...response.headers }
  if (response.setCookie !== undefined) headers['set-cookie'] = response.setCookie
  res.writeHead(response.status, headers)
  res.end(response.body)
}

/** O token apresentado: cabecalho primeiro, campo de corpo a seguir. */
function presentedCsrfToken(
  req: IncomingMessage,
  fields: ReadonlyMap<string, string>,
): string | undefined {
  const header = req.headers[CSRF_HEADER_NAME]
  // Um array significa cabecalho REPETIDO. Escolher um deles e escolher o do
  // atacante em metade dos casos; recusa-se, como no cookie duplicado.
  if (typeof header === 'string') return header
  if (Array.isArray(header)) return undefined
  return fields.get(CSRF_FIELD_NAME)
}

/** Fabrica da lista de rotas. Ver o parametro `routes` de {@link createPanelRouter}. */
export type PanelRouteFactory = (deps: PanelDeps, audit: AuditGate) => readonly PanelRoute[]

/**
 * Constroi o tratador HTTP do painel.
 *
 * @param routes FABRICA, e nao lista. O default e {@link panelRoutes}; o teste
 * de superficie passa `(d, g) => [...panelRoutes(d, g), rotaNova]` para provar
 * que uma rota ausente da tabela nasce GUARDADA. E fabrica e nao lista porque o
 * porteiro de auditoria tem de ser UM SO -- as rotas e o despachante partilham a
 * contagem de rajada, e dois porteiros dariam ao atacante o dobro das linhas.
 */
export function createPanelRouter(
  deps: PanelDeps,
  routes: PanelRouteFactory = panelRoutes,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const resolveOrigin = deps.resolveOrigin
  const identify = deps.identify ?? defaultIdentify
  const audit = createAuditGate({ audit: deps.audit, log: deps.log, clock: deps.clock })

  // O caminho declarado por cada rota e canonicalizado UMA vez, na construcao.
  // O lado do pedido ja passa por `canonicalRequestPath`; sem isto, uma rota
  // futura escrita como `/__guard/api/tunnel/start/` ou `/__GUARD/...` nunca
  // casaria -- e a falha seria um 404 silencioso em vez de um erro.
  const tabelaDeRotas: readonly PanelRoute[] = routes(deps, audit).map((rota) => ({
    ...rota,
    path: canonicalRequestPath(rota.path),
  }))

  const dispatch = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const method = (req.method ?? '').toUpperCase()

    // (0) Defesa em profundidade sobre o ponto de montagem. Este despachante so
    // serve `/__guard`; se alguem o montar noutro sitio, ele nao responde nada
    // -- em vez de servir o painel a partir de um caminho que a tabela nao
    // descreve.
    if (!isGuardedPath(req.url, [PANEL_PREFIX])) {
      deps.log.warn(`[painel] pedido fora de ${PANEL_PREFIX} chegou ao painel: ${method} ${path}`)
      writePanelResponse(res, NOT_FOUND_RESPONSE)
      return
    }

    // (1) CHAVE, POLITICA E SESSAO PARA TODOS OS PEDIDOS, inclusive os que nao
    // casam rota nenhuma.
    //
    // A ordem parece desperdicio e nao e: a revisao adversarial mediu que o
    // caminho da rota EXISTENTE era distinguivel no tempo do caminho da rota
    // inexistente, e parte da diferenca era exatamente este trabalho -- uma
    // canonicalizacao extra, uma consulta a tabela e uma validacao de sessao
    // que so o primeiro pagava. Calculado aqui, os dois pagam o mesmo.
    //
    // A chave e calculada UMA vez e reutilizada pela politica e pelo vinculo do
    // token anti-CSRF; antes eram duas canonicalizacoes do mesmo caminho.
    const chave = routeKeyOf(method, path)
    const policy = policyForRouteKey(chave)
    const presentedSessionId = readSessionCookie(req.headers.cookie)
    const session = presentedSessionId === null ? null : deps.sessions.validate(presentedSessionId)

    // (2) A rota existe? Vem DEPOIS da politica no calculo, mas ANTES dela na
    // decisao: um caminho que nao existe tem de responder 404 a toda a gente --
    // e o mesmo 404 que `/__guard/secret` sem `ott` devolve.
    const route = tabelaDeRotas.find(
      (candidate) => candidate.method === method && candidate.path === path,
    )
    if (route === undefined) {
      writePanelResponse(res, NOT_FOUND_RESPONSE)
      return
    }

    if (policy === 'exige-sessao' && session === null) {
      deps.log.warn(`[painel] 401 em ${method} ${path} (sem sessao valida).`)
      // O MESMO 401 do gate, com o mesmo corpo e o mesmo `WWW-Authenticate`.
      // Reutilizado e nao reescrito: dois literais do mesmo 401 divergem na
      // primeira melhoria de redaccao, e a divergencia e um oraculo.
      challengeBasicAuth(res, deps.realm)
      return
    }

    // (3) Corpo e CSRF -- so nos `POST`, e para TODOS eles.
    let fields = emptyFields()
    if (method === 'POST') {
      const parsed = await readRequestBody(req, MAX_BODY_BYTES)
      if (!parsed.ok && parsed.reason === 'too-large') {
        writePanelResponse(res, PAYLOAD_TOO_LARGE_RESPONSE)
        return
      }
      if (parsed.ok) fields = parsed.fields

      // O VINCULO SEGUE A POLITICA, E NAO A PRESENCA DE SESSAO. A distincao
      // parece cosmetica e nao e -- foi um defeito real apanhado por
      // `ANTI-FIXATION` em `test/unit/panel/api.test.ts`:
      //
      //   Com "vinculo = sessao, se houver", um cliente que chegasse a
      //   `POST /__guard/api/login` COM um cookie de sessao ainda valido
      //   passava a precisar de um token vinculado a essa sessao -- mas o
      //   token que ele tem foi emitido para a ROTA, porque o login e publico
      //   e serve-se antes de existir sessao. Resultado: 403 no login.
      //   Exatamente para quem mais precisa dele (sessao a expirar, sessao
      //   plantada, re-autenticacao) e sem nada no corpo a explicar porque.
      //
      // Uma rota publica NUNCA pode depender da sessao -- e essa e a mesma
      // razao pela qual `POST /__guard/magic`, que acontece ANTES de haver
      // sessao, obrigou `csrf.ts` a assinar um vinculo arbitrario.
      const binding = policy === 'publica' || session === null ? chave : session.idHash

      if (!deps.csrf.verify(presentedCsrfToken(req, fields), binding)) {
        // QUEM TEM SESSAO E ESCRITO EM CHEIO; quem nao tem e AGREGADO.
        //
        // Uma recusa de CSRF a um anonimo nao e uma tentativa de autenticacao e
        // NAO passa pelo limitador de T2.3 -- que e a condicao com que
        // `src/audit/log.ts` justifica nao ter rotacao. A revisao adversarial
        // mediu 1,2-1,8 MiB/s de crescimento do ficheiro a partir daqui, com um
        // cliente anonimo e sem uma unica espera pedida ao limitador.
        //
        // Com sessao valida e outra coisa: e o dono, ou alguem com o cookie
        // dele, e ai cada linha vale.
        if (session === null) {
          audit.recordAnonymousRejection(CSRF_REJECTION_EVENT)
        } else {
          audit.append({
            evento: CSRF_REJECTION_EVENT,
            resultado: 'negado',
            sessao_id_hash: session.idHash,
          })
        }
        deps.log.warn(`[painel] 403 em ${method} ${path} (token anti-CSRF ausente ou invalido).`)
        // O `mk` NAO foi tocado: o tratador nem chegou a correr. Isso continua
        // a valer -- o que NAO vale, e foi retirado, e a afirmacao de que este
        // token prova um clique humano. Ver o cabecalho de `magic.ts`.
        writePanelResponse(res, FORBIDDEN_RESPONSE)
        return
      }
    }

    const exchange: PanelExchange = {
      req,
      method,
      path,
      rawUrl: req.url ?? '/',
      origin: resolveOrigin(req),
      identity: identify(req),
      session,
      presentedSessionId,
      fields,
      csrf: deps.csrf,
    }

    writePanelResponse(res, await route.handler(exchange))
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // `path` e calculado aqui para poder aparecer no log do caminho de erro. O
    // `req.url` CRU nunca e registado: ele carrega `?ott=<token>`, que abre o
    // segredo. Este e o unico ficheiro onde essa distincao importa e por isso
    // e o unico onde ela esta escrita.
    const path = canonicalRequestPath(req.url)

    try {
      await dispatch(req, res, path)
    } catch (error) {
      deps.log.error(
        maskAuditText(
          `[painel] excecao ao servir ${String(req.method)} ${path}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      // FECHA-SE. Nenhum caminho de erro deste despachante termina em "deixa
      // passar": nao ha delegado, nao ha `next`, nao ha resposta parcial que
      // um cliente possa interpretar como sucesso.
      if (res.headersSent || res.writableEnded) {
        res.end()
        return
      }
      writePanelResponse(res, INTERNAL_ERROR_RESPONSE)
    }
  }
}
