/**
 * =============================================================================
 * dsh-guard-messenger -- RAIZ DE COMPOSICAO
 * Plugin Cordis v4 para o DeepSeek Harness (DSH) v0.1
 * =============================================================================
 *
 * Este ficheiro FIA MODULOS. Nao implementa regra: cada decisao vive no seu
 * modulo (`src/http/**`, `src/proc/**`, `src/config/**`, ...) e este ponto de
 * entrada limita-se a `name`, `inject` e `apply`. Enquanto tudo isto era um so
 * ficheiro de 1836 linhas, toda onda do plano tinha paralelismo 1.
 *
 * TRES RESPONSABILIDADES, na ordem em que `apply()` as instala:
 *
 *   1. ENDURECIMENTO DO PLANO DE CONTROLO
 *      Bind de loopback obrigatorio, allowlist de origens remotas fail-closed e
 *      o veto de elevacoes para `danger-full-access` como DEFESA EM PROFUNDIDADE
 *      -- nao como travao principal: ver a nota extensa no ouvinte
 *      `security/permission-elevate` mais abaixo.
 *
 *   2. BARREIRA HTTP REVERSIVEL
 *      Troca de dono do despacho no `node:http.Server` do `ctx.webServer`, com
 *      Basic Auth avaliada por `ctx.waterfall('http/auth-check', ...)`. Nenhuma
 *      biblioteca externa: so `node:http` (tipos) e `node:crypto`. A mecanica
 *      esta em `src/http/intercept.ts`, e o PORQUE de nao ser `ctx.intercept`
 *      esta la, no cabecalho.
 *
 *   3. ORQUESTRACAO ATOMICA DO WORKER DE LONG-POLLING
 *      O processo filho vive dentro de um `ctx.effect()`, cujo disposer SINCRONO
 *      aborta, mata a arvore processual e cancela o temporizador de reinicio. A
 *      Fiber do Cordis erradica tudo em LIFO.
 *
 * PORQUE E QUE ISTO EXISTE
 *   A discussao oficial #853 ("unauthenticated local/remote code execution via
 *   the dsh web UI control plane", verificada em 0.1.0-rc.6) demonstra que a
 *   sub-estacao `/api` do DSH responde a sockets SEM qualquer credencial. Entre
 *   as suas mais de 60 rotas RPC esta `commands/execute`, capaz de injetar
 *   `/permission danger-full-access` e derrubar o confinamento `workspace-write`
 *   do Sandbox (fuga documentada em #1769). Este plugin e o portao que fecha
 *   essa superficie.
 *
 * CONVENCOES APLICADAS AQUI
 *   - "fail loud at load" (Q-3): configuracao invalida ou bind inseguro fazem
 *     `throw` no `apply()`. Nunca `?? valor_por_omissao` numa decisao de
 *     seguranca.
 *   - "explicit > implicit": tudo o que e politica de seguranca vem da
 *     configuracao, nada e inferido.
 *   - Reversibilidade atomica (Q-2): TODO registo propaga um disposer SINCRONO.
 * =============================================================================
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer as createNetServer, type Server as TcpServer } from 'node:net'

import type { AuditSink } from './contracts/auth.ts'
import { registerSessaoNovaObserver } from './audit/events.ts'
import { resolveAuditLogPath } from './audit/log.ts'
import { criarCoalescedor, criarObservadorSessaoNova, criarRelatorioPeriodico } from './audit/notify.ts'
import { assertValidConfig } from './config/assert.ts'
import { assertSecureBind } from './config/bind.ts'
import { resolveControl, resolveExposure, shouldAutoStartTunnel, type Config } from './config/schema.ts'
import { mayTrustEdgeClientIp } from './config/schema.ts'
import type { IncomingMessage, Server } from 'node:http'
import type { StateStore } from './contracts/state.ts'
import { IPC_PROTOCOL_VERSION, type IpcIntentMessage, type IpcMessageToWorker } from './contracts/ipc.ts'
import { createConfirmService } from './control/confirm.ts'
import { createTunnelController, ORIGEM_BOOT, type DifusaoEstado, type TunnelController } from './control/controller.ts'
import { criarRespondedorDeNonce, criarRespondedorIpc } from './control/surface-ipc.ts'
import type { Context, Disposable } from './dsh/adapter.ts'
import { PLUGIN_NAME } from './errors.ts'
import { createTunnelProxy, type TunnelProxy } from './tunnel/proxy.ts'
import {
  createGateAuthStack,
  createRequestOriginResolver,
  createTunnelOriginRegistry,
  type GateAuth,
  type GateAuthStack,
} from './http/session-auth.ts'
import type { TunnelSnapshot } from './contracts/tunnel.ts'
import { createCsrfGuard } from './panel/csrf.ts'
import { createPanelRouter, PANEL_PREFIX } from './panel/routes.ts'
import { createOneTimeTokenStore } from './secret/ott.ts'
import { createMagicStore } from './session/magic.ts'
import { createNativeUiSurface, type FonteDoToken, type UiAcessoBruto } from './ui-contrib/surface.ts'
import type { UiPrivacidade } from './ui-contrib/routes.ts'
import type { SessaoDePareamento } from './telegram/pairing.ts'
import { criarSessaoDePareamento } from './telegram/pairing.ts'
import { derivarEstadoDoBot } from './ui-contrib/bot-state.ts'
import type { WebRoute } from './dsh/adapter.ts'
import {
  analisarSecretsEnv,
  caminhoDoSecretsEnv,
  criarSondaHttp,
  gravarSecretsEnv,
  lerSecretsEnv,
  validarFormatoDoToken,
} from './telegram/onboarding.ts'
import { arrivedViaTunnel } from './http/host-header.ts'
import { normalizeRemoteAddress } from './http/origin.ts'
import { EDGE_CLIENT_IP_HEADER } from './http/session-auth.ts'
import {
  DEFAULT_PROVIDER,
  PROVIDER_ENV,
  type ProviderId,
} from './proc/env.ts'

/**
 * O RESOLUTOR DE ORIGEM DO PAINEL -- reexportado, e agora o UNICO que existe.
 *
 * `PanelDeps.resolveOrigin` precisa de decidir o ESQUEMA do pedido para poder
 * emitir o cookie `__Host-dsh_sid`, e a decisao correcta depende de
 * `exposure.mode` -- que o painel nao conhece e esta raiz sim. O JSDoc de
 * {@link createRequestOriginResolver} explica porque a condicao e o MODO (mais
 * "chegou pelo nome do tunel") e nao o HOST: uma instalacao em LAN e
 * nao-loopback e nao tem borda nenhuma a frente, e a medicao R10 que legitima o
 * `X-Forwarded-Proto` e sobre a BORDA da Cloudflare, nao sobre "vir de fora".
 *
 * O QUE MUDOU NA COSTURA DA ONDA 3: `src/panel/routes.ts` tinha um
 * `defaultResolveOrigin` local, com a condicao larga e errada, e
 * `PanelDeps.resolveOrigin` era OPCIONAL -- ou seja, o painel usava o resolutor
 * errado por omissao. O default foi eliminado e o campo passou a OBRIGATORIO:
 * quem compuser o painel (T5.3) nao consegue esquecer-se, porque o `tsc` recusa.
 *
 * A INSTANCIACAO nao acontece nesta raiz porque o painel ainda NAO E MONTADO em
 * producao -- nenhuma rota `/__guard/*` esta servida nesta arvore; a montagem e
 * de T5.3, na Onda 5. Instanciar aqui um resolutor sem chamador seria o mesmo
 * codigo dormente que esta onda removeu do portao. O que a costura garante e que
 * a montagem, quando vier, so pode usar este.
 */
export { createRequestOriginResolver } from './http/session-auth.ts'
import { readSessionCookie, assertTrustworthyOrigin, serializeSessionCookie } from './session/cookie.ts'
import type { RegistroDeAcesso } from './session/store.ts'
import { createLinkTokenStore } from './session/link-token.ts'
import type { LinkTokenSurface } from './contracts/link-token.ts'
import { createGuardLogger, type GuardLogger } from './logging/logger.ts'
import { requestsDeniedPermission } from './permissions/deny.ts'
import {
  createWorkerSupervisor,
  defaultSupervisorDeps,
  type WorkerSupervisor,
} from './proc/supervisor.ts'
import { createStateStore } from './state/store.ts'
import { resolveStatePaths } from './state/paths.ts'
import { createTunnelDiscovery } from './tunnel/discover.ts'
import {
  defaultOrphanSweepDeps,
  EVENTO_ORFAO,
  ownerOrphanMessage,
  recoverTunnelAtBoot,
  sweepOrphanTunnel,
  type OrphanSweepDeps,
} from './tunnel/pidfile.ts'
import { createHttpProbeTransport } from './tunnel/probe.ts'
import { createTunnelReadiness } from './tunnel/readiness.ts'
import { createTunnelSupervisor } from './tunnel/supervisor.ts'
import { createTtlEffects, type TtlEffects } from './tunnel/ttl.ts'

export { PLUGIN_NAME } from './errors.ts'
export type { Config, BackoffConfig, ControlConfig } from './config/schema.ts'
export { shouldAutoStartTunnel, resolveExposure } from './config/schema.ts'

/**
 * As UNICAS portas que o portao deixa passar sem credencial.
 *
 * PORQUE EXISTEM, e porque sao exatamente estas tres. A barreira e dona do
 * despacho e guarda a superficie INTEIRA -- incluindo o painel. Sem excecao
 * nenhuma nao haveria como AUTENTICAR: as tres rotas abaixo sao os passos que
 * ANTECEDEM a existencia de uma sessao, e cada uma traz a sua propria credencial
 * de uso unico em vez de depender da que ainda nao existe.
 *
 *   `/__guard/magic`     GET inerte + POST que consome o `mk` do link do Telegram;
 *   `/__guard/secret`    mostra o segredo UMA vez, destrancado por um `ott`;
 *   `/__guard/api/login` cria a sessao a partir do segredo (rota de T3.4).
 *
 * ISENCAO DE L3, E SO DE L3: `trustedRemotes` (L2) e o `Host` (L2.5) continuam a
 * correr sobre elas. Uma porta sem credencial aberta a rede inteira nao e uma
 * porta, e um buraco.
 *
 * >>> QUEM ACRESCENTAR UMA LINHA AQUI ESTA A ABRIR UMA ROTA SEM CREDENCIAL. <<<
 * A lista e curta de proposito, e a comparacao e por SEGMENTO (`isGuardedPath`):
 * `/__guard/magic` NAO cobre `/__guard/magico`.
 */
