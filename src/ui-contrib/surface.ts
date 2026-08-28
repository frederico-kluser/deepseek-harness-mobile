/**
 * A superficie de UI nativa do DSH — terceira superficie, ao lado do Telegram
 * (T5.2) e do painel `/__guard` (T5.3). 03-ONDAS 2.1 (desvio declarado): a
 * sub-tarefa condicional T5.5 "registra os mesmos dois botoes no ponto de
 * contribuicao do host CONSUMINDO o mesmo `ControlIntent` de T5.1 — nunca
 * chamando o supervisor direto".
 *
 * O MECANISMO e o `tapIndex` medido pelo spike S4
 * (`docs/spikes/superficie-ui.md` 4.1): um transform do `index.html` servido
 * pelo dono do assento de fallback, reversivel pelo disposer. O registro de
 * slot (mecanismo 4.2 do spike) ficaria condicionado a `package.json`
 * (`dsh.client` + `exports["./client"]`), que nesta onda nao tem dono — ver o
 * handoff.
 *
 * PROJECCAO: a superficie nao mantem estado proprio alem do ultimo `seq` que
 * viu (a mesma disciplina que `src/contracts/ipc.ts` impoe ao worker). A
 * fonte e o broadcast do controlador de T5.1, entregue por `deps.subscribe`;
 * difusoes fora de ordem (seq nao-crescente) sao DESCARTADAS, para o flapping
 * de tunel nao fazer a UI andar para tras.
 *
 * O QUE ESTE MODULO NAO FAZ, POR CONSTRUCAO:
 *   - nao importa `@deepseek-ai/*` (a fronteira com o DSH e so
 *     `src/dsh/adapter.ts`, D1) — os tipos do host ficam ESTRUTURAIS nos
 *     `deps` (tapIndex, registerRoute), satisfeitos por quem fia a superficie;
 *   - nao importa `src/tunnel/**` nem `src/control/**` — a unica via para o
 *     controlador e `deps.emit(ControlIntent)` (o mapa de importacoes do
 *     modulo e a prova, ver `test/unit/ui-contrib/surface.test.ts`);
 *   - nao valida nonce (S5): quem emite e quem valida e o HOST
 *     (`deps.issueNonce` / `deps.emit`); a superficie transporta o valor opaco
 *     entre o passo 1 e o passo 2 do LIGAR.
 *
 * A COSTURA (pos-onda) liga os deps em `src/index.ts` — ver o handoff: o que
 * este modulo exige do contexto do host e `ctx.webServer.tapIndex` e
 * `ctx.webServer.register` (ambos ja expostos por `src/dsh/adapter.ts`), o
 * despacho de T5.1 (`emit`), o `ConfirmService` de T5.1 (`issueNonce`) e o
 * broadcast do controlador (`subscribe`).
 */

import type { ControlAction, ControlIntent, ControlResultado, Nonce } from '../contracts/control.ts'
import type { TunnelSnapshot } from '../contracts/tunnel.ts'
import { createCsrfGuard, type CsrfGuard } from './csrf.ts'
import { createIndexTap } from './html.ts'
import {
  createAccessHandler,
  createAgentsCancelHandler,
  createAgentsHandler,
  createClientHandler,
  createConfirmHandler,
  createCsrfHandler,
  createPrivacidadeHandler,
  createPairHandler,
  createPairStateHandler,
  createResetConfirmHandler,
  createResetHandler,
  createStartHandler,
  createStateHandler,
  createStopHandler,
  createTelegramClickHandler,
  createTelegramHandler,
  createTokenHandler,
  createTokenStateHandler,
  UI_CSRF_BINDING,
  UI_PATH_ACCESS,
  UI_PATH_AGENTS,
  UI_PATH_CLIENT,
  UI_PATH_CONFIRM,
  UI_PATH_CSRF,
  UI_PATH_PRIVACIDADE,
  UI_PATH_PAIR,
  UI_PATH_PAIR_STATE,
  UI_PATH_RESET,
  UI_PATH_RESET_CONFIRM,
  UI_PATH_START,
  UI_PATH_STATE,
  UI_PATH_STOP,
  UI_PATH_TELEGRAM,
  UI_PATH_TELEGRAM_CLICK,
  UI_PATH_TOKEN,
  UI_PATH_TOKEN_STATE,
  type UiAcessoBruto,
  type UiAgentOps,
  type UiContribCore,
  type UiContribRoute,
  type ProviderDoBot,
  type UiPairOps,
  type UiTokenOps,
} from './routes.ts'
import type { BotEstado } from './bot-state.ts'
import { createUlidFactory } from './ulid.ts'

/** A difusao de estado que esta superficie consome. */
export interface UiContribBroadcast {
  /** Monotonico; nao-crescente = fora de ordem, descartada. */
  readonly seq: number
  readonly snapshot: TunnelSnapshot
}

