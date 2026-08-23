/**
 * =============================================================================
 * `createGuardedHandler`, `createGuardedUpgradeHandler` -- a POLITICA do portao.
 * =============================================================================
 *
 * Estes dois construtores decidem; nao sabem onde estao instalados. Quem os
 * instala e `src/http/intercept.ts` (dono do despacho do `node:http.Server`).
 * Separar as duas coisas e o que permite testar a decisao sem socket e a
 * mecanica sem credencial.
 *
 * -----------------------------------------------------------------------------
 * A ORDEM DAS VERIFICACOES E CONTRATO. INVERTE-LA E REGRESSAO DE SEGURANCA.
 * -----------------------------------------------------------------------------
 *
 *   L2   `trustedRemotes`  -> 403  quem esta do outro lado do socket
 *   L2.5 `Host`            -> 403  por que NOME o recurso foi pedido
 *   L3   sessao/credencial -> 401  quem e
 *
 * Os dois codigos NAO sao intermutaveis, e a diferenca e semantica:
 *
 *   - 403 diz "repetir a credencial NAO ajuda": o pedido nunca chega a
 *     autenticacao. Devolver 401 aqui daria ao atacante um oraculo para
 *     adivinhar credenciais a partir de uma origem que nunca sera aceite;
 *   - 401 diz "identifica-te", e vem com o desafio `WWW-Authenticate`.
 *
 * >>> COM SESSAO ATIVA, `trustedRemotes` CONTINUA A SER AVALIADO ANTES. <<<
 * A sessao e verificada em L3, depois de L2 e de L2.5. Se um cookie valido
 * pudesse curto-circuitar L2, um portador vindo de uma origem recusada passaria
 * a receber 401 em vez de 403 -- e a ordem 403-antes-de-401 perder-se-ia sem que
 * nenhum teste de credencial acusasse.
 *
 * >>> OS DOIS 403 SAO BYTE A BYTE IGUAIS, e isso e deliberado. <<<
 * `denyUntrustedOrigin` e usado tanto para a origem do socket como para o
 * `Host`: distinguir os dois diria ao atacante QUAL das duas camadas o barrou, e
 * portanto qual delas vale a pena atacar a seguir.
 *
 * -----------------------------------------------------------------------------
 * O CORPO DA REQUISICAO NAO E LIDO. NUNCA.
 * -----------------------------------------------------------------------------
 * A decisao usa exclusivamente metodo, URL, cabecalhos e endereco do socket. O
 * comando perigoso viaja no corpo do `POST /api/commands/execute`; ler o corpo
 * no caminho de decisao introduziria consumo de stream, buffering e uma
 * superficie de negacao de servico no ponto exato onde nao pode haver nenhuma.
 * E, num pedido aprovado, o corpo ja consumido nunca chegaria ao despacho
 * original -- o servidor do DSH fecharia o socket com um HTTP 400 opaco.
 * =============================================================================
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

import type { Config } from '../config/schema.ts'
import type { Context, WebRequestHandler, WebUpgradeHandler } from '../dsh/adapter.ts'
import type { GuardLogger } from '../logging/logger.ts'
import { verifyBasicAuth } from './auth-basic.ts'
import {
  buildAllowedRequestHosts,
  canonicalRequestHost,
  isAllowedRequestHost,
  isLoopbackRequestHost,
} from './host-header.ts'
import { isTrustedRemote } from './origin.ts'
import { isGuardedPath } from './path.ts'
import { denyNotFound, denyUnauthorized, denyUntrustedOrigin, denyUpgrade } from './responses.ts'
import {
  authenticateRequest,
  recordAudit,
  rewriteAuthenticatedTunnelRequest,
  type GateAuth,
  type TunnelOriginRegistry,
} from './session-auth.ts'
import { emitSessaoNova, type SessaoNovaEvent } from '../audit/events.ts'
import { readSessionCookie } from '../session/cookie.ts'
import type { LinkTokenStore } from '../session/link-token.ts'

/** Tudo o que o portao precisa de saber, injetado -- nada resolvido por dentro. */
export interface GateDeps {
  readonly ctx: Context
  readonly log: GuardLogger
  readonly config: Config
  /**
   * As primitivas da Onda 2, obtidas SOB PROCURA.
   *
   * PORQUE UM THUNK E NAO O OBJETO: montar a pilha ABRE FICHEIROS (o
   * `state.json` e o `audit.log`). Faze-lo em `apply()` significaria que
   * carregar o plugin -- num harness que talvez nunca sirva um pedido -- criava
   * ficheiros na casa do operador. O thunk e MEMOIZADO por quem o fornece: a
   * pilha e montada uma vez, no primeiro pedido que precisa de decidir.
   *
   * SE LANCAR, O PORTAO NEGA. Nunca "serve sem portao": ver o `catch` do
   * caminho de decisao.
   */
  readonly auth: () => GateAuth
  /** Leitura da origem publica do tunel. Barata e sem I/O -- por isso nao e thunk. */
  readonly tunnelOrigin: Pick<TunnelOriginRegistry, 'current'>
  /** `ctx.webServer.host` -- o endereco por que este servidor responde de facto. */
  readonly bindHost: string
  /** `host:porta` do bind. Destino da reescrita de `Host` dos pedidos do tunel. */
  readonly loopbackAuthority: string
  /**
   * Prefixos de CANAL LOCAL APENAS -- recusados com 404 quando o pedido nao
   * chegou por um nome de loopback.
   *
   * ===========================================================================
   * L2.6. EXISTE PORQUE L2 E L2.5 NAO SEPARAM O LOCAL DO REMOTO SOB TUNEL.
   * ===========================================================================
   * O raciocinio que faltava, e que custou um furo real nesta entrega: eu tinha
   * escrito que a isencao de credencial era segura porque "L2 (`trustedRemotes`)
   * e L2.5 (`Host`) continuam a correr". O raciocinio esta certo; a PREMISSA e
   * que estava errada. Sob `cloudflared`, um pedido vindo da internet:
   *
   *   - passa L2, porque quem abre o socket e o `cloudflared`, em `127.0.0.1`;
   *   - passa L2.5, porque a origem do tunel e DELIBERADAMENTE acrescentada a
   *     allowlist de `Host` enquanto ele esta `READY`.
   *
   * As duas camadas defendem de outros processos locais e de DNS rebinding.
   * Nao defendem da internet que o tunel deixa entrar de proposito -- e nao e
   * suposto defenderem. Uma rota "canal local apenas" precisa da sua propria
   * pergunta, e e {@link isLoopbackRequestHost} que a faz.
   *
   * O CASO CONCRETO e `GET /__guard/secret?ott=...`, que entrega o SEGREDO
   * PERSISTENTE em texto claro. `02-SEGURANCA.md` 4.4 e literal:
   * **"Canal local apenas, sem excecao"**, e escreve o endereco com
   * `127.0.0.1`. Nao e ilustracao, e o controlo. O `ott` tem 128 bits, uso
   * unico e 10 minutos -- forca bruta e inviavel --, mas ele e impresso no
   * STDOUT DO TERMINAL: vive em scrollback, em multiplexador, em gravacao de
   * sessao, em captura de ecra. O desenho tolera isso PORQUE a rota so e
   * alcancavel de quem ja esta na maquina. Alcancavel da internet, todo o peso
   * passava para um segredo de 10 minutos que nunca foi desenhado para o
   * carregar sozinho.
   *
   * A RECUSA E 404, NUNCA 403. Um 403 anunciava duas coisas de uma vez: que a
   * rota EXISTE e que o pedido chegou do sitio errado. O 404 sai por
   * {@link denyNotFound}, que e a MESMA funcao que a rota usa para um `ott`
   * invalido -- e e por ser a mesma funcao que os bytes nao podem divergir.
   *
   * ISTO CORRE ANTES DA ISENCAO, e portanto vale tanto para rotas isentas de
   * credencial como para rotas guardadas. Corre nas DUAS superficies -- request
   * e upgrade --, mas a forma de recusar difere e a diferenca esta justificada
   * no proprio ponto: 404 no request (onde ha isencoes e um 403 confirmaria a
   * rota), 401 no upgrade (onde 401 ja e a resposta universal e qualquer outro
   * codigo criaria um sinal novo).
   */
  readonly loopbackOnlyPrefixes: readonly string[]
  /**
   * Prefixos que o portao deixa passar SEM CREDENCIAL.
   *
   * ---------------------------------------------------------------------------
   * SUBSTITUI O PARAMETRO `alwaysGuarded`, QUE ERA DORMENTE (decisao declarada)
   * ---------------------------------------------------------------------------
   * `createGuardedHandler` recebia um booleano `alwaysGuarded` que a raiz de
   * composicao passava sempre como `true` literal, e NENHUMA chave de
   * configuracao o podia mudar. Um controlo que PARECE configuravel e nao e, e
   * pior do que nao existir: um leitor conclui que ha uma politica por rota que
   * nao ha. Foi REMOVIDO.
   *
   * O que existe no lugar e a necessidade REAL que ele fingia servir: o painel
   * `/__guard` precisa de UMA porta sem credencial, senao nunca ha como
   * autenticar -- `POST /__guard/api/login` e o passo que CRIA a sessao. Esta
   * lista e essa porta, e nada mais.
   *
   * A comparacao e por SEGMENTO (`isGuardedPath`, ja canonicalizado): `/x/login`
   * cobre `/x/login` e `/x/login/passo2`, mas NAO cobre `/x/loginX`. A isencao
   * dispensa L3 -- L2, L2.5 e L2.6 continuam a correr.
   *
   * >>> CUIDADO COM A PREMISSA, que ja falhou uma vez. <<< "L2 e L2.5 continuam
   * a correr" NAO significa "isto so e alcancavel localmente": sob tunel elas
   * passam as duas, por desenho. Uma rota isenta de credencial e alcancavel da
   * INTERNET enquanto o tunel estiver de pe. As duas que aqui estao aguentam-no
   * -- `/__guard/magic` existe precisamente para ser aberto do telemovel pelo
   * tunel, e `/__guard/api/login` TEM de ser alcancavel de fora ou nao ha como
   * autenticar. Uma rota que NAO aguente pertence a
   * {@link GateDeps.loopbackOnlyPrefixes}, e nao a esta lista.
   */
  readonly unauthenticatedPrefixes: readonly string[]
  /**
   * A CHAVE NO LINK (`?key=<token>`), validada por este store.
   *
   * Onda 1 (remocao do login): o acesso pelo TUNEL entra por SESSAO ou por
   * esta chave; a chave em si NAO da acesso -- validar aqui e trocar por uma
   * sessao (`issueSession`, mais abaixo), que e como o navegador passa a
   * estar autenticado. `emitir()` e dono da Onda 2 (o bot compoe a URL).
   */
  readonly linkToken: Pick<LinkTokenStore, 'verificar'>
  /**
   * Emite uma sessao para um request e devolve a linha `Set-Cookie`, ou
   * `null` se a origem NAO entregar cookie `Secure` (ex.: LAN em `http`).
   *
   * E o caminho obrigatorio do fluxo `?key=` do portao: uma chave VALIDA e a
   * antecessora de uma sessao emitida com `regenerate` (anti-fixation) e o
   * cookie correspondente. Fiado em `src/index.ts`, onde a pilha de sessoes e
   * a `Config` existem.
   */
  readonly issueSession: (
    req: IncomingMessage,
    presentedSessionId: string | undefined,
  ) => string | null
}