export const UNAUTHENTICATED_PANEL_PREFIXES: readonly string[] = [
  '/__guard/magic',
  '/__guard/secret',
  '/__guard/api/login',
]

/**
 * CANAL LOCAL APENAS -- 404 quando o pedido nao chega por um nome de loopback.
 *
 * ===========================================================================
 * ISTO FECHA UM FURO REAL, e vale a pena o furo ficar escrito.
 * ===========================================================================
 * `/__guard/secret` esta -- e continua -- na lista de isencao acima, porque quem
 * o vem buscar e precisamente quem ainda NAO tem o segredo: exigir credencial ali
 * era um ciclo. Eu tinha justificado a isencao com "L2 (`trustedRemotes`) e L2.5
 * (`Host`) continuam a correr". O raciocinio estava certo; a PREMISSA nao:
 *
 *   sob `cloudflared`, quem abre o socket e o `cloudflared`, que corre em
 *   `127.0.0.1` e portanto passa L2; e a origem do tunel e DELIBERADAMENTE
 *   acrescentada a allowlist de `Host` enquanto ele esta `READY`, logo passa
 *   L2.5. As duas camadas defendem de outros processos locais e de DNS
 *   rebinding -- nao da internet que o tunel deixa entrar de proposito.
 *
 * O resultado era `GET https://<x>.trycloudflare.com/__guard/secret?ott=<token>`
 * a servir o SEGREDO PERSISTENTE em texto claro, da internet publica, sem
 * credencial. `02-SEGURANCA.md` 4.4 e literal em sentido contrario: **"Canal
 * local apenas, sem excecao"**.
 *
 * O `ott` nao salva isto sozinho, e e por isso que a invariante importa mais do
 * que a aritmetica dele: 128 bits, uso unico e 10 minutos tornam a forca bruta
 * inviavel, mas o token e impresso no STDOUT DO TERMINAL -- vive em scrollback,
 * em multiplexador, em gravacao de sessao, em captura de ecra, no historico de
 * quem faz copiar-colar. O desenho inteiro tolera isso PORQUE a rota so e
 * alcancavel de quem ja esta na maquina.
 *
 * >>> AS OUTRAS DUAS ENTRADAS NAO ENTRAM AQUI, E ISSO E DELIBERADO. <<<
 * `/__guard/magic` existe precisamente para ser aberto do telemovel PELO TUNEL,
 * e `/__guard/api/login` TEM de ser alcancavel de fora ou nao ha como
 * autenticar. Trancar qualquer uma das duas no loopback nao endurecia nada --
 * partia o produto.
 */
export const LOOPBACK_ONLY_PREFIXES: readonly string[] = ['/__guard/secret']

/* ========================================================================= */
/* O alocador de porta de metricas e a recuperacao de boot                   */
/* ========================================================================= */

/** Timeout de cada sonda do probe fail-closed (porta local, gate do DSH). */
const PROBE_TIMEOUT_MS = 2000

/**
 * Aloca a porta do servidor de metricas do `cloudflared`, UMA por janela de
 * tunel.
 *
 * `allocateMetricsPort` (T3.1) e SINCRONA — e chamada dentro do spawn — e nao
 * existe bind sincrono em Node. A solucao: uma reserva assincrona que MANTEM a
 * porta aberta ate ao instante da entrega (a porta entregue esta livre por
 * construcao) e volta a reservar imediatamente para a janela seguinte. O
 * servidor de reserva morre com o disposer; um `alocar` sem reserva pronta e
 * uma falha de arranque (a reserva comeca no apply) e LANCA — o despacho do
 * start captura-a e o estado vai a FAILED.
 */