/**
 * Tudo o que a superficie precisa, injetado. A costura em `src/index.ts`
 * liga cada campo ao contexto real do host:
 *
 *   - `tapIndex`     <- `ctx.webServer.tapIndex` (via `src/dsh/adapter.ts`)
 *   - `registerRoute`<- `ctx.webServer.register` (idem; as rotas desta
 *                       superficie nascem ATRAS da barreira de autenticacao,
 *                       sem isencao nenhuma — `unauthenticatedPrefixes` nao
 *                       as nomeia e nao precisa de nomear)
 *   - `emit`         <- o despacho de intents de T5.1 (controlador)
 *   - `issueNonce`   <- `ConfirmService.issue` de T5.1 (`src/control/confirm.ts`)
 *   - `subscribe`    <- o broadcast de T5.1; a costura DEVE invocar o
 *                       listener imediatamente com o estado corrente
 *                       ({ seq, snapshot }) e depois em cada difusao
 *   - `now`          <- relogio injetado (nunca `Date.now` direto)
 *   - `requestedBy`  <- origem pre-formatada do audit; default `ui:native`
 */
export interface UiContribDeps {
  readonly tapIndex: (transform: (html: string) => string) => () => void
  readonly registerRoute: (route: UiContribRoute) => () => void
  readonly emit: (intent: ControlIntent) => Promise<ControlResultado>
  readonly issueNonce: (action: ControlAction) => Nonce
  readonly subscribe: (listener: (broadcast: UiContribBroadcast) => void) => () => void
  readonly now: () => number
  /**
   * O estado do BOT OFFLINE/ONLINE, lido do disco pela costura em
   * `src/index.ts`. A superficie so o reencaminha; nao guarda estado proprio
   * para o bot (cada pedido le o disco de novo — o pareamento muda pela
   * CLI/worker, nao por esta superficie).
   */
  readonly botState: () => BotEstado
  /**
   * O PROVEDOR de mensageria ATIVO, fiado pela costura em `src/index.ts`
   * (`config.worker.provider ?? DEFAULT_PROVIDER`) — a MESMA escolha que o
   * worker faz ao ler `DSH_GUARD_PROVIDER`. O GET /telegram emite-o no corpo
   * para o painel rotular o onboarding por provedor.
   */
  readonly provider: ProviderDoBot
  readonly requestedBy?: string
  /**
   * O servico de configuracao do token, fiado pela costura em `src/index.ts`
   * (detem `config`, `statePaths` e o supervisor do worker). NUNCA sai daqui
   * para a UI o valor do token.
   */
  readonly tokenOps: UiTokenOps
  /**
   * O servico de pareamento VIA PAINEL, fiado pela costura em `src/index.ts`
   * (detem `config`, `statePaths`, a sessao de pareamento em memoria e o
   * supervisor do worker). O CODIGO NUNCA sai daqui para a UI via log — so na
   * resposta a `gerar()`.
   */
  readonly pairOps: UiPairOps
  /**
   * A projecao de acesso, fiada pela costura: contage de sockets ativos do
   * proxy + sessoes vivas com os metadados de acesso.
   */
  readonly acesso: () => UiAcessoBruto
  /**
   * O servico de AGENTES (o dispatcher da Onda 4), fiado pela costura em
   * `src/index.ts`. A fonte e o REGISTRY do HOST em memoria (a MESMA do
   * `agent.report`) — a superficie so lista e cancela; o `cancelar` reduz
   * exposicao e por isso dispensa nonce (so CSRF).
   */
  readonly agentsOps: UiAgentOps
}

/** A origem que o audit log escreve para esta superficie (03-ONDAS 10, item 7). */
export const UI_REQUESTED_BY = 'ui:native'

/**
 * Monta a superficie: tap + as rotas (incl. o GET /api/csrf de HIGH-2) +
 * assinatura do broadcast, e devolve o disposer que reverte TUDO (tap
 * reversivel — a propriedade que o spike S4 mediu; rotas removidas; assinatura
 * cancelada). Disposer SINCRONO e idempotente (LIFE-003/005).
 */