/**
 * O cabecalho, quando e UMA string.
 *
 * >>> COLAPSA DUAS COISAS DIFERENTES EM `undefined`: "ausente" e "repetido". <<<
 * O JSDoc anterior dizia "um array e recusado", e isso so e verdade quando quem
 * chama LE `undefined` COMO RECUSA. Vale para `host` (sem `Host` nao ha
 * allowlist que case -> 403), para `authorization` e para `cookie` (nada
 * apresentado -> 401). NAO valia para `origin`, onde `undefined` significa
 * "nao ha origem para validar" e SALTAVA a validacao inteira -- um array
 * transformava a defesa de CWE-1385 num `if` que nao corre.
 *
 * Quem precisa de distinguir "ausente" de "repetido" tem de olhar para
 * `req.headers[...]` diretamente, e e exatamente o que o caminho de `Origin`
 * passou a fazer. Esta funcao fica para os casos em que as duas leituras
 * desaguam na mesma recusa.
 */
function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Reduz uma origem (`https://host:porta`) a uma CHAVE DE COMPARACAO canonica.
 *
 * >>> ALLOWLIST EXATA, NUNCA "CONTEM". <<< E a diferenca entre recusar e aceitar
 * `Origin: https://evil.com/?x=meudominio.com`, que CONTEM o nosso dominio e nao
 * E o nosso dominio. Compara-se esquema + host + porta, cada um extraido por um
 * parser de URL -- nunca por `includes`, `startsWith` ou expressao regular sobre
 * a string crua.
 *
 * A porta por omissao do esquema e retirada, para que `https://x` e
 * `https://x:443` sejam a mesma origem (que e o que sao).
 */