function criarAlocadorDeMetricas(log: GuardLogger): { alocar(): number; dispose(): void } {
  let reserva: TcpServer | undefined
  let fechado = false

  const reservar = (): void => {
    const servidor = createNetServer()
    servidor.once('error', (error) => {
      log.error(
        `nao foi possivel reservar a porta de metricas: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    servidor.listen(0, '127.0.0.1', () => {
      if (fechado) {
        servidor.close()
        return
      }
      reserva = servidor
    })
  }

  reservar()

  return {
    alocar(): number {
      const servidor = reserva
      if (servidor === undefined) {
        throw new Error('porta de metricas ainda nao reservada (a reserva comeca no apply)')
      }
      const endereco = servidor.address()
      if (endereco === null || typeof endereco === 'string') {
        throw new Error('porta de metricas sem endereco de reserva')
      }
      servidor.close()
      reserva = undefined
      reservar()
      return endereco.port
    },
    dispose(): void {
      fechado = true
      reserva?.close()
      reserva = undefined
    },
  }
}

/**
 * O PRIMEIRO passo do arranque (02-SEGURANCA 9): varredura de orfao + veredito
 * do TTL persistido, ANTES de qualquer outra inicializacao. Devolve o que o
 * boot precisa de saber do `state.json`: a INTENCAO persistida
 * (`desiredState`) e se o modo restrito esta ativo.
 *
 * NAO usa a pilha de autenticacao (que e lazy): usa um `StateStore` transiente
 * sobre os MESMOS caminhos. Em boot limpo (sem registo de tunel) nada toca o
 * disco; com um orfao ou um prazo vencido, a pilha nasce por necessidade — os
 * efeitos abaixo sao vistas lazy dela.
 *
 * Sem config de tunel (modo loopback) nao ha `ttlMinutes` para o veredito do
 * prazo; a varredura de orfao continua OBRIGATORIA — um orfao e uma URL publica
 * sem portao por tras — e o ramo repete a politica do ramo "derrubado dentro
 * do prazo" de `recoverTunnelAtBoot` (T3.1): sessoes invalidadas, auditoria,
 * aviso.
 */
function recuperarBoot(
  config: Config,
  log: GuardLogger,
  store: StateStore,
  efeitos: {
    readonly revogarSessoes: () => void
    readonly auditSink: Pick<AuditSink, 'append'>
    readonly notificarDono: (texto: string) => void
  },
  /** COSTURA: duble da varredura, para o teste dirigir a classificacao sem /proc. */
  sweep?: OrphanSweepDeps,
): {
  readonly intencao: 'READY' | 'STOPPED'
  readonly restrito: boolean
  /** O pareamento persistido, para o worker o reaprender no boot (8c). */
  readonly pareamento: { readonly ownerUserId: string; readonly ownerChatId: string; readonly pairedAt: number } | undefined
} {
  const persistido = store.read()
  const intencao = persistido.desiredState
  const restrito = persistido.restricted !== undefined

  if (config.tunnel === undefined) {
    const sweepDeps = sweep ?? defaultOrphanSweepDeps(store, log)
    const resultado = sweepOrphanTunnel(sweepDeps)
    if (resultado.outcome === 'killed') {
      efeitos.revogarSessoes()
      efeitos.auditSink.append({ evento: EVENTO_ORFAO, resultado: 'permitido' })
      efeitos.notificarDono(ownerOrphanMessage())
    }
    return { intencao, restrito, pareamento: persistido.pairing }
  }

  const effects: TtlEffects = createTtlEffects({
    // A varredura ja derrubou; o stopTunnel do boot e um no-op por desenho.
    stopTunnel: (): void => {},
    sessions: { revokeAll: () => efeitos.revogarSessoes() },
    audit: efeitos.auditSink,
    notifyOwner: (message: string) => efeitos.notificarDono(message),
  })

  recoverTunnelAtBoot({
    sweep: defaultOrphanSweepDeps(store, log, config.tunnel.binaryPath),
    ttlMinutes: config.tunnel.ttlMinutes,
    now: defaultSupervisorDeps.now,
    effects,
    log,
  })

  return { intencao, restrito, pareamento: persistido.pairing }
}

/** Nome do PLUGIN (identidade do modulo perante o motor Cordis). */
export const name = PLUGIN_NAME

/**
 * Injecao de dependencias (composicao espacial). O motor so ativa a Fiber deste
 * plugin depois de `ctx.webServer` e `ctx.subprocess` estarem disponiveis -- e
 * descarta-a de novo se alguma desaparecer.
 *
 * `webServer` (e nao `httpServer`) e o nome REAL do servico na linha que o
 * harness resolve. Ver o cabecalho de `src/dsh/adapter.ts`.
 *
 * E esta injeccao que garante a PRECONDICAO da barreira: o `WebServer` ja passou
 * por `[Service.init]` e o seu `node:http.Server` ja esta a escutar, portanto ja
 * tem despacho para nos tomarmos.
 *
 * -----------------------------------------------------------------------------
 * PORQUE `logger` NAO ESTA AQUI -- e nao pode voltar a estar.
 *
 * `LoggerService` NAO estende `Service` (`types/cordis/logger.d.ts:96`:
 * `export declare class LoggerService {`, contra `class WebServer extends
 * Service`). Nao entra no reflect store: o Context raiz cria-o como propriedade
 * PROPRIA (`this.logger = new LoggerService(self)`), pelo que `ctx.get('logger')`
 * devolve `undefined`. Uma Fiber que injecte `'logger'` fica PENDING para sempre
 * -- `apply()` NUNCA corre, e nao ha erro nem log.
 *
 * Medido contra o cordis real: `inject: ['webServer','subprocess']` -> fiber
 * ACTIVE; acrescentando `'logger'` -> fiber PENDING, `_store` so com
 * `['webServer','subprocess']`, e o E2E responde 200 sem credencial nenhuma.
 *
 * E a MESMA CLASSE DE FALHA que a barreira desta onda existe para corrigir:
 * `inject: string[]` aceita qualquer string em silencio, o `tsc` passa, e o
 * defeito e invisivel -- tal como `ctx.intercept(name, config: any)` aceitava um
 * objeto de metodos e nao fazia nada. `ctx.logger` continua acessivel sem
 * injeccao, que e como todos os pacotes DSH publicados o usam.
 * -----------------------------------------------------------------------------
 */
export const inject = ['webServer', 'subprocess']

/**
 * Ativa o plugin na Fiber corrente.
 *
 * A ORDEM DOS `ctx.effect` E DELIBERADA, porque os disposers correm em LIFO: o
 * worker e o primeiro a ser erradicado quando a Fiber transita para DISPOSED, e
 * so depois a barreira e levantada. Levantar a barreira primeiro deixaria uma
 * janela em que o plano de controlo responde sem credencial enquanto o worker
 * ainda esta vivo.
 */

/**
 * O FAN-OUT de estado para as superficies assinantes (a UI nativa de T5.5).
 *
 * W2 da revisao T5.5: o REPLAY IMEDIATO e CONTRATO — assinar entrega o
 * estado corrente JA, e depois cada difusao chega por `emitir`. O desassinar
 * e sincrono e idempotente; um observador que lance nao derruba o fan-out
 * (best-effort, registado).
 */
export function criarFanoutDeEstado(lerAtual: () => { readonly seq: number; readonly snapshot: TunnelSnapshot }, log: GuardLogger): {
  assinar(listener: (broadcast: { readonly seq: number; readonly snapshot: TunnelSnapshot }) => void): () => void
  emitir(): void
} {
  const observadores: Array<(broadcast: { readonly seq: number; readonly snapshot: TunnelSnapshot }) => void> = []
  return {
    assinar(listener) {
      try {
        listener(lerAtual()) // W2: o replay imediato e parte da assinatura
      } catch (error) {
        // Best-effort tambem aqui: um observador avariado nao pode impedir a
        // assinatura (nem o seu desassinar) de existir.
        log.warn(
          `observador de estado falhou no replay imediato: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      observadores.push(listener)
      return (): void => {
        const indice = observadores.indexOf(listener)
        if (indice !== -1) observadores.splice(indice, 1)
      }
    },
    emitir(): void {
      const atual = lerAtual()
      for (const observador of observadores.slice()) {
        try {
          observador(atual)
        } catch (error) {
          log.warn(`observador de estado falhou: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    },
  }
}
export function apply(
  ctx: Context,
  config: Config,
  options: { readonly bootSweep?: OrphanSweepDeps } = {},
): void {
  /* --- 1. Validacao ruidosa no arranque -------------------------------- */
  assertValidConfig(config)
  assertSecureBind(ctx.webServer.host, config.allowedHosts)

  const log = createGuardLogger(ctx)

  if (config.encodedAuthString === undefined) {
    // Nao e erro: a credencial deixou de poder viajar no manifesto (Camada 1 /
    // Bundle, D19) e a Onda 2 gera-a por CSPRNG. Ate la NINGUEM se autentica, o
    // que e a leitura fail-closed da ausencia -- e tem de ser dito em voz alta,
    // porque um plano de controlo que responde 401 a toda a gente parece avariado
    // a quem nao sabe porque.
    log.warn(
      'config.encodedAuthString AUSENTE: nenhuma credencial estatica esta configurada, ' +
        'logo TODAS as requisicoes recebem 401. E a politica fail-closed, nao uma avaria. ' +
        'O segredo passa a ser emitido pelo proprio plugin (Onda 2).',
    )
  }

  if (config.trustedRemotes.length === 0) {
    // Nao e erro: e a politica fail-closed a funcionar. Mas e ruidoso de
    // proposito, porque nesta configuracao o plano de controlo fica inacessivel a
    // TODA a gente, e isso tem de ser uma escolha consciente.
    log.warn(
      'config.trustedRemotes esta vazio: politica fail-closed ativa, ' +
        'TODAS as origens serao recusadas com 403. ' +
        'Acrescenta 127.0.0.1 para permitir o loopback.',
    )
  }

  if (config.guardedPrefixes.length === 0) {
    // O aviso mudou de significado nesta onda e a mudanca esta declarada em
    // `src/config/schema.ts`: a barreira e dona do DESPACHO e guarda a superficie
    // inteira, pelo que uma lista vazia JA NAO abre a sub-estacao `/api`. O que
    // uma lista vazia continua a significar e um inventario de plano de controlo
    // por declarar -- e a Onda 3 constroi a politica por rota do painel em cima
    // desse inventario.
    log.warn(
      'config.guardedPrefixes esta VAZIO: o inventario do plano de controlo nao esta ' +
        'declarado. A barreira continua a guardar a superficie inteira (e dona do despacho), ' +
        'mas a politica por rota do painel nao tem sobre o que se apoiar. ' +
        "Declara pelo menos '/api'.",
    )
  }

  if (config.deniedPermissions.length === 0) {
    // Mesma classe de armadilha: lista vazia = nenhuma elevacao e vetada, em
    // silencio. Ruidoso de proposito, tal como para `trustedRemotes`.
    log.warn(
      'config.deniedPermissions esta VAZIO: NENHUMA elevacao de permissao sera vetada, ' +
        "incluindo 'danger-full-access' (#853 -> #1769).",
    )
  }

  /* --- 1b. Os eixos da Onda 3 ----------------------------------------- */
  const exposure = resolveExposure(config)

  if (config.exposure === undefined) {
    // A ausencia e lida na direccao FECHADA (`LOOPBACK_ONLY_EXPOSURE`) -- nao ha
    // como ela abrir alguma coisa. Mas tem de ser VISTA: quem espera aceder pelo
    // telemovel e nao declarou `exposure` vai concluir que o tunel esta avariado.
    log.warn(
      'config.exposure AUSENTE: assume-se a leitura mais fechada -- ' +
        "mode='loopback', autoStart=false, trustEdgeHeaders=false. Nenhum tunel pode subir. " +
        'Declare o eixo `exposure` no cordis.patch.yml para mudar isto.',
    )
  }

  if (exposure.trustEdgeHeaders) {
    // Nao e erro (`assertValidConfig` ja recusou a combinacao impossivel), mas e
    // a chave mais perigosa do ficheiro: acreditar num cabecalho de IP e deixar
    // que ele decida o balde do rate limit e a linha do audit log.
    log.warn(
      `config.exposure.trustEdgeHeaders=true: o cabecalho da borda passa a decidir ` +
        'a identidade do cliente. So e seguro porque a borda da Cloudflare RECUSA (403) ' +
        'o pedido em que o cliente envia CF-Connecting-IP (spike S2) -- e SO esse ' +
        'cabecalho e lido. X-Forwarded-For e ACRESCENTADO ao valor do cliente e ' +
        'continua proibido em todos os modos.',
    )
  }

  /**
   * ORDEM DE CARREGAMENTO -- O AVISO INVERTEU-SE, E O REGISTO FICA.
   *
   * Ate esta onda, este ponto emitia um `warn` a dizer que o plugin so guardava
   * registos feitos DEPOIS do seu `apply()`, e que o operador tinha de garantir
   * a posicao da entrada no `cordis.patch.yml`. Isso era verdade do mecanismo
   * ANTIGO (envolver `register`/`registerFallback`/`registerUpgrade`), que alias
   * nunca chegou a funcionar.
   *
   * O mecanismo medido NAO TEM essa exigencia: o `EventEmitter` resolve a lista
   * de listeners a cada evento e as rotas vivem nas tabelas por baixo do
   * despacho. Provado nos dois sentidos -- barreira instalada DEPOIS de todos os
   * registos guarda as 7 rotas reais, e uma rota registada DEPOIS da barreira
   * tambem fica guardada. Bate com `dsh-base@0.1.0-rc.7/cordis.patch.yml:12-13`:
   * "Row order carries no load semantics".
   *
   * A linha fica -- invertida e ao nivel `info` -- em vez de desaparecer: um
   * aviso que some sem explicacao e indistinguivel de um aviso que se perdeu no
   * refactor, e o operador que leu o antigo precisa de ver o novo.
   */
  log.info(
    'ORDEM DE CARREGAMENTO: sem exigencia. A barreira e dona do despacho do ' +
      'node:http.Server, logo guarda tambem as rotas registadas DEPOIS dela. A posicao ' +
      'da entrada deste plugin no cordis.patch.yml e indiferente.',
  )

  log.info(
    `Portao ativo em ${ctx.webServer.host}:${ctx.webServer.port} ` +
      `(inventario do plano de controlo: ${config.guardedPrefixes.join(', ') || 'nenhum'}).`,
  )

  /**
   * A PILHA DE AUTENTICACAO, SOB PROCURA.
   *
   * `apply()` NAO TOCA NO SISTEMA DE FICHEIROS, e isso e deliberado: montar a
   * pilha abre o `state.json` e o `audit.log`, e carregar um plugin -- num
   * harness que talvez nunca sirva um pedido -- nao pode criar ficheiros na casa
   * do operador. A pilha nasce no PRIMEIRO pedido que precisa de decidir.
   *
   * O QUE CONTINUA A FALHAR ALTO NO CARREGAMENTO: a RESOLUCAO dos caminhos, que
   * e pura e nao toca no disco. Um `$DSH_HOME` ou um `$DSH_GUARD_AUDIT_LOG`
   * relativo -- a classe de erro de configuracao que faria o estado aparecer e
   * desaparecer conforme o diretorio de arranque -- lanca AQUI, no `apply()`, e
   * nao no primeiro 401 de madrugada.
   */
  const statePaths = resolveStatePaths()
  const auditPath = resolveAuditLogPath()
  log.info(`Estado em ${statePaths.file}; auditoria em ${auditPath}.`)

  /**
   * O PROVEDOR de mensageria ATIVO (desacoplamento do bot -> provedores, D1).
   *
   * A fonte e `config.worker.provider` (ausente = default fechado `telegram`);
   * e a MESMA escolha que o worker faz ao ler `DSH_GUARD_PROVIDER` do seu
   * ambiente (injetado por `buildWorkerEnv`). O host ainda so conhece `telegram`;
   * um provedor futuro muda este literal e a linha propria em `PROVIDER_ENV` —
   * nada mais abaixo precisa de mudar: o `tokenVar` do provedor ativo vem da
   * tabela `PROVIDER_ENV` (nao de uma constante "telegram").
   */
  const provider: ProviderId = config.worker.provider ?? DEFAULT_PROVIDER
  /** O NOME da variavel de ambiente onde vive o token do provedor ativo. */
  const tokenVarDoProvedor = PROVIDER_ENV[provider].tokenVar

  /**
   * RESOLVEDOR DO TOKEN DO BOT — fonte de verdade UNICA, usada nas DUAS pontas
   * que precisam de saber se ha bot: a decisao de spawn do worker (efeito 6,
   * `createWorkerSupervisor` + injeção do env) e o estado do botao da UI
   * (`botState`). Antes esta resolucao existia duplicada e divergente —
   * o worker so subia com `config.worker.token`, mas a UI tambem acendia o
   * botao com um token apenas em `secrets.env`, mentindo sobre o bot estar
   * ligado.
   *
   * A ordem e a do onboarding (`resolverToken` em `src/telegram/onboarding.ts`):
   * `config.worker.token` PRIMEIRO (o que o host injeta via env),
   * `secrets.env` a seguir (o que `dsh-guard-setup --pedir-token` grava). Um
   * token so existe se QUALQUER uma das fontes o der; vazio = SEM BOT.
   *
   * O NOME da variavel lida no `secrets.env` e o do PROVEDOR ATIVO
   * (`PROVIDER_ENV[provider].tokenVar`): hoje `TELEGRAM_BOT_TOKEN`; um provedor
   * futuro muda-o aqui sem tocar na logica abaixo.
   *
   * O VALOR RAPIDO NUNCA sai para a UI: esta funcao existe para DECIDIR, e os
   * consumidores UI transformam o resultado em boleano/motivo.
   */
  const resolverTokenDoBot = (): string | undefined => {
    const doConfig = typeof config.worker.token === 'string' ? config.worker.token.trim() : ''
    if (doConfig.length > 0) return doConfig
    let env: string | undefined
    try {
      env = lerSecretsEnv(caminhoDoSecretsEnv(statePaths))
    } catch (error) {
      // secrets.env ilegivel/exposto -> trata como ausente (fail-closed: nao
      // se inventa um bot de um segredo que nem se consegue ler).
      void error
      return undefined
    }
    const valor = env === undefined ? undefined : analisarSecretsEnv(env).get(tokenVarDoProvedor)?.trim()
    return valor !== undefined && valor.length > 0 ? valor : undefined
  }

  const tunnelOrigin = createTunnelOriginRegistry()

  let stack: GateAuthStack | undefined
  const authStack = (): GateAuthStack => {
    // MEMOIZADO: uma so montagem por Fiber. Duas montagens dariam dois
    // `SessionStore` e um cookie emitido por um nunca validaria no outro.
    stack ??= createGateAuthStack({ log, tunnelOrigin })
    return stack
  }
  const auth = (): GateAuth => authStack().auth

  /**
   * O TUNEL PODE SUBIR SOZINHO?
   *
   * A resposta le o `state.json` -- e por isso corre DEPOIS de a pilha existir,
   * ou seja, nunca em `apply()`. O que fica em `apply()` e a decisao ESCRITA:
   * `shouldAutoStartTunnel` e exportado e e o predicado que T3.1/T5.1 tem de
   * consultar antes de spawnar o `cloudflared`. Com o modo restrito ativo no
   * `state.json` ele devolve `false` -- reiniciar o DSH nao e o bypass.
   */
  if (exposure.mode === 'tunnel' && exposure.autoStart) {
    log.info(
      'exposure.autoStart=true: o tunel sobe no arranque, EXCETO se o modo restrito ' +
        'estiver ativo no state.json (shouldAutoStartTunnel).',
    )
  }

  /* --- 2. Veto de elevacao de permissao -------------------------------- */
  /**
   * Ouvinte em cascata que IGNORA (veta) pedidos de elevacao para permissoes
   * irrestritas. Devolver `false` SEM invocar `next()` instaura o curto-circuito
   * irreversivel descrito na primer do Cordis.
   *
   * -------------------------------------------------------------------------
   * CORRECAO DE UM CLAIM FALSO QUE ESTAVA AQUI. Este comentario afirmava ser "o
   * travao final da #853 -> #1769". NAO E, e a diferenca importa:
   *
   *   - `security/permission-elevate` e um evento DECLARADO POR ESTE PLUGIN (a
   *     augmentation de `Events` em `src/dsh/adapter.ts`). Nenhum componente
   *     DOCUMENTADO do DSH o emite: uma busca pelos markdowns-fonte devolve zero
   *     ocorrencias, e os unicos emissores existentes sao os testes deste
   *     repositorio;
   *   - o comando perigoso viaja no CORPO do POST para `/api/commands/execute`, e
   *     o portao HTTP deliberadamente NAO le o corpo (ver `createGuardedHandler`).
   *     Logo este ouvinte nunca chega a ver o comando de um pedido real.
   *
   * O que fecha de facto a #853 e a BARREIRA DE AUTENTICACAO + ALLOWLIST DE
   * ORIGEM sobre o despacho inteiro, mais o bind de loopback. Este ouvinte e um
   * HOOK DE DEFESA EM PROFUNDIDADE: fica no lugar, com o tokenizador endurecido,
   * para o dia em que o DSH (ou outro plugin) passe a emitir o evento. Nao e o
   * travao principal e nao deve ser contabilizado como tal em nenhuma auditoria.
   * -------------------------------------------------------------------------
   *
   * `ctx.on` devolve o disposer nativo (`() => boolean`); encaminha-lo por
   * `ctx.effect` inscreve-o na contabilidade LIFO da Fiber.
   */
  ctx.effect(
    (): Disposable =>
      ctx.on('security/permission-elevate', async (command, next): Promise<boolean> => {
        const denied = requestsDeniedPermission(command, config.deniedPermissions)

        if (denied !== undefined) {
          log.error(
            `VETO de elevacao de permissao: o comando pediu '${denied}', ` +
              `que consta de config.deniedPermissions. Comando recusado: ${command}`,
          )
          return false // curto-circuito: `next()` NAO e invocado.
        }

        return next()
      }),
    'dsh-guard.veto-de-permissao',
  )

  /* --- 3. Ouvinte de autenticacao (around-middleware) ------------------ */
  /**
   * VETO ESTRUTURAL, sem I/O e sem comparacao de credencial.
   *
   * -------------------------------------------------------------------------
   * O QUE ESTE OUVINTE DEIXOU DE FAZER, E PORQUE (mudanca desta onda)
   * -------------------------------------------------------------------------
   * Ate aqui ele repetia `verifyBasicAuth`. Isso deixou de ser correcto no
   * instante em que o portao passou a aceitar TRES credenciais -- sessao, Basic
   * estatico e o segredo gerado pelo plugin -- porque o `encodedAuthString` e
   * normalmente AUSENTE (D19) e este ouvinte vetava, ANTES do terminal, um
   * pedido que se autenticava perfeitamente pelo segredo.
   *
   * Repetir aqui a verificacao COMPLETA tambem nao serve: ela roda o atraso
   * interno do limitador e conta a tentativa. Corrida duas vezes por pedido,
   * duplicaria o atraso e contaria a mesma tentativa duas vezes.
   *
   * O que sobra e o que este ponto pode fazer sem custo e sem estado: recusar o
   * que nao apresenta credencial NENHUMA. E leitura de cabecalho, sem disco, sem
   * relogio e sem alocacao dependente da entrada. O veredito final continua a
   * ser o do terminal, que e a decisao ja tomada pelo portao.
   *
   * `false` SEM invocar `next()` instaura o curto-circuito irreversivel da
   * cascata; com credencial apresentada, delega em `next()` para que outros
   * plugins possam acrescentar politicas (2FA, mTLS) por cima desta.
   */
  ctx.effect(
    (): Disposable =>
      ctx.on('http/auth-check', async (req, next): Promise<boolean> => {
        const temAutorizacao = typeof req.headers.authorization === 'string'
        const temSessao =
          readSessionCookie(
            typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined,
          ) !== null

        if (!temAutorizacao && !temSessao) return false // veto: sem `next()`.
        return next()
      }),
    'dsh-guard.auth-check',
  )

  /**
   * Captura os METADADOS DE ACESSO lidos do pedido para o nascimento de uma
   * sessao: o `User-Agent` (sempre guardado, sem cortes — e so texto curto) e o
   * IP da borda SO quando `mayTrustEdgeClientIp` o garante (`trustEdgeHeaders`
   * + tunel + borda). O mesmo criterio do portao (`EDGE_CLIENT_IP_HEADER`, uma
   * lista com virgulas fecha-se). NAO confia em `X-Forwarded-For` (forjavel).
   */
  const capturarRegistroDeAcesso = (req: IncomingMessage): RegistroDeAcesso => {
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined
    // Le o `Host` DIRETO: `arrivedViaTunnel` colapsa "ausente"/"repetido" no
    // mesmo `undefined`, e ambos significam "nao chegou pelo nome do tunel".
    const rawHost = typeof req.headers.host === 'string' ? req.headers.host : undefined
    const confiaIp = mayTrustEdgeClientIp(exposure, arrivedViaTunnel(rawHost, tunnelOrigin.current()))
    const rawEdge = confiaIp ? req.headers[EDGE_CLIENT_IP_HEADER] : undefined
    const ip =
      typeof rawEdge === 'string' && !rawEdge.includes(',') ? normalizeRemoteAddress(rawEdge) : undefined
    // Aditivo: so entram os campos presentes; `undefined` nao cria um campo
    // `userAgent: undefined`. A var guarda uma forma mutavel e e devolvida
    // como `RegistroDeAcesso` (readonly na interface, construindo em UMA vez).
    const registo: { userAgent?: string; ip?: string } = {}
    if (userAgent !== undefined) registo.userAgent = userAgent
    if (ip !== undefined) registo.ip = ip
    return registo
  }

  /* --- 4. A barreira, sobre o despacho do node:http.Server ------------- */
  /**
   * A SESSAO emitida pelo fluxo `?key=` do portao (onda 1).
   *
   * Resolve a ORIGEM efetiva do pedido (esquema+hospedeiro), recusa emitir
   * sobre uma origem que o navegador ia descartar (`assertTrustworthyOrigin`,
   * spike S10), e faz `regenerate(presentedId)` -- anti-fixation: o id que o
   * cliente apresentou morre antes de nascer o novo, exatamente como a rota de
   * login do painel faz. Devolve a linha `Set-Cookie`; `null` se falhar.
   */
  const issueSessionDoPortao = (
    req: IncomingMessage,
    presentedId: string | undefined,
  ): string | null => {
    // O PROXY e a entrada do TUNEL, que e HTTPS (a borda termina o TLS). O
    // socket do proxy e loopback em texto claro, logo o resolver derivaria
    // `http`; forca-se `https` para o cookie `__Host-` ser aceite.
    const origem = createRequestOriginResolver({ config, tunnelOrigin })(req)
    const host = origem.host
    try {
      assertTrustworthyOrigin({ scheme: 'https', host })
    } catch {
      log.warn(
        'nao emite sessao pelo link: origem nao entrega cookie Secure: ' +
          `${origem.scheme}://${host}`,
      )
      return null
    }
    const id = authStack().sessions.regenerate(presentedId, capturarRegistroDeAcesso(req))
    return serializeSessionCookie(id, { scheme: 'https', host })
  }

  /* --- 4. MODELO EXPOSE-PORT: o servidor do DSH fica ABERTO ------------- */
  /**
   * O NUCLEO DA CORRECCAO DO BLOCK (onda 1 -> expose-port).
   *
   * O servidor do DSH (upstream) NAO e mais guardado por este plugin: o acesso
   * local a `127.0.0.1:<porta-do-DSH>` abre direto, sem barreira e sem
   * `WWW-Authenticate` -- e o que o dono quer ("nunca pedir login").
   *
   * O guarda agora vive no PROXY do tunel (`src/tunnel/proxy.ts`), um listener
   * proprio que o `cloudflared` aponta. Decidir "abrir" por `Host` de loopback
   * era FORJAVEL (um pedido pelo cloudflared com `Host: 127.0.0.1:3080`
   * passava L2/L2.5 e delegava); por isso NENHUM servidor do DSH decide abrir
   * por Host -- o upstream fica aberto por NAO SER guardado, e a superficie do
   * tunel e o proxy, que exige sessao-ou-chave para tudo.
   *
   * Este efeito (mantido para a contabilidade LIFO e os 5 efeitos de contrato)
   * garante que a pilha de autenticacao, criada lazy pelo proxy, e disposta na
   * desmontagem.
   */
  ctx.effect((): Disposable => {
    return (): void => {
      // A pilha morre por ultimo: o proxy (controlador) ja parou no efeito LIFO
      // anterior. Um pedido em voo encontra o `SessionStore` disposto (`null`).
      stack?.dispose()
    }
  }, 'dsh-guard.barreira')

  /* --- 5. O controlador unico do tunel --------------------------------- */
  /**
   * O UNICO dono do estado do tunel (`docs/control-machine.md`): Telegram,
   * painel e UI nativa sao SUPERFICIES e nenhuma chama o supervisor de tunel
   * directamente. Este efeito cria o supervisor (T3.1), o controlador (T5.1) e
   * o servico de nonce, e o disposer SINCRONO derruba o supervisor e desarma o
   * repasse de reconciliacao. LIFO: o worker morre antes, a barreira depois.
   */
  let controladorAtual: TunnelController | undefined
  let workerSupervisor: WorkerSupervisor | undefined
  /** O ConfirmService partilhado (controlador + responder de nonce + rotate). */
  let confirmService: ReturnType<typeof createConfirmService> | undefined
  /** O dono persistido lido no boot (8c) e o MagicStore partilhado (item 5). */
  let pareamentoDoBoot: { readonly ownerUserId: string; readonly ownerChatId: string; readonly pairedAt: number } | undefined
  let magicStoreAtual: ReturnType<typeof createMagicStore> | undefined
  /** A chave no link do portao (onda 1), criada com o controlador (item 5). */
  let linkStoreAtual: ReturnType<typeof createLinkTokenStore> | undefined
  /**
   * O proxy do tunel (modelo expose-port), criado no efeito do controlador
   * (item 5) e visto pelo efeito do worker (item 6) para o `encerrarConexoesAtivas`
   * do `/rotacionar`. Holder partilhado no escopo de `apply` (a mesma fiacao
   * pontual de `magicStoreAtual`/`linkStoreAtual`).
   */
  let tunnelProxyAtual: TunnelProxy | undefined

  /**
   * A difusao de estado host -> worker, com `seq` monotonico (CTL-010). A URL e
   * o prazo so saem em `READY` (invariante do contrato IPC); o `send` nunca
   * lanca e devolve `false` quando o worker esta em baixo — perde-se uma
   * difusao, a proxima traz `seq` novo (CTL-027).
   */
  const difundir = (difusao: DifusaoEstado): void => {
    workerSupervisor?.send({
      v: IPC_PROTOCOL_VERSION,
      type: 'state',
      state: difusao.estado,
      seq: difusao.seq,
      ...(difusao.estado === 'READY' && difusao.url !== undefined && difusao.expiresAt !== undefined
        ? { url: difusao.url, expiresAt: difusao.expiresAt }
        : {}),
    })
  }

  /** `/status` e reconexoes: reenvia o estado COMPLETO com o `seq` corrente. */
  const reemitirEstado = (): void => {
    const atual = controladorAtual?.snapshot()
    if (atual === undefined) return
    difundir({
      estado: atual.state,
      seq: atual.seq,
      ...(atual.info === undefined || atual.expiresAt === undefined
        ? {}
        : { url: atual.info.url, expiresAt: atual.expiresAt }),
    })
  }

  /** Aviso proativo ao dono (best-effort; o worker pode estar em baixo). */
  const difundirNotificacao = (message: string): void => {
    workerSupervisor?.send({ v: IPC_PROTOCOL_VERSION, type: 'notify', texto: message })
  }

  /**
   * O broadcast do controlador com fan-out: o worker (difusao IPC) e a UI
   * nativa (criarFanoutDeEstado). O observador recebe a projecao COMPLETA do
   * controlador (snapshot + seq), nunca um delta; a assinatura faz replay
   * imediato do estado corrente (W2 — ver criarFanoutDeEstado).
   */
  const fanoutDeEstado = criarFanoutDeEstado(() => {
    const atual = controladorAtual?.snapshot()
    return atual === undefined
      ? { seq: 0, snapshot: { state: 'STOPPED' as const, attempts: 0 } }
      : { seq: atual.seq, snapshot: atual }
  }, log)
  const broadcastControlador = (difusao: DifusaoEstado): void => {
    difundir(difusao)
    fanoutDeEstado.emitir()
  }

  /**
   * S6 (`src/contracts/ipc.ts`): o host RE-VERIFICA a identidade contra o
   * pareamento persistido — a verificacao no processo que fala com a internet
   * e a primeira a cair se ele for comprometido. A pilha nasce no primeiro
   * pedido que precisa de decidir; a falha de leitura fecha (CTL-029).
   */
  const pareado = (from: string, chat: string): boolean => {
    try {
      const pareamento = authStack().state.read().pairing
      return pareamento !== undefined && pareamento.ownerUserId === from && pareamento.ownerChatId === chat
    } catch (error) {
      log.error(
        'nao foi possivel ler o pareamento persistido; intencao recusada: ' +
          `${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  /**
   * `/emergencia` (kill switch, 02-SEGURANCA L8): DEPOIS de o tunel cair (o
   * despacho `stop` resolve — "tunel primeiro, sempre"), invalida TODAS as
   * sessoes emitidas (SESS-009), audita com a origem e — 8(b) — derruba o
   * WORKER (o bot para e o processo sai) dispondo o supervisor, que NAO o
   * reinicia. O que o emergency NAO derruba e o processo do DSH: so a
   * EXPOSICAO e o worker.
   */
  const aposEmergencia = (intent: IpcIntentMessage): void => {
    try {
      authStack().sessions.revokeAll()
    } catch (error) {
      log.error(`falha ao invalidar as sessoes do /emergencia: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      authStack().audit.append({ evento: `tunel_emergencia:telegram:${String(intent.from)}`, resultado: 'permitido' })
    } catch (error) {
      log.error(`falha ao auditar o /emergencia: ${error instanceof Error ? error.message : String(error)}`)
    }
    // 8(b): o emergency MATA o worker (o bot para e o processo sai) e o
    // supervisor NAO o reinicia. Dispose() cancela o orcamento/backoff e
    // aborta o ciclo — a terminacao do processo que se segue e tratada como
    // intencional ("sem reinicio"). O tunel ja caiu antes (despacho stop).
    try {
      workerSupervisor?.dispose()
    } catch (error) {
      log.error(`falha ao encerrar o worker apos o /emergencia: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.effect((): Disposable => {
    /* 1. RECUPERACAO DE BOOT (02-SEGURANCA 9): varredura de orfao + veredito
          do TTL persistido, ANTES de qualquer outra inicializacao. T3.1 entrega
          o mecanismo; a fiacao e desta sub-tarefa. */
    const storeBoot = createStateStore({ paths: statePaths })
    const boot = recuperarBoot(config, log, storeBoot.store, {
      revogarSessoes: () => authStack().sessions.revokeAll(),
      auditSink: { append: (evento) => authStack().audit.append(evento) },
      notificarDono: difundirNotificacao,
    }, options.bootSweep)
    storeBoot.dispose()

    if (config.tunnel === undefined) {
      // Modo loopback: sem supervisor, sem controlador — nenhum tunel pode
      // subir e a superficie IPC recusa com EXPOSURE_DISABLED.
      log.info(
        'controlador sem supervisor: nao ha configuracao de tunel (exposure.mode nao e tunnel); ' +
          'nenhum tunel pode subir.',
      )
      return (): void => {}
    }

    /* 2. O supervisor do tunel (T3.1) e o controlador (T5.1). */
    const alocador = criarAlocadorDeMetricas(log)

    // MODELO EXPOSE-PORT: o guarda do tunel e o PROXY, e o `cloudflared` aponta
    // para ELE (porta dedicada), nao para o servidor do DSH (que fica aberto).
    const tunnelProxy = createTunnelProxy({
      ctx,
      log,
      config,
      auth,
      tunnelOrigin,
      linkToken: { verificar: (c) => (linkStoreAtual?.verificar(c) ?? false) },
      issueSession: issueSessionDoPortao,
      upstreamPort: ctx.webServer.port,
    })
    // Partilha o proxy com o rotacao do worker (efeito do item 6).
    tunnelProxyAtual = tunnelProxy

    const supervisor = createTunnelSupervisor({
      ctx,
      config: config.tunnel,
      // A ORIGEM e o PROXY (porta dedicada), provado no instante do uso (T3.1).
      resolveOrigin: (): Server => tunnelProxy.server,
      allocateMetricsPort: alocador.alocar,
      probe: {
        transport: createHttpProbeTransport({
          host: '127.0.0.1',
          port: ctx.webServer.port,
          timeoutMs: PROBE_TIMEOUT_MS,
        }),
        newCanaryToken: (): string => randomBytes(12).toString('hex'),
      },
      discovery: createTunnelDiscovery(),
      readiness: createTunnelReadiness(),
      // Vistas LAZY da pilha de autenticacao: a pilha nasce no primeiro pedido
      // que precisa de decidir — nunca no apply() (ver o cabecalho deste
      // ficheiro). O writer subjacente e um so: o da pilha.
      store: {
        read: () => authStack().state.read(),
        update: (fn) => authStack().state.update(fn),
      },
      tunnelOrigin,
      sessions: { revokeAll: () => authStack().sessions.revokeAll() },
      audit: { append: (evento) => authStack().audit.append(evento) },
      notifyOwner: difundirNotificacao,
    })

    // O ConfirmService e HOISTED: o controlador consome-o e o responder de
    // nonce (EMENDA-COSTURA-5) e o `secret.rotate` (item 5) partilham a MESMA
    // instancia — dois servicos de nonce seriam dois universos de uso unico.
    const confirm = createConfirmService({ now: defaultSupervisorDeps.now })
    confirmService = confirm
    pareamentoDoBoot = boot.pareamento

    const controlador = createTunnelController({
      log,
      supervisor,
      confirm,
      agora: defaultSupervisorDeps.now,
      scheduler: defaultSupervisorDeps.scheduler,
      restritoAtivo: (): boolean => {
        try {
          return authStack().restricted.isActive()
        } catch (error) {
          log.error(`modo restrito ilegivel; start recusado (fail-closed): ${error instanceof Error ? error.message : String(error)}`)
          return true
        }
      },
      segredoForte: (): boolean => {
        try {
          return authStack().state.read().secretDigest !== undefined
        } catch (error) {
          log.error(`segredo ilegivel; start recusado (fail-closed): ${error instanceof Error ? error.message : String(error)}`)
          return false
        }
      },
      requerConfirmacao: resolveControl(config).requireConfirmation,
      audit: { append: (evento) => authStack().audit.append(evento) },
      // T5.4 fiada (Frente 2, Onda 6): todo toggle PERMITIDO notifica DEPOIS do
      // append. O canal e LAZY (o workerSupervisor so nasce no efeito seguinte)
      // e o mesmo padrao do relatorio periodico — o worker em baixo devolve
      // false e o envio vira aviso no log do operador.
      canalNotificacao: { send: (message) => workerSupervisor?.send(message) ?? false },
      broadcast: broadcastControlador,
      persistirIntencao: (alvo) => {
        try {
          authStack().state.update((estado) => ({ ...estado, desiredState: alvo }))
        } catch (error) {
          log.error(`nao foi possivel persistir a intencao do tunel (${alvo}): ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    })
    controladorAtual = controlador

    /* 2b. O PAINEL (T5.3, costura) e a UI NATIVA (T5.5, costura) — as
          outras duas superficies, fiadas ao MESMO controlador. Item 2: os tres
          campos obrigatorios do PanelDeps (seq/confirm/dispatch) sao fiados
          aqui. Item 3: o relatorio periodico (L8) e o coalescedor. Item 4: a
          superficie /__guard-ui com replay imediato (W2) e reset em FAILED (W3).
          Tudo vive NESTE efeito porque precisa do controlador; os disposers
          sao SINCRONOS e revertem tudo (rotas removidas, tap desligado,
          assinaturas canceladas, timer desarmado). */
    const agora = defaultSupervisorDeps.now
    const magicStore = createMagicStore({ clock: { now: agora } })
    magicStoreAtual = magicStore
    // A chave no link (onda 1): nao impoe TTL (fecha com a rotacao/queda do
    // tunel), da pelo relogio apenas por coerencia com o MagicStore.
    const linkStore = createLinkTokenStore({ clock: { now: agora } })
    linkStoreAtual = linkStore
    const ott = createOneTimeTokenStore({ clock: { now: agora } })
    const csrf = createCsrfGuard({ clock: { now: agora } })
    const desregistrarPainel = ctx.webServer.register({
      kind: 'prefix',
      path: PANEL_PREFIX,
      handler: createPanelRouter({
        log,
        // O PORTEIRO de auditoria e lazy: a pilha nasce no primeiro pedido que
        // decide — nunca no apply() (a doutrina deste ficheiro).
        audit: { append: (evento) => authStack().audit.append(evento) },
        snapshot: (): TunnelSnapshot => controlador.snapshot(),
        secrets: { verify: (candidato) => authStack().secrets.verify(candidato) },
        sessions: {
          regenerate: (id) => authStack().sessions.regenerate(id),
          validate: (id) => authStack().sessions.validate(id),
        },
        magic: magicStore,
        ott,
        // >>> O SEGREDO EM CLARO VIVE SO NO CLI DE ARRANQUE (T4.1); o plugin
        // nunca o retem — `null` e a leitura honesta desta camada. A ponte do
        // CLI para o painel (tela /__guard/secret) fica para a Onda 6. <<<
        reveal: () => null,
        limiter: {
          // PROXY LAZY da pilha (a doutrina deste ficheiro: a pilha nasce no
          // primeiro pedido que decide, nunca no apply). Mesma instancia do
          // portao — um segundo limitador teria uma contagem paralela.
          check: (identity) => authStack().limiter.check(identity),
          recordFailure: (identity) => authStack().limiter.recordFailure(identity),
          recordSuccess: (identity) => authStack().limiter.recordSuccess(identity),
          recordVerifiedButDenied: (identity) => authStack().limiter.recordVerifiedButDenied(identity),
          snapshot: () => authStack().limiter.snapshot(),
          dispose: () => authStack().limiter.dispose(),
        },
        csrf,
        clock: { now: agora },
        seq: (): number => controlador.snapshot().seq,
        confirm: { issue: (action) => controlador.emitirNonce(action) },
        dispatch: (intent) => controlador.despachar(intent),
        resolveOrigin: createRequestOriginResolver({ config, tunnelOrigin }),
      }),
    })

    // O PAINEL DE CONFIGURACAO DO TOKEN: cada operacao e executada AQUI, na
    // costura (que detem `config`, `statePaths` e o supervisor do worker); a
    // superficie so orquestra o HTTP. O token NUNCA sai daqui para a UI.
    const tokenOps = (() => {
      // A raiz do getMe e a MESMA variavel que o worker le (`TELEGRAM_API_ROOT`
      // em worker/providers/telegram/token.ts); omitida = `api.telegram.org`.
      const apiRoot = process.env.TELEGRAM_API_ROOT?.trim()
      const sonda = criarSondaHttp(apiRoot === undefined || apiRoot === '' ? {} : { apiRoot })
      // O handle lembrado da ultima GRAVACAO bem-sucedida por ESTA rota. So e
      // setado em `gravar` (sob sucesso): um `getMe` que nao grava NAO deixa
      // aqui um handle estale que o token-state depois mostraria como se fosse
      // o bot vigente (LOW-1 do revisor).
      let handleAtual: string | undefined
      // Cache curto do `/api/privacidade`: o getMe AO VIVO e caro para bater a
      // cada poll (~5s) do painel. Guarda-se o resultado + quando foi medido;
      // o `forcar` do botao "Verificar de novo" contorna este cache.
      const CACHE_PRIVACIDADE_MS = 30_000
      let cachePrivacidade:
        | { readonly quando: number; readonly resultado: UiPrivacidade }
        | undefined
      // A FONTE EFETIVA, partilhada por `fonte` e `estado` para nunca
      // divergirem: `config.worker.token` (env) PRIMEIRO (precedencia sobre o
      // `secrets.env`), `secrets.env` a seguir. A MESMA logica de
      // `resolverTokenDoBot`/`resolverToken` do onboarding.
      const fonteEfetiva = (): FonteDoToken => {
        const doConfig = typeof config.worker.token === 'string' ? config.worker.token.trim() : ''
        if (doConfig.length > 0) return 'env'
        let temSecrets = false
        try {
          const env = lerSecretsEnv(caminhoDoSecretsEnv(statePaths))
          const valor =
            env === undefined ? undefined : analisarSecretsEnv(env).get(tokenVarDoProvedor)?.trim()
          temSecrets = valor !== undefined && valor.length > 0
        } catch (error) {
          // secrets.env ilegivel/exposto: trata como ausente (fail-closed).
          void error
          temSecrets = false
        }
        return temSecrets ? 'secrets' : 'nenhum'
      }
      return {
        validarFormato: (bruto: string): boolean => validarFormatoDoToken(bruto).valido,
        fonte: fonteEfetiva,
        sondar: async (
          token: string,
        ): Promise<{ readonly ok: true; readonly handle: string } | { readonly ok: false; readonly erro: string }> => {
          const resposta = await sonda.getMe(token)
          if (!resposta.ok) return { ok: false, erro: 'token-invalido' }
          return { ok: true, handle: resposta.bot.username }
        },
        gravar: (token: string, handle: string): void => {
          // 1) Persistir em secrets.env (0600, atomico). Na falha, a excecao
          //    sobe para o handler virar 500; nada muda (nem a escrita, nem o
          //    handle lembrado).
          gravarSecretsEnv(
            { paths: statePaths, caminhoSecrets: caminhoDoSecretsEnv(statePaths) },
            tokenVarDoProvedor,
            token,
          )
          // 2) SO AQUI o handle e "committed": a gravacao aconteceu de facto.
          handleAtual = handle
          // 3) Reiniciar o worker com o token novo. Se o supervisor ainda nao
          //    nasceu (nao ha bot a correr), o token fica persistido e sobe no
          //    proximo boot — nao ha processo vivo para reiniciar.
          if (workerSupervisor === undefined) return
          workerSupervisor.definirToken(token)
          workerSupervisor.restart('token reconfigurado por /__guard-ui/api/token')
        },
        estado: () => ({
          configurado: fonteEfetiva() !== 'nenhum',
          ...(handleAtual === undefined ? {} : { handle: handleAtual }),
          fonte: fonteEfetiva(),
        }),
        privacidade: async (forcar = false): Promise<UiPrivacidade> => {
          // Cache curto: no poll (~5s) do painel, NAO bater getMe a cada vez.
          if (!forcar && cachePrivacidade !== undefined) {
            if (agora() - cachePrivacidade.quando < CACHE_PRIVACIDADE_MS) {
              return cachePrivacidade.resultado
            }
          }
          const fonte = fonteEfetiva()
          const token = resolverTokenDoBot()
          const calcular = async (): Promise<UiPrivacidade> => {
            if (token === undefined) return { ok: true, handle: null, fonte: 'nenhum' }
            const resposta = await sonda.getMe(token)
            // `ok:true` = ha @username; `ok:false` com HTTP 200 = o bot EXISTE
            // e nao tem @username (o contrato do getMe colapsa o "sem username"
            // em `falha.httpStatus === 200` — um bot valido sem `username`). So
            // com esse 200 e que reportamos `handle:null` (verde legitimo);
            // qualquer outra falha e "indisponivel" (nunca inventa estado).
            if (resposta.ok) {
              return { ok: true, handle: resposta.bot.username, fonte }
            }
            if (resposta.falha.httpStatus === 200) {
              return { ok: true, handle: null, fonte }
            }
            return { ok: false, erro: 'indisponivel' }
          }
          const resultado = await calcular()
          cachePrivacidade = { quando: agora(), resultado }
          return resultado
        },
      }
    })()

    const desmontarUi = createNativeUiSurface({
      tapIndex: (transform) => ctx.webServer.tapIndex(transform),
      registerRoute: (route) => ctx.webServer.register(route as WebRoute),
      emit: (intent) => controlador.despachar(intent),
      issueNonce: (action) => controlador.emitirNonce(action),
      subscribe: (listener) => fanoutDeEstado.assinar(listener),
      now: agora,
      // O ESTADO DO BOTAO do bot, do disco a cada pedido. S6/S4: o token NUNCA
      // sai daqui para a UI — esta funcao so decide se "existe" e se ha dono
      // pareado, e devolve boleanos + motivo. Token configurado = o MESMO
      // resolvedor que decide o spawn do worker (`resolverTokenDoBot`), para o
      // botao nunca mentir sobre o bot estar ligado; pareamento = `pairing` do
      // `state.json`. Falha de leitura fecha para OFFLINE (fail-closed).
      botState: () => {
        const tokenConfigurado = resolverTokenDoBot() !== undefined
        let pairing: { readonly ownerUserId: string; readonly ownerChatId: string; readonly pairedAt: number } | undefined
        try {
          pairing = authStack().state.read().pairing
        } catch (error) {
          void error
          return { online: false, motivo: tokenConfigurado ? 'sem-pareamento' : 'sem-chave' }
        }
        return derivarEstadoDoBot({ tokenConfigurado, pairing })
      },
      // O PAINEL DE CONFIGURACAO DO TOKEN: cada operacao e executada AQUI, na
      // costura (que detem `config`, `statePaths` e o supervisor do worker); a
      // superficie so orquestra o HTTP. O token NUNCA sai daqui para a UI.
      tokenOps,
      // O PAREAMENTO VIA PAINEL: gera o codigo (com `criarSessaoDePareamento`),
      // envia o digest (`pairing.challenge`) ao worker e guarda a sessao NUM
      // SLOT EM MEMORIA (Map/closure, TTL 5 min) para re-exibicao no refresh.
      // O CODIGO NUNCA e logado nem enviado por Telegram: so existe no host
      // (memoria) e na resposta a `gerar()` — o unico sitio onde o claro
      // viaja para o painel. O `handle` vem do token-state ja gravado.
      pairOps: (() => {
        // OS ORTLHOS EM MEMORIA: o par {sessao} da UTIMA geracao. Um so slot
        // (a politica anti-dobra do CLI e "um codigo de cada vez").
        let sessaoAtiva: SessaoDePareamento | undefined
        const relogio = { now: agora }
        return {
          estado: () => {
            // `pareadoAtual` = ha `pairing` persistido no state.json.
            let pareadoAtual = false
            try {
              pareadoAtual = authStack().state.read().pairing !== undefined
            } catch (error) {
              // fail-closed: leitura impossivel = nao pareado (nao se inventa).
              void error
            }
            const base: {
              pareado: boolean
              handle?: string
              codigo?: string
              expiraEm?: number
            } = { pareado: pareadoAtual }
            // handle do token-state (o token ja foi validado pelo getMe).
            const handle = tokenOps.estado().handle
            if (handle !== undefined) base['handle'] = handle
            // Re-exibicao enquanto a sessao NAO expirou (restanteMs() > 0).
            const sessao = sessaoAtiva
            if (sessao !== undefined && sessao.restanteMs() > 0) {
              try {
                // A sessao do painel nunca e oferecida (so gera o digest), logo
                // so pode estar 'aberto'/'expirado' — `revelarCodigo` cobre os
                // dois. Um throw aqui NAO pode derrubar a leitura (S4).
                base['codigo'] = sessao.revelarCodigo()
                base['expiraEm'] = sessao.resumo().expiraEm
              } catch (error) {
                // Sessao consumida/esgotada (teorico): nao re-exibe o codigo.
                void error
              }
            }
            return base
          },
          gerar: async () => {
            // 1) ja-pareado: a janela fechou-se (PAIR-005) — o bot tem dono.
            try {
              if (authStack().state.read().pairing !== undefined) {
                return { ok: false as const, erro: 'ja-pareado' as const }
              }
            } catch (error) {
              // FAIL-CLOSED real: ler a pairing falhou (state.json ilegivel).
              // Nao se sabe se ja ha dono — logo NAO se gera nem se envia
              // challenge. O 'interno' e o codigo cuja mensagem nao vaza
              // topologia nem estado real.
              void error
              return { ok: false as const, erro: 'interno' as const }
            }
            // 2) sem-token: o resolvedor do token (config/secrets.env) decide.
            if (resolverTokenDoBot() === undefined) {
              return { ok: false as const, erro: 'sem-token' as const }
            }
            // 3) worker-indisponivel: sem supervisor vivo nao ha para onde
            //    enviar o desafio (o worker tem de o receber para o dono
            //    poder `/parear <codigo>`).
            const workerSup = workerSupervisor
            if (workerSup === undefined) {
              return { ok: false as const, erro: 'worker-indisponivel' as const }
            }
            // Gera a sessao NOVA: a anterior (se houver) morre.
            const sessao = criarSessaoDePareamento({ clock: relogio })
            const codigo = sessao.revelarCodigo()
            const expiraEm = sessao.resumo().expiraEm
            // Digest sha256 HEX do codigo — NUNCA o claro (S3-b). E o unico
            // que atravessa o canal.
            const digest = createHash('sha256').update(codigo, 'utf8').digest('hex')
            const enviado = workerSup.send({
              v: IPC_PROTOCOL_VERSION,
              type: 'pairing.challenge',
              digest,
              expiresAt: expiraEm,
            })
            if (!enviado) {
              // O canal recusou (host a fechar/fila cheia): nada se guarda.
              return { ok: false as const, erro: 'worker-indisponivel' as const }
            }
            // So AQUI a sessao vira "ativa" — o desafio chegou ao worker.
            sessaoAtiva = sessao
            return { ok: true as const, codigo, expiraEm }
          },
        }
      })(),
      // AS METRICAS DE ACESSO: sockets ativos do proxy do tunel + sessoes vivas
      // do SessionStore (listar() e aditivo e devolve hash, nunca o portador).
      acesso: (): UiAcessoBruto => {
        const sessaoStore = authStack().sessions
        return {
          conexoesAtivas: tunnelProxyAtual?.conexoesAtivas ?? 0,
          totalSessoes: sessaoStore.live,
          sessoes: sessaoStore.listar().map((registo) => ({
            hash: registo.idHash,
            criadaEm: registo.criadaEm,
            ultimoUsoEm: registo.ultimoUsoEm,
            ...(registo.userAgent === undefined ? {} : { userAgent: registo.userAgent }),
            ...(registo.ip === undefined ? {} : { ip: registo.ip }),
          })),
          ipConfiavel: mayTrustEdgeClientIp(exposure, true),
        }
      },
    })

    /* 2c. NOTIFICACOES (T5.4, costura): o relatorio periodico de tunel aberto
          (L8, 30 min) e o coalescedor de 30 s sobre o observador de sessao
          nova. A ORDEM e contrato: o append corre ANTES do notify (o emissor
          escreve; notify.ts so compoe e envia). */
    const relatorio = criarRelatorioPeriodico({
      // LAZY: o workerSupervisor so nasce no efeito seguinte; o canal real e
      // consultado a cada ciclo, nunca capturado na montagem.
      canal: { send: (message) => workerSupervisor?.send(message) ?? false },
      log,
      audit: { append: (evento) => authStack().audit.append(evento) },
      now: agora,
      scheduler: defaultSupervisorDeps.scheduler,
      estado: () => {
        const snap = controlador.snapshot()
        return { aberto: snap.state === 'READY', expiraEm: snap.expiresAt }
      },
    })
    relatorio.iniciar()
    const coalescedor = criarCoalescedor(agora)
    const desregistrarObservador = registerSessaoNovaObserver((evento) => {
      // Coalescencia por CATEGORIA: uma rajada de sessoes novas nao vira
      // enxurrada (02-SEGURANCA 6.2); o observador congelado (PREP 5) faz o
      // append-antes-do-notify pelo ponto do gate.
      if (!coalescedor.tentar('sessao-nova')) return
      criarObservadorSessaoNova({ send: (m) => workerSupervisor?.send(m) ?? false })(evento)
    })

    /* 3. AUTOSTART: a INTENCAO persistida decide o arranque (TENSAO-003,
          CTL-033/034). Reiniciar o DSH nao e o bypass do modo restrito. */
    if (boot.intencao === 'READY' && shouldAutoStartTunnel(config, boot.restrito)) {
      log.info('boot: intencao persistida e READY com autoStart ativo; a subir o tunel.')
      void controlador.despachar({
        action: 'start',
        // ORIGEM_BOOT: a intencao persistida ja foi confirmada pelo humano
        // que a gravou — o start de boot NAO carrega nonce (CTL-033/034) e o
        // controlador dispensa a etapa de confirmacao para esta origem.
        requestedBy: ORIGEM_BOOT,
        requestId: `boot-${defaultSupervisorDeps.now().toString(36)}-${randomBytes(4).toString('hex')}`,
        at: defaultSupervisorDeps.now(),
      })
    } else {
      const motivo = boot.restrito
        ? 'o modo restrito esta ativo no state.json'
        : boot.intencao !== 'READY'
          ? 'a intencao persistida e STOPPED'
          : 'exposure.autoStart esta desligado'
      log.info(`boot em STOPPED: ${motivo}.`)
    }

    return (): void => {
      // LIFO interno: notificacoes antes do painel/UI antes do controlador.
      desregistrarObservador()
      relatorio.disposer()
      desmontarUi()
      desregistrarPainel()
      controlador.dispose()
      tunnelProxy.dispose()
      alocador.dispose()
    }
  }, 'dsh-guard.controlador')

  /* --- 6. Worker de long-polling sob ciclo de vida atomico ------------- */
  /**
   * Toda a instanciacao do processo do bot vive dentro de `ctx.effect()`.
   *
   * A funcao produtora devolve um disposer SINCRONO (`() => void`). Nunca
   * `async`, nunca devolvendo `Promise`: o motor precisa de executar os disposers
   * em ordem estritamente inversa a instanciacao sem intercalar microtasks, e uma
   * promessa quebraria essa garantia LIFO -- a nova Fiber PENDING poderia
   * arrancar um segundo worker antes de o primeiro ter morrido.
   *
   * (O host TOLERA disposers assincronos -- `Fiber.effect` documenta "they may be
   * async, in which case unloading awaits them". Nos nao usamos essa tolerancia;
   * a regra Q-2 do projeto e mais apertada do que a do host, de proposito.)
   */
  /**
   * O CANAL IPC E O DEAD-MAN'S SWITCH, ligados aqui por consequencia e nao por
   * escolha desta funcao.
   *
   * `createWorkerSupervisor` declara `stdio.stdin: 'pipe'`, e e isso -- e so
   * isso -- que arma as duas coisas: o sentido host -> worker do protocolo JSONL
   * (`src/contracts/ipc.ts`) e a defesa que sobrevive a um `SIGKILL` NESTE
   * processo. Se o `dsh` for morto sem cortesia, o disposer abaixo NAO CORRE --
   * nem o `abort`, nem o tree-kill do grupo. O que corre e o nucleo, que fecha o
   * descritor; o worker ve EOF no `stdin` e termina-se a si proprio.
   *
   * O `onIntent` e o RESPONDEDOR de T5.1 (`src/control/surface-ipc.ts`): a
   * maquina de controlo decide no proprio tick — o canal so transporta a
   * resposta. O observador de sessao nova vive no efeito do controlador
   * (item 3, com o coalescedor); aqui fica a fiacao do transporte do nonce
   * (EMENDA-COSTURA-5) e do dono persistido no boot (8c).
   */
  ctx.effect((): Disposable => {
    // O token resolvido decide se ha bot: `config.worker.token` ou
    // `secrets.env`. E o MESMO resolvedor do botao da UI — um token que o CLI
    // gravou em `secrets.env` (e que a UI mostra ONLINE) faz o worker SPAWNAR
    // de facto. Nao ha divergencia a corrigir a mao.
    const tokenDoBot = resolverTokenDoBot()
    // Token vazio/ausente = "bot nao configurado" (contrato INSTALL.md
    // Passo 2/4): o portao HTTP funciona sem o bot. Nao ha worker, nem
    // supervisor, nem subprocesso, nem backoff -- so a linha de boot
    // documentada. O efeito continua registado (os 5 efeitos sao contrato de
    // ordem/LIFO) mas devolve um disposer no-op sincrono.
    if (tokenDoBot === undefined) {
      log.info(`bot nao configurado (provedor ${provider}) — rode /parear <código> no bot`)
      return (): void => undefined
    }
    // Item 5 (costura): /acessar (link magico) e /rotacionar (segredo novo,
    // sessoes invalidadas, nunca a senha pelo chat). Opcionais por forma —
    // ausentes, o responder volta ao INTERNAL fail-closed de antes.
    //
    // `linkToken` e a CHAVE NO LINK (onda 1): a Onda 2 (dona de
    // `src/control/surface-ipc.ts`) vai compor a URL `?key=<token>` do bot a
    // partir de `emitir()`. O deps object e construido numa VARIABLE alargada
    // (`RespondedorIpcDeps & { linkToken }`) para o campo chegar ao responder
    // sem estar ainda declarado no contrato dos deps — a adicao formal ao
    // contrato de `surface-ipc.ts` e da Onda 2.
    const depsRespondedor: Parameters<typeof criarRespondedorIpc>[0] & {
      linkToken?: LinkTokenSurface | undefined
    } = {
      controller: controladorAtual,
      modoTunel: config.tunnel !== undefined,
      pareado,
      audit: { append: (evento) => authStack().audit.append(evento) },
      log,
      agora: defaultSupervisorDeps.now,
      reemitirEstado,
      aposEmergencia,
      confirm: confirmService,
      magic: magicStoreAtual,
      // A ROTACAO do segredo revoga a chave no link alem de invalidar as
      // sessoes: `SecretStore.rotate` ja faz `revokeAll()` das sessoes; aqui
      // fecha tambem a porta do link. A ORDEM e contrato — sessoes e chave
      // caem ANTES de o novo digest ser publicado (o mesmo do rotate).
      // Por fim, `encerrarConexoesAtivas()` mata as conexoes JA ESTABELECIDAS
      // (WebSocket `101` e streams em voo) sob o acesso antigo: as credenciais
      // caem primeiro, logo um pedido em voo que falhe a autenticacao nao e o
      // unico motivo de o socket morrer — a ligacao ativa encerra de qualquer
      // forma (fail-closed). O listener do proxy NAO e derrubado (o tunel fica).
      secretos: {
        rotate: () => {
          const resultado = authStack().secrets.rotate()
          linkStoreAtual?.revogar()
          tunnelProxyAtual?.encerrarConexoesAtivas()
          return resultado
        },
      },
      notificarDono: difundirNotificacao,
      linkToken: linkStoreAtual,
    }
    const responder = criarRespondedorIpc(depsRespondedor)
    // EMENDA-COSTURA-5: o transporte do nonce (T5.2 fecha o /ligar ponta a
    // ponta). O worker pede `nonce.request` e o HOST responde `nonce.issued`
    // com o `ConfirmService` de T5.1; o nonce NUNCA e logado (S3) e viaja so
    // pelo pipe host <-> worker.
    const responderDeNonce = criarRespondedorDeNonce({ controller: controladorAtual, log })
    const supervisor = createWorkerSupervisor(ctx, config, defaultSupervisorDeps, {
      onIntent: responder,
      onNonceRequest: responderDeNonce,
      // O PAREAMENTO CONCLUIU NO WORKER (`/parear <codigo>` valido). O host:
      //   1) GRAVA o dono no state.json (mesma forma que o CLI — pairing.ownerUserId/ownerChatId/pairedAt);
      //   2) DEVOLVE `pairing.owner` (que fecha o handshake e liberta a allowlist
      //      no ato via auth.semearDono — sem esperar reinicio).
      // Se a gravacao falhar, NAO se devolve complemento: um dono que o host
      // nao persistiu nao autoriza nada a mais (fail-closed); o retorno e um
      // `error INTERNAL` que o worker nao renderiza como pareamento duplo.
      onPairingSuccess: (msg): IpcMessageToWorker => {
        try {
          const storePar = createStateStore({ paths: statePaths })
          try {
            storePar.store.update((estado) => ({
              ...estado,
              pairing: { ownerUserId: msg.from, ownerChatId: msg.chat, pairedAt: msg.pairedAt },
            }))
          } finally {
            storePar.dispose()
          }
        } catch (error) {
          log.error(
            `nao foi possivel gravar o dono pareado no state.json: ${error instanceof Error ? error.message : String(error)}`,
          )
          return {
            v: IPC_PROTOCOL_VERSION,
            type: 'error',
            code: 'INTERNAL',
            message: 'O pareamento nao foi gravado. Reinicie o plugin e tente de novo.',
          }
        }
        // A allowlist liberta no ato: sem esperar reinicio.
        try {
          authStack().audit.append({ evento: `pareamento_concluido:telegram:${String(msg.from)}`, resultado: 'permitido' })
        } catch (error) {
          void error
        }
        return {
          v: IPC_PROTOCOL_VERSION,
          type: 'pairing.owner',
          from: msg.from,
          chat: msg.chat,
          pairedAt: msg.pairedAt,
        }
      },
      // O token RESOLVIDO (config ou secrets.env) — o supervisor injeta-o no
      // env do filho. Sem o override, ele usaria so `config.worker.token` e um
      // token apenas em `secrets.env` nao ligaria o worker (o bug HIGH do botao).
      token: tokenDoBot,
      // O provedor ATIVO (default fechado `telegram`): o supervisor rotula o
      // filho com `DSH_GUARD_PROVIDER=<provider>` e escolhe o `tokenVar` de
      // destino — vindo da MESMA fonte que `resolverTokenDoBot`.
      provider,
    })
    workerSupervisor = supervisor
    supervisor.start()
    // 8(c): com dono persistido no state.json, o worker reaprende-o no
    // arranque (`pairing.owner`) — sem nova parelha; sem isso, o dono ficaria
    // trancado para fora apos um reboot. O nonce do boot NAO e o do par.
    if (pareamentoDoBoot !== undefined) {
      supervisor.send({
        v: IPC_PROTOCOL_VERSION,
        type: 'pairing.owner',
        from: pareamentoDoBoot.ownerUserId,
        chat: pareamentoDoBoot.ownerChatId,
        pairedAt: pareamentoDoBoot.pairedAt,
      })
    }
    return (): void => {
      supervisor.dispose()
    }
  }, 'dsh-guard.worker')
}