export function createNativeUiSurface(deps: UiContribDeps): () => void {
  let lastSeq = -1
  let lastSnapshot: TunnelSnapshot | undefined
  let lastReady: { readonly expiresAt: number } | undefined

  const ouvir = (broadcast: UiContribBroadcast): void => {
    if (broadcast.seq <= lastSeq) return // fora de ordem: descartada
    lastSeq = broadcast.seq
    lastSnapshot = broadcast.snapshot
    if (broadcast.snapshot.state === 'READY' && broadcast.snapshot.expiresAt !== undefined) {
      lastReady = { expiresAt: broadcast.snapshot.expiresAt }
    }
  }

  const unsub = deps.subscribe(ouvir)

  const csrf: CsrfGuard = createCsrfGuard({ clock: { now: deps.now } })
  const requestId = createUlidFactory(deps.now)
  const requestedBy = deps.requestedBy ?? UI_REQUESTED_BY

  const core: UiContribCore = {
    projection: () => lastSnapshot,
    seq: () => lastSeq,
    lastReady: () => lastReady,
    botState: deps.botState,
    provider: deps.provider,
    tokenOps: deps.tokenOps,
    pairOps: deps.pairOps,
    acesso: deps.acesso,
    agentsOps: deps.agentsOps,
    csrf,
    now: deps.now,
    requestedBy,
    requestId,
    issueNonce: deps.issueNonce,
    emit: deps.emit,
  }

  const rotas: readonly UiContribRoute[] = [
    { kind: 'exact', path: UI_PATH_STATE, handler: createStateHandler(core) },
    { kind: 'exact', path: UI_PATH_START, handler: createStartHandler(core) },
    { kind: 'exact', path: UI_PATH_CONFIRM, handler: createConfirmHandler(core) },
    { kind: 'exact', path: UI_PATH_STOP, handler: createStopHandler(core) },
    // W3 (revisao T5.5): FAILED so sai por reset humano (CTL-012) — a
    // terceira superficie ganha o MESMO padrao de 2 etapas com nonce.
    { kind: 'exact', path: UI_PATH_RESET, handler: createResetHandler(core) },
    { kind: 'exact', path: UI_PATH_RESET_CONFIRM, handler: createResetConfirmHandler(core) },
    { kind: 'exact', path: UI_PATH_CLIENT, handler: createClientHandler(core) },
    // O botao Telegram: estado (GET) e clique (POST com CSRF).
    { kind: 'exact', path: UI_PATH_TELEGRAM, handler: createTelegramHandler(core) },
    { kind: 'exact', path: UI_PATH_TELEGRAM_CLICK, handler: createTelegramClickHandler(core) },
    // O painel de configuracao do token (POST com CSRF) e o estado sem valor.
    { kind: 'exact', path: UI_PATH_TOKEN, handler: createTokenHandler(core) },
    { kind: 'exact', path: UI_PATH_TOKEN_STATE, handler: createTokenStateHandler(core) },
    // A privacidade AO VIVO do bot (GET): getMe real decide se ha @username.
    { kind: 'exact', path: UI_PATH_PRIVACIDADE, handler: createPrivacidadeHandler(core) },
    // O pareamento VIA PAINEL: gerar codigo (POST com CSRF) + estado (GET).
    { kind: 'exact', path: UI_PATH_PAIR, handler: createPairHandler(core) },
    { kind: 'exact', path: UI_PATH_PAIR_STATE, handler: createPairStateHandler(core) },
    // As metricas de acesso (GET, so leitura).
    { kind: 'exact', path: UI_PATH_ACCESS, handler: createAccessHandler(core) },
    // Os AGENTES (Onda 6): a lista (GET, exact) e o cancelamento (POST com
    // CSRF — PREFIXO no MESMO caminho: o id curto do run vive no segmento, e
    // o despacho do host so consulta prefixos depois de falhar a tabela
    // exact, logo o GET da lista nunca cai no cancelamento).
    { kind: 'exact', path: UI_PATH_AGENTS, handler: createAgentsHandler(core) },
    { kind: 'prefix', path: UI_PATH_AGENTS, handler: createAgentsCancelHandler(core) },
    // O token anti-CSRF fresco para o bundle (HIGH-2) — GET, so le. Sempre
    // registado: e o que o bundle novo usa em cada POST por fora do meta antigo.
    { kind: 'exact', path: UI_PATH_CSRF, handler: createCsrfHandler(core) },
  ]

  const rotaDisposers: Array<() => void> = []
  let tapDisposer: (() => void) | undefined
  try {
    tapDisposer = deps.tapIndex(createIndexTap({ csrf, binding: UI_CSRF_BINDING, scriptSrc: UI_PATH_CLIENT }))
    for (const rota of rotas) rotaDisposers.push(deps.registerRoute(rota))
  } catch (error) {
    // Registo parcial (ex.: colisao de rota): reverte o que ja entrou, em
    // LIFO, antes de propagar — nunca deixar meia contribuicao no host.
    for (let i = rotaDisposers.length - 1; i >= 0; i -= 1) {
      const disposer = rotaDisposers[i]
      if (disposer !== undefined) disposer()
    }
    tapDisposer?.()
    unsub()
    throw error
  }

  let desmontado = false
  return (): void => {
    if (desmontado) return // idempotente (LIFE-003)
    desmontado = true
    for (let i = rotaDisposers.length - 1; i >= 0; i -= 1) {
      const disposer = rotaDisposers[i]
      if (disposer !== undefined) disposer()
    }
    tapDisposer?.()
    unsub()
  }
}

/** Tipos fiados da superficie para a costura (que os injeta nos deps). */
export type {
  EstadoDoToken,
  FonteDoToken,
  RegistroAcessoBruto,
  UiAcessoBruto,
  UiAgentOps,
  UiPrivacidade,
  UiPairOps,
  UiTokenOps,
} from './routes.ts'