export function canonicalOrigin(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  // `null` e o que o navegador envia de uma origem opaca (sandbox, `data:`,
  // redirecionamento entre esquemas). Nunca e nossa.
  if (raw === 'null') return undefined

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return undefined
  }

  const scheme = parsed.protocol.replace(/:$/u, '').toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') return undefined

  const host = canonicalRequestHost(parsed.hostname)
  if (host === undefined) return undefined

  const isDefaultPort =
    parsed.port === '' ||
    (scheme === 'http' && parsed.port === '80') ||
    (scheme === 'https' && parsed.port === '443')

  return isDefaultPort ? `${scheme}://${host}` : `${scheme}://${host}:${parsed.port}`
}

/**
 * As origens de que este servidor aceita um handshake de WebSocket.
 *
 * O tunel entra SE E SO SE estiver `READY`, e SAI quando cai. Uma entrada morta
 * seria uma origem que continua a ser aceite depois de deixar de nos pertencer.
 */
export function buildAllowedOrigins(
  loopbackAuthority: string,
  tunnelOrigin: string | undefined,
): readonly string[] {
  const origins = new Set<string>()

  const port = loopbackAuthority.includes(':')
    ? loopbackAuthority.slice(loopbackAuthority.lastIndexOf(':') + 1)
    : ''
  const suffix = port === '' ? '' : `:${port}`

  // As duas grafias que o navegador poe no `Origin` para o mesmo servidor local.
  for (const candidate of [
    `http://127.0.0.1${suffix}`,
    `http://localhost${suffix}`,
    `http://${loopbackAuthority}`,
  ]) {
    const canonical = canonicalOrigin(candidate)
    if (canonical !== undefined) origins.add(canonical)
  }

  const tunnel = canonicalOrigin(tunnelOrigin)
  if (tunnel !== undefined) origins.add(tunnel)

  return [...origins]
}

/**
 * L2 + L2.5. `true` = o pedido foi recusado no perimetro e nao chega a L3.
 *
 * NAO AUDITA. Ver o bloco "O QUE NAO E AUDITADO" em `session-auth.ts`: uma linha
 * por recusa de perimetro -- um caminho que qualquer pessoa alcanca sem
 * credencial e sem limite -- deixa encher o volume do log de auditoria, e com a
 * auditoria fail-closed isso faz o portao negar TUDO. Fica no log do operador.
 */
function refusedAtPerimeter(deps: GateDeps, req: IncomingMessage, surface: string): boolean {
  const { config, log } = deps

  if (!isTrustedRemote(req.socket.remoteAddress, config.trustedRemotes)) {
    log.warn(
      `[${surface}] Origem nao confiada recusada: ` +
        `${String(req.socket.remoteAddress)} -> ${String(req.method)} ${String(req.url)}`,
    )
    return true
  }

  const allowedHosts = buildAllowedRequestHosts(deps.bindHost, deps.tunnelOrigin.current())
  if (!isAllowedRequestHost(singleHeader(req, 'host'), allowedHosts)) {
    log.warn(
      `[${surface}] Host recusado (L2.5, anti DNS rebinding): ` +
        `'${String(req.headers.host)}' nao consta de [${allowedHosts.join(', ')}].`,
    )
    return true
  }

  return false
}

/**
 * Tira a `key` do query e devolve o caminho+resto para o 302 do fluxo `?key=`.
 *
 * O redirect tem de levar o navegador para a URL LIMPA (sem `key`), para que a
 * chave que viajou no link saia do endereco assim que a sessao existir. Todos
 * os OUTROS parâmetros sao preservados. `undefined` se o query for ilegivel.
 */
function stripKeyParam(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const q = raw.indexOf('?')
  if (q === -1) return raw
  const before = raw.slice(0, q)
  const params = new URLSearchParams(raw.slice(q + 1))
  params.delete('key')
  const resto = params.toString()
  return resto.length === 0 ? before : `${before}?${resto}`
}

/**
 * Lê o valor de `key` no query do pedido, ou `undefined` quando ausente.
 *
 * `key` repetido (`?key=a&key=b`) -- como qualquer parâmetro repetido -- resolve
 * para o PRIMEIRO valor, por semantica de `URLSearchParams.get`. Isso e a
 * leitura mais conservadora (nunca escolher uma segunda ocorrencia apos uma
 * primeira). O resultado segue para `LinkTokenStore.verificar`, que devolve
 * `false` para qualquer candidato fora do alfabeto.
 */
function extrairChaveDoQuery(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const q = raw.indexOf('?')
  if (q === -1) return undefined
  return new URLSearchParams(raw.slice(q + 1)).get('key') ?? undefined
}

/**
 * Teto da memoria de "sessoes ja vistas" do ponto de chamada PREP 5.
 *
 * PORQUE EXISTE: sem teto, um host com meses de uptime acumularia um hash por
 * sessao emitida — crescimento sem limite. 1024 espelha
 * `MAX_TRACKED_IDENTITIES` de session-auth.ts; a eviccao tira a MAIS ANTIGA
 * (Map preserva ordem de insercao). Consequencia aceite e documentada: uma
 * sessao expulsa pode re-notificar ao voltar — notificar duas vezes e melhor
 * do que nao notificar.
 */
const SESSAO_NOVA_TETO = 1024

/**
 * Constroi o handler guardado que envolve um despacho original.
 *
 * A SUPERFICIE E GUARDADA INTEIRA, e isso e estrutural: no ponto de despacho
 * existe o `req` (metodo, pathname, cabecalhos) mas NAO a identidade do plugin
 * dono da rota. A unica excecao e {@link GateDeps.unauthenticatedPrefixes}, e o
 * JSDoc dela explica porque existe e porque e minima.
 */
export function createGuardedHandler(
  deps: GateDeps,
  delegate: WebRequestHandler,
  surface: string,
): WebRequestHandler {
  const { ctx, log, config } = deps

  /** Sessoes ja VISTAS por este handler (ponto de chamada PREP 5). */
  const sessoesVistas = new Map<string, true>()

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let authorized: boolean
    let viaTunnel = false
    let auth: GateAuth

    try {
      /* ---- L2 + L2.5 ---------------------------------------------------- */
      if (refusedAtPerimeter(deps, req, surface)) {
        denyUntrustedOrigin(res)
        return
      }

      /* ---- L2.6: canal local apenas -------------------------------------- */
      // ANTES da isencao, de proposito: vale para rotas isentas e guardadas.
      if (
        isGuardedPath(req.url, deps.loopbackOnlyPrefixes) &&
        !isLoopbackRequestHost(singleHeader(req, 'host'))
      ) {
        log.warn(
          `[${surface}] 404 em ${String(req.url)}: rota de CANAL LOCAL APENAS ` +
            `alcancada por '${String(req.headers.host)}'. 403 confirmaria que a rota existe.`,
        )
        denyNotFound(res)
        return
      }

      /* ---- Isencao explicita (a porta de login do painel) ---------------- */
      if (isGuardedPath(req.url, deps.unauthenticatedPrefixes)) {
        await delegate(req, res)
        return
      }

      /* ---- L3: sessao ou chave no link (superficie do TUNEL) ------------- */
      // MODELO EXPOSE-PORT: esta politica corre no PROXY dedicado do tunel,
      // nao no servidor do DSH (que fica ABERTO). Por isso NUNCA ha "acesso
      // local abre": todo pedido que chega ao proxy veio do tunel (o cloudflared
      // abre o socket em 127.0.0.1) e tem de autenticar -- mesmo com um
      // `Host: 127.0.0.1:3080` FORJADO, que passa L2/L2.5 e morre AQUI em L3.
      auth = deps.auth()
      const outcome = await authenticateRequest({
        req,
        auth,
        config,
        log,
        staticCredentialMatches: (header) => verifyBasicAuth(header, config.encodedAuthString),
      })
      viaTunnel = outcome.viaTunnel

      /**
       * A CASCATA, e o que o `next` TERMINAL faz agora.
       *
       * O terminal devolve a decisao que o portao ACABOU de tomar -- com atraso,
       * auditoria e limite ja aplicados. A propriedade que tinha de sobreviver
       * sobreviveu, e ficou mais forte: SEM QUALQUER OUVINTE a politica continua
       * fail-closed, porque o valor terminal e `false` sempre que a credencial
       * nao bate. O que deixou de acontecer e a comparacao correr DUAS vezes
       * (uma no portao, outra no terminal), que duplicaria o atraso interno e
       * contaria a mesma tentativa duas vezes no limitador.
       *
       * PROPRIEDADE DA CASCATA A CONHECER (semantica do Cordis, nao bug deste
       * plugin): ganha o PRIMEIRO ouvinte que responde sem invocar `next()`. Um
       * `http/auth-check` registado por OUTRO plugin ANTES deste pode devolver
       * `true` e anular esta barreira. Auditar quem subscreve o evento faz parte
       * da instalacao segura (ver README.md).
       */
      authorized = await ctx.waterfall(
        'http/auth-check',
        req,
        async (): Promise<boolean> => outcome.authorized,
      )

      /* ---- L3.1: sessao NOVA — PONTO DE CHAMADA CONGELADO NO COMMIT PREP 5 -- */
      /**
       * Primeiro uso AUTORIZADO de uma sessao. O evento escreve no AuditSink
       * ANTES do fan-out de observadores (T5.4 implementa o consumidor em
       * `src/audit/notify.ts`): "o log e a fonte da verdade; a notificacao e
       * best-effort" (03-ONDAS 10).
       *
       * Fail-closed: se a escrita de auditoria falhar, o pedido e NEGADO com
       * o MESMO 401 de credencial errada — a doutrina da auditoria (ver
       * recordAudit) nao ganha uma excecao no caminho de sucesso.
       *
       * O CAMINHO DE UPGRADE NAO EMITE, de proposito: a primeira requisicao
       * HTTP da sessao precede qualquer upgrade com a mesma sessao (o
       * navegador pede a pagina antes de abrir o WebSocket). Se a
       * implementacao medir um caminho real em que isso nao vale, reporta
       * (03 13.2) e o PREP 6 corrige.
       */
      if (authorized && outcome.session !== null) {
        const idHash = outcome.session.idHash
        if (!sessoesVistas.has(idHash)) {
          if (sessoesVistas.size >= SESSAO_NOVA_TETO) {
            const maisAntiga = sessoesVistas.keys().next().value
            if (maisAntiga !== undefined) sessoesVistas.delete(maisAntiga)
          }
          sessoesVistas.set(idHash, true)
          const evento: SessaoNovaEvent = {
            evento: 'sessao_nova',
            resultado: 'permitido',
            sessao_id_hash: idHash,
          }
          const registado = recordAudit(deps.auth(), log, evento)
          if (!registado) {
            log.warn(
              `[${surface}] sessao nova NAO registada (auditoria indisponivel); ` +
                `pedido NEGADO (fail-closed): ${String(req.method)} ${String(req.url)}`,
            )
            denyUnauthorized(res)
            return
          }
          emitSessaoNova(evento, log)
        }
      }
    } catch (error) {
      /**
       * NENHUM CAMINHO DE ERRO TERMINA EM "DEIXA PASSAR".
       *
       * E a resposta e o MESMO 401 de credencial errada, byte a byte. Um `500`
       * aqui seria um oraculo: o atacante passava a distinguir "senha errada" de
       * "o portao rebentou" -- e "o portao rebentou" e um estado que ele pode
       * PROVOCAR (encher o disco do log de auditoria, por exemplo).
       */
      log.error(
        `[${surface}] falha no caminho de decisao; pedido NEGADO (fail-closed): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      if (!res.headersSent) denyUnauthorized(res)
      return
    }

    if (!authorized) {
      // ----------------------------------------------------------------------
      // O fluxo da CHAVE NO LINK (`GET /?key=<token>`), superficie do TUNEL.
      // ----------------------------------------------------------------------
      // Sem sessao e sem `?key=` valida, o teto e o 401 TEXTO PURO sem desafio:
      // NUNCA `WWW-Authenticate` (o popup de login do navegador foi removido).
      // Se houver uma chave valida, troca-se por uma SESSAO e o navegador segue
      // pelo 302 para a URL limpa (a chave sai do endereco).
      if (req.method === 'GET') {
        const chave = extrairChaveDoQuery(req.url)
        if (
          chave !== undefined &&
          deps.linkToken.verificar(chave) &&
          // Em MODO RESTRITO o tunel nao autentica: a chave nao e excecao.
          !(auth.restricted.isActive() && viaTunnel)
        ) {
          const apresentada = readSessionCookie(singleHeader(req, 'cookie')) ?? undefined
          const setCookie = deps.issueSession(req, apresentada)
          if (setCookie !== null) {
            const destino = stripKeyParam(req.url) ?? '/'
            // HIGH #2: loga a URL LIMPA (sem `?key=`). O `req.url` bruto
            // carrega o token de 256 bits; loga-lo seria publicar a chave.
            log.info(
              `[${surface}] chave no link VALIDA: 302 de ${destino} para a URL limpa com sessao`,
            )
            res.writeHead(302, {
              Location: destino,
              'Set-Cookie': setCookie,
              'Cache-Control': 'no-store',
              // Ver a REGRA DE FICHEIRO nas recusas; um redirect pode ser servido
              // sob a URL do tunel e nao deve vazar essa URL no Referer.
              'Referrer-Policy': 'no-referrer',
            })
            res.end()
            return
          }
        }
      }

      log.warn(
        `[${surface}] 401 em ${String(req.method)} ${String(req.url)} ` +
          '(superficie do tunel sem sessao valida e sem chave no link aceite).',
      )
      denyUnauthorized(res)
      return
    }
    // A LANDMINE DO TUNEL. Ver `rewriteAuthenticatedTunnelRequest`: isto desarma
    // o anti-rebinding do NUCLEO, e e a camada L2.5 acima que passa a sustentar
    // essa garantia. So corre DEPOIS de autenticar, e so para pedidos do tunel.
    if (viaTunnel) rewriteAuthenticatedTunnelRequest(req, deps.loopbackAuthority)

    await delegate(req, res)
  }
}

/**
 * Constroi o tratador de upgrade guardado (handshake de WebSocket).
 *
 * -----------------------------------------------------------------------------
 * PORQUE ESTA SUPERFICIE E GUARDADA POR INTEIRO, sem olhar a `guardedPrefixes`
 * -----------------------------------------------------------------------------
 * Os WebSockets NAO estao sujeitos a same-origin policy. Qualquer pagina aberta
 * no navegador da maquina pode abrir `ws://127.0.0.1:3080/...` para outra origem
 * sem qualquer permissao -- nao ha preflight, nao ha CORS. E o doc-fonte do DSH
 * regista que o canal de downlink foi migrado de SSE para um WebSocket dedicado:
 * o canal transporta estado do plano de controlo. Deixa-lo fora do portao seria
 * reabrir a #853 por outra porta.
 *
 * -----------------------------------------------------------------------------
 * CWE-1385 -- `Origin` COM ALLOWLIST EXATA
 * -----------------------------------------------------------------------------
 * Precedentes diretos: CVE-2023-26114 no code-server (CVSS 9.3) e CVE-2025-52882
 * nas extensoes do Claude Code. Ambos: handshake de WebSocket aceite a partir de
 * qualquer origem, em servidor de loopback, com execucao de codigo do outro lado.
 *
 * A comparacao e EXATA sobre esquema+host+porta ({@link canonicalOrigin}), nunca
 * "contem": `https://evil.com/?x=meudominio.com` CONTEM o nosso dominio e nao E
 * o nosso dominio.
 *
 * `Origin` AUSENTE nao e recusado aqui -- cai para a credencial. Nao e
 * indulgencia: um NAVEGADOR envia sempre `Origin` no handshake (a norma
 * WebSocket obriga-o e o script nao lhe toca), logo a ausencia significa cliente
 * NAO-navegador, e o ataque de origem cruzada -- que so um navegador consegue
 * montar -- nao se aplica. Recusar com 403 quebraria ainda a sonda
 * `websocket-upgrade` de `src/contracts/tunnel.ts`, cujo caso feliz e "socket
 * destruido OU 401": um 403 fa-la-ia concluir que o gate nao esta armado e o
 * tunel nunca subiria. Sem credencial, um cliente sem `Origin` continua a levar
 * 401 -- que e exatamente o que a sonda espera.
 *
 * -----------------------------------------------------------------------------
 * NAO HA ISENCOES NESTA SUPERFICIE, e a ausencia e a decisao
 * -----------------------------------------------------------------------------
 * {@link GateDeps.unauthenticatedPrefixes} NAO e consultado aqui. As tres portas
 * isentas existem para ANTECEDER a sessao por HTTP -- abrir uma pagina, consumir
 * um `mk`, submeter um formulario. Nenhuma delas e um canal bidirecional, e um
 * WebSocket isento de credencial seria precisamente a #853 por outra porta. Todo
 * o handshake exige credencial, sem excecao. `loopbackOnlyPrefixes`, esse, e
 * consultado -- ver o ponto L2.6 no corpo.
 *
 * NUNCA REJEITA: um erro no caminho de decisao NAO pode resultar em handshake
 * aprovado nem em rejeicao nao capturada no dono do despacho -- fecha-se o
 * socket (fail-closed) e resolve-se.
 */
export function createGuardedUpgradeHandler(
  deps: GateDeps,
  delegate: WebUpgradeHandler,
  surface: string,
): WebUpgradeHandler {
  const { ctx, log, config } = deps

  return async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    let authorized: boolean
    let viaTunnel = false

    try {
      if (refusedAtPerimeter(deps, req, surface)) {
        denyUpgrade(socket, 403)
        return
      }

      /**
       * L2.6 tambem AQUI -- e com 401, que e deliberado.
       *
       * A invariante escrita em {@link GateDeps.loopbackOnlyPrefixes} ("corre
       * antes da isencao, e vale para rotas isentas e guardadas") era verdadeira
       * no caminho de request e FALSA neste. Uma invariante meio-verdadeira e
       * pior do que uma ausente, porque quem a le deixa de verificar.
       *
       * PORQUE 401 E NAO O 404 DO OUTRO CAMINHO: nesta superficie 401 e a
       * resposta UNIVERSAL a tudo o que nao tem credencial -- nao ha isencoes
       * aqui (ver o JSDoc do handler). Devolver um codigo DIFERENTE de 401
       * criaria um sinal que hoje nao existe: passaria a distinguir "esta rota e
       * de canal local" de "nao tens credencial". Alinhar com o 401 mantem a
       * invariante verdadeira sem acrescentar oraculo nenhum.
       */
      if (
        isGuardedPath(req.url, deps.loopbackOnlyPrefixes) &&
        !isLoopbackRequestHost(singleHeader(req, 'host'))
      ) {
        log.warn(
          `[${surface}] Upgrade recusado em ${String(req.url)}: rota de CANAL LOCAL APENAS ` +
            `alcancada por '${String(req.headers.host)}'.`,
        )
        denyUpgrade(socket, 401)
        return
      }

      // LE O CABECALHO CRU, e nao `singleHeader`. Um `Origin` REPETIDO chega como
      // array; passa-lo por `singleHeader` dava `undefined`, que este ramo lia
      // como "nao ha origem para validar" e SALTAVA a defesa inteira. Presente
      // mas nao-string e presente e ILEGIVEL -- e ilegivel fecha.
      const rawOrigin = req.headers.origin
      if (rawOrigin !== undefined) {
        const allowedOrigins = buildAllowedOrigins(
          deps.loopbackAuthority,
          deps.tunnelOrigin.current(),
        )
        const origin = typeof rawOrigin === 'string' ? canonicalOrigin(rawOrigin) : undefined
        if (origin === undefined || !allowedOrigins.includes(origin)) {
          log.warn(
            `[${surface}] Upgrade recusado (CWE-1385, Origin fora da allowlist EXATA): ` +
              `'${String(rawOrigin)}' nao consta de [${allowedOrigins.join(', ')}].`,
          )
          // NAO se audita: ver "O QUE NAO E AUDITADO" em `session-auth.ts`. A
          // recusa e alcancavel sem credencial e sem limite, e a auditoria e
          // fail-closed -- uma linha por tentativa era um botao de negar tudo.
          denyUpgrade(socket, 403)
          return
        }
      }

      /* ---- L3: sessao obrigatoria (superficie do TUNEL) -------------------- */
      // MODELO EXPOSE-PORT: este handshake corre no PROXY do tunel. NUNCA ha
      // "WebSocket local abre": todo pedido que chega ao proxy veio do tunel e
      // exige SESSao -- mesmo com `Host: 127.0.0.1` forjado. A validacao de
      // `Origin` acima vale para todos (a camada de origem mantem-se). Sem
      // sessao: recusa 401 sem `WWW-Authenticate`.
      const auth = deps.auth()
      const outcome = await authenticateRequest({
        req,
        auth,
        config,
        log,
        staticCredentialMatches: (header) => verifyBasicAuth(header, config.encodedAuthString),
      })
      viaTunnel = outcome.viaTunnel

      authorized = await ctx.waterfall(
        'http/auth-check',
        req,
        async (): Promise<boolean> => outcome.authorized,
      )
    } catch (error) {
      log.error(
        `[${surface}] Erro ao avaliar o upgrade; socket destruido: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      socket.destroy()
      return
    }

    if (!authorized) {
      log.warn(
        `[${surface}] Upgrade recusado (superficie do tunel sem sessao valida) em ` +
          `${String(req.url)}.`,
      )
      denyUpgrade(socket, 401)
      return
    }

    if (viaTunnel) rewriteAuthenticatedTunnelRequest(req, deps.loopbackAuthority)

    try {
      await delegate(req, socket, head)
    } catch (error) {
      log.error(
        `[${surface}] o despacho original do upgrade rebentou; socket destruido: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      socket.destroy()
    }
  }
}
